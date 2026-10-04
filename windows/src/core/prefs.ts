// Preferences that grew after the original settings: modes, appearance,
// per-event sounds, automations, memory switches, startup.
//
// They travel inside Settings.prefs (an opaque JSON value to Rust), so both
// windows read and write them through the same save path as every other
// preference. `readPrefs` is the only way in: whatever is on disk — missing,
// from an older build, hand-edited — comes out complete and valid.
//
// Nothing secret ever goes here. Webhook addresses live in the OS vault
// (webhook-1..3); this file only remembers what each slot is called.

import type { SoundName } from "./sound";
import type { Settings } from "./state";
import { applyStyle, STYLE_SPACE, validSpec, type StyleSpec } from "./styles";

// ── Modes ─────────────────────────────────────────────────────────────────────

export type Mode = "normal" | "focus" | "silent" | "presentation" | "night";

export interface ModeInfo {
  title: string;
  desc: string;
  /** Sound categories still allowed (null = whatever the per-event switches say). */
  sounds: SoundCategory[] | null;
  /** Integration and background flashes in the compact island. */
  flashes: boolean;
  /** Finished / error cards open the island on their own. */
  autoOpen: boolean;
}

/**
 * Permission requests are deliberately absent from every row below: whatever
 * the mode, a request always opens its card. Hiding one would leave Claude
 * Code waiting on a question nobody can see.
 */
export const MODES: Record<Mode, ModeInfo> = {
  normal: {
    title: "Normal",
    desc: "Everything on: sounds, flashes, and the island opens when a session finishes or fails.",
    sounds: null,
    flashes: true,
    autoOpen: true,
  },
  focus: {
    title: "Focus",
    desc: "Only what needs you. Sounds for permission requests and errors; finished sessions wait as a badge instead of opening the island.",
    sounds: ["permission", "error"],
    flashes: false,
    autoOpen: false,
  },
  silent: {
    title: "Silent",
    desc: "No sounds at all. Everything else works as usual.",
    sounds: [],
    flashes: true,
    autoOpen: true,
  },
  presentation: {
    title: "Presentation",
    desc: "For screen sharing and demos: no sounds, no flashes, nothing opens by itself. Permission requests still appear — Claude Code can't continue without them.",
    sounds: [],
    flashes: false,
    autoOpen: false,
  },
  night: {
    title: "Night",
    desc: "Dimmer light, softer motion, quieter sounds (half volume).",
    sounds: null,
    flashes: true,
    autoOpen: true,
  },
};

export const MODE_ORDER: Mode[] = ["normal", "focus", "silent", "presentation", "night"];

// ── Sounds per event ──────────────────────────────────────────────────────────

export type SoundCategory = "permission" | "question" | "finish" | "error" | "session" | "chat" | "interaction";

export const SOUND_CATEGORIES: { id: SoundCategory; title: string; desc: string; sample: SoundName }[] = [
  { id: "permission", title: "Permission requests", desc: "A request arrives, and when you answer it.", sample: "approval" },
  { id: "question", title: "Questions", desc: "Claude is asking something in the terminal.", sample: "question" },
  { id: "finish", title: "Finished", desc: "A session or workflow completes.", sample: "finish" },
  { id: "error", title: "Errors and rate limits", desc: "Something stopped, or Claude is being throttled.", sample: "error" },
  { id: "session", title: "Session activity", desc: "A session starts working.", sample: "work" },
  { id: "chat", title: "Chat", desc: "Sending, thinking, attaching.", sample: "send" },
  { id: "interaction", title: "Mochi and the island", desc: "Peeks, clicks, pokes and Mochi's moods.", sample: "peek" },
];

const SOUND_CATEGORY: Record<string, SoundCategory> = {
  approval: "permission",
  approve: "permission",
  question: "question",
  finish: "finish",
  proud: "finish",
  error: "error",
  rate: "error",
  work: "session",
  send: "chat",
  think: "chat",
  search: "chat",
  attach: "chat",
  gulp: "chat",
};

export function soundCategory(name: string): SoundCategory {
  return SOUND_CATEGORY[name] ?? "interaction";
}

// ── Appearance ────────────────────────────────────────────────────────────────

export type CoreStyle = "orbit" | "pulse" | "minimal";
/** "system" follows the OS setting; "reduced" calms Coucou even when the OS doesn't ask. */
export type MotionPref = "system" | "reduced";

export interface Appearance {
  /** Glass opacity, 0.6–1.4 × the design default. */
  glass: number;
  /** Glow strength, 0–1.5 × the design default. */
  glow: number;
  particles: boolean;
  motion: MotionPref;
  core: CoreStyle;
}

