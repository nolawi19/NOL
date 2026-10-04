# Coucou devices — pairing, connection and handoff

Status: **desktop side architecture-ready; Coucou Mobile does not exist yet.**
Nothing in the app shows a phone as connected. This document is the contract
both sides implement; the desktop types live in
`windows/src/core/devices.ts`.

## What exists today (desktop)

- **Device identity.** On first use the desktop generates an ECDSA P-256 key
  pair with WebCrypto. The private key is created non-extractable — no code can
  read it out — and stored with the identity (`id`, `name`, `platform`,
  SHA-256 fingerprint of the SPKI public key) in IndexedDB.
- **Signing** with that key (`signWithDevice`), used by handoff envelopes.
- **Pairing offers** (`createPairingOffer`): one-time 128-bit secret,
  fingerprint, rendezvous, 2-minute expiry. Not shown in the UI until an app
  can read it.
- **Paired-device list and revocation** (`pairedDevices`, `revokeDevice`).

## What Coucou Mobile must implement

### 1. Pairing

1. Desktop shows a QR code encoding a `PairingOffer`
   (`{v, device, fingerprint, secret, rendezvous, expiresAt}`).
2. The phone scans it, refuses it if `expiresAt` has passed, generates its own
   P-256 identity, and connects to `rendezvous` (LAN address, or a relay room).
3. Both run an authenticated key exchange: ECDH (P-256) with ephemeral keys,
   transcript signed by each device key, the `secret` mixed in as a pre-shared
   key. A wrong secret → `rejected: bad-secret`.
4. Both screens show the same 6-digit code derived from the transcript hash;
   the user confirms on the desktop. Mismatch or decline → `rejected`.
5. Each side stores the other's identity and fingerprint. A device presenting
   a known id with a different key → `rejected: fingerprint-mismatch`.

States: `idle → offering → confirming → paired`, with `expired`, `rejected`,
`failed`.

### 2. Connection

- Transport preference: same-network WebSocket over TLS with pinned
  fingerprints → WebRTC data channel (DTLS) via a relay for signalling → relay
  WebSocket as a last resort. Content is end-to-end encrypted with the session
  keys from pairing in every case; a relay only sees ciphertext.
- Heartbeat every 15 s (`HEARTBEAT_MS`); three missed → `reconnecting` with
  backoff `min(30 s, 0.5 s × 2^attempt)`.
- Every message carries `id` and a per-sender `seq`; receivers drop anything
  already seen (duplicate-event protection) and request gaps.
- Offline: queue nothing sensitive. Permission requests are never answered from
  a stale connection — the desktop declines them and Claude Code asks in the
  terminal.

### 3. Permissions a phone can hold

`view-activity`, `approve-permissions`, `chat`, `handoff` — granted at pairing,
revocable from Settings → Devices at any time. Approving a Claude Code
permission from a phone follows the same rule as the island: an explicit tap,
never automatic.

### 4. Handoff

A `HandoffEnvelope` carries `session.conversation`, `session.task`
(`project`, `phase`, `lastStep`), `session.state`, `sessionId`, `model`, both
device ids, `sentAt`, `seq`, and an ECDSA signature over the canonical JSON.
Files stay on the computer and are referenced by name.

States: `idle → packing → sending → waiting-ack → done`, or
`failed: no-device | offline | rejected | timeout | error`. The receiver
acknowledges by envelope id; duplicates are acknowledged again but applied once.

## Why there is no relay yet

Off-network pairing and handoff need a rendezvous/relay service. Coucou runs no
servers and sends no telemetry, so this waits on a decision about who would run
one (self-hosted, or a minimal stateless relay that only forwards ciphertext).
