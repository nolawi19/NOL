// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";
import { MODES, readPrefs, type Prefs } from "./prefs";
import type { RiskReport } from "./risk";

export type AgentSource = "claudeCode" | "n8n" | "agent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  /** Wall-clock ms when the current session started (first hook event). */
  sessionStart?: number | null;
  /** Wall-clock ms when the current prompt was submitted. */
  turnStart?: number | null;
  /** Tool calls made since the current prompt was submitted. */
  toolCount?: number;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  /** "Tool · target" — the one-line summary used in logs and badges. */
  command: string;
  /** Just the thing being authorised: the command, the path, the URL. */
  target: string;
  /** Wall-clock ms when the request reached the island. */
  receivedAt: number;
  /** How long the island has before the terminal takes the question back, ms. */
  timeoutMs: number;
  /** A reading of what the request would do (core/risk.ts). Advisory only. */
  risk: RiskReport | null;
  /** The folder the session runs in. */
  cwd: string | null;
}

/** A short-lived line shown in the compact island ("Vercel · Deployment ready"). */
export interface Flash {
  text: string;
  color: string;
  tone: "success" | "error" | "info";
  at: number;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "VS Code", "#F5F6F8", "claudeCode"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  /**
   * Legacy: the island no longer closes on a timer. Still sent so settings.json
   * stays readable by older builds (the Rust struct requires it); never shown.
   */
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  /** Claude model used by the chat. */
  model: string;
  /** The first-launch introduction has been completed. */
  onboarded: boolean;
  /**
   * Everything newer (modes, appearance, per-event sounds, automations,
   * memory switches). Opaque to Rust; read through core/prefs.ts, which
   * repairs anything missing or malformed.
   */
  prefs: unknown;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5",
  onboarded: false,
  prefs: null,
};

/** One line of the activity timeline (command center). */
export interface TimelineEntry {
  id: number;
  /** Wall-clock ms. */
  at: number;
  text: string;
  detail?: string;
  tone: "active" | "alert" | "success" | "error" | "info";
  /** A line icon path (views/icons.ts LINE). */
  icon: string;
  color: string;
  /** What the line is about, for the timeline's filters. */
  cat: TimelineCat;
  /** Project folder name, when the line belongs to a Claude Code session. */
  project?: string;
}

export type TimelineCat = "session" | "tool" | "permission" | "error" | "integration" | "chat" | "screen" | "automation";

/**
 * What the energy core is showing, by name. Derived from the activity phase
 * and how long things have been quiet — never set for show.
 */
export type CoreState =
  | "dormant" | "awakening" | "idle" | "thinking" | "analyzing" | "executing" | "communicating"
  | "warning" | "permission" | "success" | "failure" | "cooling";

export const CORE_STATE_LABEL: Record<CoreState, string> = {
  dormant: "Dormant",
  awakening: "Awakening",
  idle: "Idle",
  thinking: "Thinking",
  analyzing: "Analyzing",
  executing: "Executing",
  communicating: "Communicating",
  warning: "Needs attention",
  permission: "Waiting for permission",
  success: "Success",
  failure: "Failure",
  cooling: "Cooling down",
};

/** Screen access, as reported by the window that holds the capture. */
export interface ScreenAccess {
  active: boolean;
  label: string | null;
  since: number | null;
}

const TIMELINE_MAX = 200;

let timelineId = 1;

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  pendingApproval: ApprovalInfo | null = null;
  /** Approval / question card showing the full text instead of two lines. */
  detailExpanded = false;
  flash: Flash | null = null;
  /** Newest first. Real events only: hooks, decisions, integrations, chat. */
  timeline: TimelineEntry[] = [];
  screen: ScreenAccess = { active: false, label: null, since: null };
  /** Whether the stored Anthropic key was last seen working (null = unknown). */
  apiConnected: boolean | null = null;
  /** Whether a key is saved at all (null = not asked yet). */
  apiKeyPresent: boolean | null = null;
  /** The display the island lives on, from Rust at boot (logical px). */
  display: { width: number; height: number; scale: number } | null = null;
  version = "";
  /** The energy core's named state, set by the island from real activity. */
  coreState: CoreState = "idle";
  private flashTimer: number | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** loadIntegrationTasks() — VS Code always on, the rest opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        proto.id === "integration_claude" || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Order: integration_claude first, then agent_* pills (visible in slice(0,4)),
    // then other integrations in declaration order.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => {
      const isAgentA = a.id.startsWith("agent_");
      const isAgentB = b.id.startsWith("agent_");
      // integration_claude always first
      if (a.id === "integration_claude") return -1;
      if (b.id === "integration_claude") return 1;
      // agent_* before other integrations; preserve insertion order among themselves
      if (isAgentA && !isAgentB) return -1;
      if (isAgentB && !isAgentA) return 1;
      if (isAgentA && isAgentB) return 0;
      // both known integrations → declaration order
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
    if (!this.focusId) this.focusId = "integration_claude";
    this.notify();
  }

  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tasks.splice(idx, 1);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? "integration_claude";
    this.notify();
  }

  /** Creates a dynamic agent_ pill on first event; no-ops if it already exists.
   *  Inserted right after integration_claude so it appears in the visible slice(0,4). */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const at = this.tasks.findIndex((t) => t.id === "integration_claude") + 1;
    this.tasks.splice(at, 0, {
      id, name, color,
      state: "idle", stepIndex: 0, steps: [],
      source: "agent", isIntegration: false,
    });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  toggleIntegration(id: string) {
    if (id === "integration_claude") return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  private prefsRaw: unknown = undefined;
  private prefsCache: Prefs | null = null;

  /** Modes, appearance, sounds, automations… always complete and valid. */
  get prefs(): Prefs {
    if (this.prefsCache == null || this.prefsRaw !== this.settings.prefs) {
      this.prefsRaw = this.settings.prefs;
      this.prefsCache = readPrefs(this.settings.prefs);
    }
    return this.prefsCache;
  }

  log(entry: Omit<TimelineEntry, "id" | "at" | "cat"> & { cat?: TimelineCat }) {
    const cat: TimelineCat = entry.cat ?? (entry.tone === "error" ? "error" : "session");
    this.timeline.unshift({ ...entry, cat, id: timelineId++, at: Date.now() });
    if (this.timeline.length > TIMELINE_MAX) this.timeline.length = TIMELINE_MAX;
  }

  /**
   * Shows a transient line in the compact island for a few seconds. Focus and
   * presentation modes drop routine flashes; `important` ones (screen access,
   * anything about a request waiting on the user) always show.
   */
  showFlash(text: string, color: string, tone: Flash["tone"], ms = 6000, important = false) {
    if (!important && !MODES[this.prefs.mode].flashes) return;
    this.flash = { text, color, tone, at: performance.now() };
    if (this.flashTimer != null) window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.flashTimer = null;
      this.flash = null;
      this.notify();
    }, ms);
    this.notify();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
