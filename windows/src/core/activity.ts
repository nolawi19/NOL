// What Claude is doing, in one word — derived from the task state and the last
// tool it reached for. Every surface that talks about activity (the header
// capsule, the compact status line, the ticker icons, the island's light) reads
// it from here, so they can never disagree.

import { LINE } from "../views/icons";
import type { BotStateName } from "./layout";
import type { AgentTask } from "./state";

export type ActivityKind =
  | "think"
  | "read"
  | "edit"
  | "write"
  | "run"
  | "search"
  | "web"
  | "agent"
  | "plan"
  | "tool"
  | "permission"
  | "question"
  | "done"
  | "error"
  | "ratelimit";

/** How loud a phase is: drives the island's light and the capsule styling. */
export type ActivityTone = "active" | "alert" | "success" | "error" | "idle";

export interface Phase {
  kind: ActivityKind;
  /** "Running a command" */
  label: string;
  /** "npm test" — the thing being worked on, when known. */
  detail: string | null;
  color: string;
  icon: string;
  tone: ActivityTone;
  task: AgentTask;
}

/** Tool → verb shown in the ticker. One verb per kind keeps the labels parseable. */
const TOOL_VERBS: Record<string, string> = {
  Bash: "Run",
  PowerShell: "Run",
  BashOutput: "Run",
  KillShell: "Run",
  Read: "Read",
  LS: "List",
  NotebookRead: "Read",
  Write: "Write",
  Edit: "Edit",
  MultiEdit: "Edit",
  NotebookEdit: "Edit",
  Glob: "Find",
  Grep: "Search",
  WebSearch: "Web search",
  WebFetch: "Fetch",
  TodoWrite: "Plan",
  Task: "Agent",
  Agent: "Agent",
};

const VERB_KIND: Record<string, ActivityKind> = {
  Run: "run",
  Read: "read",
  List: "read",
  Write: "write",
  Edit: "edit",
  Find: "search",
  Search: "search",
  "Web search": "web",
  Fetch: "web",
  Plan: "plan",
  Agent: "agent",
};

export function toolVerb(tool: string): string {
  if (TOOL_VERBS[tool]) return TOOL_VERBS[tool];
  // MCP tools arrive as mcp__server__tool: show the readable tail.
  if (tool.startsWith("mcp__")) return tool.split("__").pop() || tool;
  return tool;
}

export function toolKind(tool: string): ActivityKind {
  return VERB_KIND[toolVerb(tool)] ?? "tool";
}

/** Splits a ticker step ("Run · npm test") back into its kind and detail. */
export function parseStep(step: string): { kind: ActivityKind | null; verb: string; detail: string } {
  const sep = step.indexOf(" · ");
  const verb = sep >= 0 ? step.slice(0, sep) : step;
  const detail = sep >= 0 ? step.slice(sep + 3) : "";
  if (step.startsWith("+ subagent") || step.startsWith("• subagent")) {
    return { kind: "agent", verb: "Agent", detail: "" };
  }
  if (step.startsWith("⚠")) return { kind: "error", verb, detail };
  return { kind: VERB_KIND[verb] ?? null, verb, detail };
}

const KIND_META: Record<ActivityKind, { label: string; icon: string }> = {
  think: { label: "Thinking", icon: LINE.sparkle },
  read: { label: "Reading files", icon: LINE.eye },
  edit: { label: "Editing code", icon: LINE.pencil },
  write: { label: "Writing a file", icon: LINE.filePlus },
  run: { label: "Running a command", icon: LINE.terminal },
  search: { label: "Searching the code", icon: LINE.search },
  web: { label: "Browsing the web", icon: LINE.globe },
  agent: { label: "Running a subagent", icon: LINE.nodes },
  plan: { label: "Planning", icon: LINE.checklist },
  tool: { label: "Using a tool", icon: LINE.wrench },
  permission: { label: "Needs your permission", icon: LINE.shield },
  question: { label: "Waiting for you", icon: LINE.ask },
  done: { label: "Finished", icon: LINE.checkCircle },
  error: { label: "Stopped on an error", icon: LINE.xCircle },
  ratelimit: { label: "Rate limited", icon: LINE.hourglass },
};

export function kindIcon(kind: ActivityKind): string {
  return KIND_META[kind].icon;
}

export const STATE_COLOR: Record<BotStateName, string> = {
  idle: "#9AA3B2",
  working: "#3B9EFF",
  thinking: "#A78BFA",
  searching: "#6366F1",
  approval: "#F5A524",
  question: "#22D3EE",
  error: "#F4505E",
  finished: "#34D399",
  ratelimit: "#F59E0B",
  sleeping: "#94A2B8",
  dizzy: "#F472B6",
};

/** The phase of one task, or null when it is simply idle. */
export function phaseOf(task: AgentTask | null): Phase | null {
  if (!task) return null;
  const last = task.steps.at(-1) ?? "";
  const make = (kind: ActivityKind, tone: ActivityTone, detail: string | null, label?: string): Phase => ({
    kind,
    label: label ?? KIND_META[kind].label,
    detail: detail || null,
    color: STATE_COLOR[task.state],
    icon: KIND_META[kind].icon,
    tone,
    task,
  });

  // Integration pills (Vercel, n8n, Stripe…) only ever report an outcome:
  // "Vercel · Deployment ready", "n8n · Sync contacts".
  if (task.isIntegration && task.id !== "integration_claude") {
    if (task.state === "finished") return make("done", "success", task.steps[0] ?? "Succeeded", task.name);
    if (task.state === "error") return make("error", "error", task.steps[0] ?? "Failed", task.name);
    return null;
  }

  switch (task.state) {
    case "approval":
      return make("permission", "alert", null);
    case "question":
      return make("question", "alert", last);
    case "error":
      return make("error", "error", last);
    case "finished":
      return make("done", "success", last);
    case "ratelimit":
      return make("ratelimit", "alert", null);
    case "thinking":
      return make("think", "active", last);
    case "searching":
      return make("search", "active", null);
    case "working": {
      const step = parseStep(last);
      const kind = step.kind && step.kind !== "error" ? step.kind : "tool";
      // An unknown tool is named ("Using Notebook"); no step at all is just work.
      // (The last step can also be the prompt itself, which is not a tool name.)
      const toolName = step.kind !== "error" && /^[A-Za-z][\w.-]{0,31}$/.test(step.verb) ? step.verb : null;
      const label = kind !== "tool" ? undefined : toolName ? `Using ${toolName}` : "Working";
      return make(kind, "active", step.detail || null, label);
    }
    default:
      return null;
  }
}

const URGENCY: Record<ActivityTone, number> = { alert: 4, error: 3, active: 2, success: 1, idle: 0 };

/**
 * The phase worth showing when there is room for one: a request waiting on
 * the user beats an error, which beats work in progress, which beats a recent
 * success. Ties go to the focused task.
 */
export function primaryPhase(tasks: AgentTask[], focusId: string | null): Phase | null {
  let best: Phase | null = null;
  for (const t of tasks) {
    const p = phaseOf(t);
    if (!p) continue;
    if (
      !best ||
      URGENCY[p.tone] > URGENCY[best.tone] ||
      (URGENCY[p.tone] === URGENCY[best.tone] && t.id === focusId)
    ) {
      best = p;
    }
  }
  return best;
}

/** "42s", "3m 05s", "1h 12m" — compact, monospace-friendly durations. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}