// ── Automations ───────────────────────────────────────────────────────────────

export type TriggerId =
  | "session-finished"
  | "session-failed"
  | "permission-requested"
  | "question-asked"
  | "tool-failed"
  | "command-failed"
  | "tests-failed"
  | "build-failed"
  | "deploy-command-succeeded"
  | "integration-success"
  | "integration-failure"
  | "chat-replied";

export const TRIGGERS: { id: TriggerId; title: string; desc: string }[] = [
  { id: "session-finished", title: "Claude Code finishes", desc: "The Stop hook fires." },
  { id: "session-failed", title: "Claude Code stops on an error", desc: "The StopFailure hook fires." },
  { id: "permission-requested", title: "A permission request arrives", desc: "Before you answer it. Automations never answer it for you." },
  { id: "question-asked", title: "Claude asks a question", desc: "A Notification ending with a question mark." },
  { id: "tool-failed", title: "Any tool call fails", desc: "PostToolUseFailure." },
  { id: "command-failed", title: "A shell command fails", desc: "Bash / PowerShell ended in failure." },
  { id: "tests-failed", title: "Tests fail", desc: "A test command (npm test, cargo test, pytest…) ended in failure." },
  { id: "build-failed", title: "A build fails", desc: "A build command (npm run build, cargo build, tsc…) ended in failure." },
  { id: "deploy-command-succeeded", title: "A deploy command succeeds", desc: "vercel --prod, npm publish, fly deploy… finished without failing." },
  { id: "integration-success", title: "An integration reports success", desc: "Vercel deployment ready, workflow succeeded, payment…" },
  { id: "integration-failure", title: "An integration reports a failure", desc: "A deployment or workflow failed." },
  { id: "chat-replied", title: "Claude replies in the chat", desc: "Useful while the island is collapsed." },
];

export type ActionSpec =
  | { type: "flash" }
  | { type: "open" }
  | { type: "sound"; sound: SoundName }
  | { type: "webhook"; slot: WebhookSlot; details: boolean }
  | { type: "summarize" };

export const ACTION_TITLES: Record<ActionSpec["type"], string> = {
  flash: "Show it in the compact island",
  open: "Open the island",
  sound: "Play a sound",
  webhook: "Send to a webhook",
  summarize: "Ask Claude for a summary",
};

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: TriggerId;
  /** Only when the project folder name contains this (case-insensitive). */
  projectContains: string;
  actions: ActionSpec[];
}

export type WebhookSlot = "webhook-1" | "webhook-2" | "webhook-3";
export const WEBHOOK_SLOTS: WebhookSlot[] = ["webhook-1", "webhook-2", "webhook-3"];

export interface WebhookMeta {
  slot: WebhookSlot;
  label: string;
  kind: "ntfy" | "discord" | "slack" | "json";
}

// ── The whole thing ───────────────────────────────────────────────────────────

export interface Prefs {
  v: 1;
  mode: Mode;
  appearance: Appearance;
  sounds: Record<SoundCategory, boolean>;
  automations: AutomationRule[];
  webhooks: WebhookMeta[];
  memory: {
    /** Off until the user turns it on. Nothing is kept while off. */
    enabled: boolean;
    /** Offer saved notes to the chat (first message of a conversation). */
    useInChat: boolean;
  };
  startup: { cinematic: boolean };
  /**
   * The chosen style (core/styles.ts), or null for Coucou's own look.
   * Favourites are indices in the full style space.
   */
  style: { spec: StyleSpec | null; favorites: number[] };
  /** Seconds of quiet before the energy core goes dormant. */
  dormantAfter: number;
}

