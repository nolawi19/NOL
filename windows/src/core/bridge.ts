// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./state";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[coucou] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  hookPath: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  /** "Open terminal" → opens the folder in VS Code when `code` is on PATH. */
  openInVSCode: (path: string | null) => call<boolean>("open_in_vscode", { path }),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),

  /** Writes to %LOCALAPPDATA%\Coucou\coucou.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  hooksStatus: () => call<HookStatus>("hooks_status"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean) => callOrThrow<HookPreview>("hooks_preview", { install }),
  /**
   * Writes ~/.claude/settings.json — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint }),

  /**
   * True when the decision reached a relay still waiting for it; false when the
   * request had already timed out (Claude Code asked in the terminal). Null
   * when Rust could not be reached.
   */
  approvalDecision: (requestId: string, decision: "allow" | "deny") =>
    call<boolean>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /** One chat turn. The API key and any file bytes never leave Rust. */
  chatSend: (query: string, context: ChatContext | null) =>
    callOrThrow<{ text: string }>("chat_send", { query, context }),
  chatReset: () => call<void>("chat_reset"),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  /** Asks Rust to try the stored key against the Models API. Status only. */
  claudeCheckKey: () => call<KeyCheck>("claude_check_key"),
  /** Saves screenshot bytes (JPEG/PNG) into the inbox, as raw IPC — no JSON. */
  ingestScreenshot: (bytes: Uint8Array) => callRawOrThrow<DroppedFile>("ingest_screenshot", bytes),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Awareness, automations, insights ──────────────────────────────────────
  /** CPU, memory, uptime and battery as the OS reports them. Asked for, never pushed. */
  systemStats: () => call<SystemStats>("system_stats"),
  /** Branch and project markers for a folder. Reads only .git/HEAD. */
  projectProbe: (path: string) => call<ProjectInfo>("project_probe", { path }),
  /** Posts to a webhook saved in the vault (webhook-1..3). Returns the HTTP status. */
  webhookSend: (slot: string, kind: WebhookKind, text: string) =>
    callOrThrow<number>("webhook_send", { slot, kind, text }),
  /** A standalone question to Claude (summary, explanation). Never touches the chat. */
  claudeInsight: (prompt: string) => callOrThrow<{ text: string }>("claude_insight", { prompt }),

  // ── Desktop (on a click, read-only) ───────────────────────────────────────
  /** The wallpaper's image bytes, to match a style to it. */
  wallpaperImage: async (): Promise<ArrayBuffer> => {
    if (!IS_TAURI) throw new Error("not running inside Coucou");
    return invoke<ArrayBuffer>("wallpaper_image");
  },
  nowPlaying: () => callOrThrow<NowPlaying | null>("now_playing"),
  mediaControl: (action: "toggle" | "next" | "previous") => callOrThrow<void>("media_control", { action }),
  dockerContainers: () => callOrThrow<Container[]>("docker_containers"),
  /** One spoken sentence → text (Windows speech recognition). */
  dictate: () => callOrThrow<string>("dictate"),
  weatherPlaces: (query: string) => callOrThrow<Place[]>("weather_places", { query }),
  weatherNow: (latitude: number, longitude: number) => callOrThrow<WeatherNow>("weather_now", { latitude, longitude }),

  // ── Integrations ──────────────────────────────────────────────────────────
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),

  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),
};

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export type ChatContext =
  | { kind: "file"; name: string; path: string }
  | { kind: "window"; appName: string; title: string; url?: string };

export interface SystemStats {
  /** Null on the first sample: usage needs two readings. */
  cpuPercent: number | null;
  cpuCount: number;
  memTotal: number | null;
  memUsed: number | null;
  uptimeSecs: number | null;
  /** Null when there is no battery (or the OS doesn't say). */
  batteryPercent: number | null;
  charging: boolean | null;
  os: "windows" | "linux";
}

export interface ProjectInfo {
  name: string;
  path: string;
  git: boolean;
  branch: string | null;
  detached: boolean;
  /** Which well-known project files exist. Their contents are never read. */
  markers: string[];
}

export type WebhookKind = "ntfy" | "discord" | "slack" | "json";

export interface NowPlaying { title: string; artist: string; playing: boolean; source: string }
export interface Container { name: string; image: string; state: string; status: string; health: string }
export interface Place { name: string; country: string; admin: string; latitude: number; longitude: number }
export interface WeatherNow { temperature: number; code: number; isDay: boolean; wind: number }

export interface KeyCheck {
  status: "connected" | "missing" | "rejected" | "unreachable" | "error";
  detail: string;
}

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export interface HookStatus {
  installed: boolean;
  /** Coucou is Claude Code's status line: the cost meter works. */
  statusLine?: boolean;
  /** Another status line is set; Coucou leaves it alone. */
  foreignStatusLine?: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

async function callRawOrThrow<T>(cmd: string, bytes: Uint8Array): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Coucou");
  return invoke<T>(cmd, bytes);
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Coucou");
  return invoke<T>(cmd, args);
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "hook"; payload: Record<string, unknown> }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

/** Files dragged onto the island. Only reaches us when the window takes the mouse. */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    handler(event.payload as DragDropPayload);
  });
}

/**
 * Outside Tauri, events travel on this in-page bus instead, so the dev preview
 * (dev/island-preview.html) can replay hook and integration traffic through the
 * very same handlers. Inside the app nothing ever dispatches on it.
 */
const devBus = new EventTarget();

export function devEmit(name: string, payload: unknown) {
  devBus.dispatchEvent(new CustomEvent(name, { detail: payload }));
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) {
    const fn = (e: Event) => handler((e as CustomEvent<T>).detail);
    devBus.addEventListener(name, fn);
    return () => devBus.removeEventListener(name, fn);
  }
  return listen<T>(name, (e) => handler(e.payload));
}

/**
 * Message another Coucou window ("island" or "settings"). Used for things that
 * belong to one window but are shown or controlled in the other: screen access
 * lives in the settings window, its indicator and Stop button in the island.
 * Outside Tauri it goes on the in-page bus.
 */
export async function sendTo(window: "island" | "settings", name: string, payload: unknown) {
  if (!IS_TAURI) {
    devEmit(name, payload);
    return;
  }
  try {
    await emitTo(window, name, payload);
  } catch (err) {
    console.error(`[coucou] emit ${name} → ${window} failed`, err);
  }
}
