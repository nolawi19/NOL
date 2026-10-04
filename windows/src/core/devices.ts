// Devices: this computer's identity, and the protocol a phone will speak.
//
// What is real today:
//   · This computer has a device identity — an ECDSA P-256 key pair made by
//     WebCrypto. The private key is non-extractable: it can sign, but no code
//     (ours included) can read it out. It lives in IndexedDB for this app.
//   · The list of paired devices, and revoking one.
//
// What is architecture only (see docs/DEVICES.md): pairing, the encrypted
// channel, heartbeat / reconnect and session handoff need Coucou Mobile on the
// other end. The types and state machines below are what both sides will
// implement; nothing here pretends a phone is connected.

const DB_NAME = "coucou-devices";
const DB_VERSION = 1;
const STORE = "kv";

export interface DeviceIdentity {
  id: string;
  name: string;
  platform: "windows" | "linux" | "macos" | "android" | "ios";
  /** SHA-256 of the SPKI public key, hex. What a pairing screen compares. */
  fingerprint: string;
  publicKeySpki: string;
  createdAt: number;
}

export interface PairedDevice {
  identity: DeviceIdentity;
  pairedAt: number;
  lastSeen: number | null;
  /** What this device is allowed to do on this computer. */
  permissions: ("view-activity" | "approve-permissions" | "chat" | "handoff")[];
}

// ── Pairing protocol ─────────────────────────────────────────────────────────

/** Shown by the computer (QR code), read by the phone. Expires quickly. */
export interface PairingOffer {
  v: 1;
  /** Device id of the computer. */
  device: string;
  fingerprint: string;
  /** One-time secret, base64url, 128 bits. Proves the phone saw the screen. */
  secret: string;
  /** Where the phone can reach the computer (LAN address) or a relay rendezvous id. */
  rendezvous: string;
  expiresAt: number;
}

export type PairingState =
  | { step: "idle" }
  | { step: "offering"; offer: PairingOffer }
  | { step: "confirming"; peer: DeviceIdentity; code: string } // both screens show the same 6-digit code
  | { step: "paired"; peer: PairedDevice }
  | { step: "expired" }
  | { step: "rejected"; reason: "user" | "bad-secret" | "fingerprint-mismatch" | "unauthorized" }
  | { step: "failed"; reason: string };

export const PAIRING_TTL_MS = 2 * 60 * 1000;

// ── Connection ───────────────────────────────────────────────────────────────

export type ConnectionState =
  | { status: "offline" }
  | { status: "connecting"; attempt: number }
  | { status: "online"; via: "lan" | "relay" | "webrtc"; rttMs: number | null }
  | { status: "reconnecting"; attempt: number; nextInMs: number }
  | { status: "failed"; reason: string };

/** Heartbeat every 15 s; three missed → reconnecting with capped backoff. */
export const HEARTBEAT_MS = 15_000;
export const MISSED_BEATS = 3;
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
}

// ── Session handoff ──────────────────────────────────────────────────────────

/**
 * Everything a session needs to continue on another device. Signed by the
 * sender's device key; `seq` + `id` make duplicate deliveries harmless.
 */
export interface HandoffEnvelope {
  v: 1;
  id: string;
  seq: number;
  from: string;
  to: string;
  sentAt: number;
  session: {
    sessionId: string;
    kind: "chat" | "claude-code-watch";
    model: string | null;
    /** Chat turns (text only — files stay on the computer, referenced by name). */
    conversation: { role: "user" | "assistant"; content: string }[];
    task: { project: string | null; phase: string | null; lastStep: string | null };
    state: string;
  };
  /** ECDSA P-256 / SHA-256 over the canonical JSON of everything above. */
  signature: string;
}

export type HandoffState =
  | { step: "idle" }
  | { step: "packing" }
  | { step: "sending"; to: string }
  | { step: "waiting-ack"; to: string; envelope: string }
  | { step: "done"; to: string }
  | { step: "failed"; reason: "no-device" | "offline" | "rejected" | "timeout" | "error" };

// ── Storage ──────────────────────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const toHex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

const toB64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));

function platformName(): DeviceIdentity["platform"] {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "macos";
  return "linux";
}

// ── This computer ────────────────────────────────────────────────────────────

let identityPromise: Promise<DeviceIdentity> | null = null;

/** This computer's identity, created on first use and kept from then on. */
export function thisDevice(): Promise<DeviceIdentity> {
  identityPromise ??= (async () => {
    const existing = await kvGet<DeviceIdentity>("identity");
    const key = await kvGet<CryptoKeyPair>("keypair");
    if (existing && key) return existing;

    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false, // the private key can never be exported
      ["sign", "verify"],
    );
    const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
    const digest = await crypto.subtle.digest("SHA-256", spki);
    const platform = platformName();
    const identity: DeviceIdentity = {
      id: crypto.randomUUID(),
      name: platform === "windows" ? "This PC" : "This computer",
      platform,
      fingerprint: toHex(digest),
      publicKeySpki: toB64(spki),
      createdAt: Date.now(),
    };
    await kvSet("keypair", pair);
    await kvSet("identity", identity);
    return identity;
  })();
  identityPromise.catch(() => (identityPromise = null));
  return identityPromise;
}

/** "3F2A 9C11 · 7B04 E5D8" — the part people compare by eye. */
export function shortFingerprint(hex: string): string {
  const g = hex.slice(0, 16).toUpperCase().match(/.{4}/g) ?? [];
  return `${g.slice(0, 2).join(" ")} · ${g.slice(2, 4).join(" ")}`;
}

/** Signs bytes with this computer's key — what handoff envelopes will carry. */
export async function signWithDevice(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const pair = await kvGet<CryptoKeyPair>("keypair");
  if (!pair) throw new Error("No device key yet.");
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data);
  return toB64(sig);
}

/**
 * A pairing offer for the computer to display. Real and short-lived, but with
 * no app to read it yet the UI does not show it (see Settings → Devices).
 */
export async function createPairingOffer(rendezvous: string): Promise<PairingOffer> {
  const me = await thisDevice();
  const secret = new Uint8Array(16);
  crypto.getRandomValues(secret);
  return {
    v: 1,
    device: me.id,
    fingerprint: me.fingerprint,
    secret: toB64(secret.buffer).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    rendezvous,
    expiresAt: Date.now() + PAIRING_TTL_MS,
  };
}

// ── Paired devices ───────────────────────────────────────────────────────────

export async function pairedDevices(): Promise<PairedDevice[]> {
  return (await kvGet<PairedDevice[]>("paired")) ?? [];
}

/** Forgets a device: it can no longer reconnect without pairing again. */
export async function revokeDevice(id: string): Promise<void> {
  const list = await pairedDevices();
  await kvSet("paired", list.filter((d) => d.identity.id !== id));
}