export const DEFAULT_PREFS: Prefs = {
  v: 1,
  mode: "normal",
  appearance: { glass: 1, glow: 1, particles: true, motion: "system", core: "orbit" },
  sounds: {
    permission: true, question: true, finish: true, error: true,
    session: true, chat: true, interaction: true,
  },
  automations: [],
  webhooks: WEBHOOK_SLOTS.map((slot, i) => ({ slot, label: `Webhook ${i + 1}`, kind: "ntfy" as const })),
  memory: { enabled: false, useInChat: false },
  startup: { cinematic: true },
  style: { spec: null, favorites: [] },
  dormantAfter: 120,
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v != null && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T =>
  typeof v === "string" && (all as readonly string[]).includes(v) ? (v as T) : d;
const str = (v: unknown, max: number, d = "") => (typeof v === "string" ? v.slice(0, max) : d);

const TRIGGER_IDS = TRIGGERS.map((t) => t.id);
const SOUND_IDS = SOUND_CATEGORIES.map((c) => c.id);

function readAction(v: unknown): ActionSpec | null {
  if (!isObj(v)) return null;
  switch (v.type) {
    case "flash":
    case "open":
    case "summarize":
      return { type: v.type };
    case "sound":
      return { type: "sound", sound: str(v.sound, 20, "blip") as SoundName };
    case "webhook":
      return { type: "webhook", slot: oneOf(v.slot, WEBHOOK_SLOTS, "webhook-1"), details: bool(v.details, false) };
    default:
      return null;
  }
}

function readRule(v: unknown): AutomationRule | null {
  if (!isObj(v)) return null;
  const actions = Array.isArray(v.actions) ? v.actions.map(readAction).filter((a): a is ActionSpec => a != null) : [];
  return {
    id: str(v.id, 40) || Math.random().toString(36).slice(2, 10),
    name: str(v.name, 60, "Automation") || "Automation",
    enabled: bool(v.enabled, true),
    trigger: oneOf(v.trigger, TRIGGER_IDS, "session-finished"),
    projectContains: str(v.projectContains, 80),
    actions: actions.slice(0, 6),
  };
}

/** Always returns a complete, valid Prefs, whatever was stored. */
export function readPrefs(raw: unknown): Prefs {
  const d = DEFAULT_PREFS;
  if (!isObj(raw)) return structuredClone(d);
  const a = isObj(raw.appearance) ? raw.appearance : {};
  const s = isObj(raw.sounds) ? raw.sounds : {};
  const m = isObj(raw.memory) ? raw.memory : {};
  const st = isObj(raw.startup) ? raw.startup : {};
  const sty = isObj(raw.style) ? raw.style : {};
  const hooks = Array.isArray(raw.webhooks) ? raw.webhooks : [];
  return {
    v: 1,
    mode: oneOf(raw.mode, MODE_ORDER, d.mode),
    appearance: {
      glass: num(a.glass, 0.6, 1.4, d.appearance.glass),
      glow: num(a.glow, 0, 1.5, d.appearance.glow),
      particles: bool(a.particles, d.appearance.particles),
      motion: oneOf(a.motion, ["system", "reduced"] as const, d.appearance.motion),
      core: oneOf(a.core, ["orbit", "pulse", "minimal"] as const, d.appearance.core),
    },
    sounds: Object.fromEntries(SOUND_IDS.map((id) => [id, bool(s[id], true)])) as Prefs["sounds"],
    automations: Array.isArray(raw.automations)
      ? raw.automations.map(readRule).filter((r): r is AutomationRule => r != null).slice(0, 24)
      : [],
    webhooks: WEBHOOK_SLOTS.map((slot, i) => {
      const found = hooks.find((x) => isObj(x) && x.slot === slot) as Record<string, unknown> | undefined;
      return {
        slot,
        label: str(found?.label, 40, `Webhook ${i + 1}`) || `Webhook ${i + 1}`,
        kind: oneOf(found?.kind, ["ntfy", "discord", "slack", "json"] as const, "ntfy"),
      };
    }),
    memory: { enabled: bool(m.enabled, false), useInChat: bool(m.useInChat, false) },
    startup: { cinematic: bool(st.cinematic, true) },
    style: {
      spec: validSpec(sty.spec),
      favorites: Array.isArray(sty.favorites)
        ? [...new Set(sty.favorites.filter((x): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < STYLE_SPACE))].slice(0, 100)
        : [],
    },
    dormantAfter: num(raw.dormantAfter, 30, 3600, d.dormantAfter),
  };
}

export function prefsOf(settings: Settings): Prefs {
  return readPrefs(settings.prefs);
}

/** Should this sound play under the current mode and per-event switches? */
export function soundAllowed(prefs: Prefs, name: string): boolean {
  const cat = soundCategory(name);
  if (!prefs.sounds[cat]) return false;
  const allowed = MODES[prefs.mode].sounds;
  return allowed == null || allowed.includes(cat);
}

/**
 * Applies appearance and mode to a document: CSS variables and classes only,
 * so it costs nothing per frame. Used by both windows.
 */
export function applyAppearance(prefs: Prefs, doc: Document = document) {
  applyStyle(prefs.style.spec, doc);
  const root = doc.documentElement;
  const night = prefs.mode === "night";
  root.style.setProperty("--pref-glass", String(prefs.appearance.glass));
  root.style.setProperty("--pref-glow", String(prefs.appearance.glow * (night ? 0.55 : 1)));
  root.dataset.mode = prefs.mode;
  root.dataset.core = prefs.appearance.core;
  root.classList.toggle("no-particles", !prefs.appearance.particles);
  root.classList.toggle("reduce-motion", prefs.appearance.motion === "reduced" || night);
}

export function newRuleId(): string {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
