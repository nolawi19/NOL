// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { STATE_COLOR, kindIcon, toolKind, toolVerb } from "../core/activity";
import { LINE } from "../views/icons";
import { State, type AgentTask } from "../core/state";
import { Automation } from "../core/automation";
import { MODES } from "../core/prefs";
import { analyzeRisk, RISK_LEVEL_LABEL } from "../core/risk";
import { formatMs, Session } from "../core/session";
import { formatCost, Sessions } from "../core/sessions";
import { Guard, flagsOf } from "../core/guard";
import { Progressor } from "../core/progress";
import { Schedule } from "../core/schedule";
import type { Island } from "./island";

const CLAUDE_ID = "integration_claude";

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  coucou_agent?: string;
  /** Pairs PreToolUse with its PostToolUse / PostToolUseFailure. */
  tool_use_id?: string;
  /** PostToolUseFailure: what went wrong. */
  error?: unknown;
  /** StatusLine (coucou-hook --statusline): cost and friends. */
  cost_usd?: number;
}

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * Ticker line for a tool call: "Run · npm test", "Edit · invoice.ts". The verb
 * is what activity.ts parses back into a kind, so every surface agrees on what
 * Claude is doing. (The macOS build shows French verbs; this build is English
 * throughout.)
 */
function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = toolVerb(tool);
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${oneLine(cmd).slice(0, 60)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path") ?? str("notebook_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const url = str("url");
  if (url) return `${label} · ${url.replace(/^https?:\/\//, "").slice(0, 60)}`;
  const query = str("query") ?? str("pattern");
  if (query) return `${label} · ${oneLine(query).slice(0, 60)}`;
  const description = str("description");
  if (description) return `${label} · ${oneLine(description).slice(0, 60)}`;
  return label;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Coucou answers within this long or not at all (see pipe.rs DECISION_TIMEOUT). */
const APPROVAL_TIMEOUT_MS = 110_000;
/**
 * How long the Rust side keeps the relay waiting (pipe.rs DECISION_TIMEOUT).
 * The countdown shows this one: past it, a click can no longer land.
 */
const DECISION_WINDOW_MS = 108_000;

function upsert(projectName: string, cwd: string) {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.name = projectName;
  if (cwd) t.sessionCwd = cwd;
}

function clearSession() {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = "VS Code";
  t.pillBadge = null;
  t.sessionStart = null;
  t.turnStart = null;
  t.toolCount = 0;
}

function taskById(id: string): AgentTask | undefined {
  return State.tasks.find((t) => t.id === id);
}

/** Starts the session clock the first time we hear from a session. */
function touchSession(id: string) {
  const t = taskById(id);
  if (t && !t.sessionStart) t.sessionStart = Date.now();
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");

  // Route to the right pill. Valid coucou_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code pill unchanged.
  const validAgent = validateAgent(payload.coucou_agent);
  const agentId = validAgent ? `agent_${validAgent}` : CLAUDE_ID;
  const isExternalAgent = validAgent !== null;

  const focused = State.focusId === agentId;

  /**
   * Alerts force the island open; work events only reveal the compact island.
   * Focus and presentation modes open nothing by themselves (permission
   * requests don't go through here: they always open).
   */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (!MODES[State.prefs.mode].autoOpen) return;
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  /** Ensure the agent pill exists (no-op for Claude Code). */
  const ensurePill = () => {
    if (isExternalAgent) {
      State.upsertExternalAgent(agentId, validAgent!, agentColor(validAgent!));
    } else {
      upsert(projectName, cwd);
    }
  };

  const project = isExternalAgent ? validAgent! : projectName;
  /** Session tracking (durations, work mode, summaries) is for Claude Code. */
  const tracked = !isExternalAgent;
  // The status line: numbers only, nothing else changes.
  if (name === "StatusLine") {
    const sid = payload.session_id ?? "";
    if (!sid) return;
    if (!Sessions.get(sid)) Sessions.touch(sid, projectName, cwd);
    const live = Sessions.status(sid, payload as Record<string, unknown>);
    const budget = State.prefs.costBudget;
    if (live && budget > 0 && (live.cost ?? 0) >= budget && !live.budgetAlerted) {
      live.budgetAlerted = true;
      Sound.play("rate");
      State.showFlash(`${live.project} passed ${formatCost(budget)} — now ${formatCost(live.cost)}`, "#F59E0B", "error", 8000, true);
      State.log({ text: "Cost budget reached", detail: `${live.project} · ${formatCost(live.cost)}`, tone: "alert", icon: LINE.bolt, color: "#F59E0B", cat: "session", project: live.project });
    }
    State.notify();
    return;
  }

  if (tracked && name && name !== "SessionEnd") Session.begin(projectName, cwd || null);
  // Every Claude Code session, side by side.
  const live = tracked && payload.session_id && name !== "SessionEnd" ? Sessions.touch(payload.session_id, projectName, cwd) : null;
  const liveState = (st: NonNullable<typeof live>["state"], step?: string) => {
    if (!live) return;
    live.state = st;
    if (step) live.lastStep = step.slice(0, 80);
  };
  const fire = (trigger: Parameters<typeof Automation.fire>[0], text: string, detail?: string, view?: Parameters<Island["alert"]>[0]) =>
    Automation.fire(trigger, { project, text, detail, view });

  switch (name) {
    case "SessionStart":
      ensurePill();
      touchSession(agentId);
      State.log({ text: "Session started", detail: projectName, tone: "info", icon: LINE.terminal, color: "#9AA3B2", cat: "session", project });
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      touchSession(agentId);
      {
        const t = taskById(agentId);
        if (t) {
          t.turnStart = Date.now();
          t.toolCount = 0;
        }
      }
      State.updateTask(agentId, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(agentId, asked.slice(0, 60));
      if (tracked) Session.prompted(asked ?? null);
      liveState("thinking", asked ?? "Thinking");
      Schedule.activity();
      State.log({ text: "Prompt", detail: asked?.slice(0, 120), tone: "active", icon: LINE.sparkle, color: STATE_COLOR.thinking, cat: "session", project });
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      ensurePill();
      touchSession(agentId);
      {
        const t = taskById(agentId);
        if (t) t.toolCount = (t.toolCount ?? 0) + 1;
      }
      State.updateTask(agentId, "working");
      const tool = payload.tool_name ?? "Tool";
      const step = stepLabel(tool, payload.tool_input ?? {});
      State.appendStep(agentId, step);
      const rec = tracked ? Session.pre(tool, payload.tool_input ?? {}, payload.tool_use_id) : null;
      liveState("working", step);
      if (live) live.tools++;
      // Edits keep a reference to their change: the timeline opens the diff.
      State.log({ text: step, tone: "active", icon: kindIcon(toolKind(tool)), color: STATE_COLOR.working, cat: "tool", project, ref: rec?.change ? rec.id : undefined });
      surface("overview", false);
      break;
    }

    case "PostToolUse": {
      State.updateTask(agentId, "working");
      const rec = tracked ? Session.post(payload.tool_name ?? "", payload.tool_use_id, true) : null;
      // Shell commands get their duration on the timeline once they finish.
      if (rec?.commandClass && rec.end) {
        const took = rec.end - rec.start;
        if (took >= 1000) {
          State.log({ text: `Done · ${rec.target.slice(0, 60)}`, detail: `${formatMs(took)} · exit OK`, tone: "success", icon: LINE.checkCircle, color: "#34D399", cat: "tool", project });
        }
        if (rec.commandClass === "deploy") {
          fire("deploy-command-succeeded", `Deploy command finished`, rec.target, "overview");
          Progressor.deploy();
        }
        if (rec.commandClass === "test") {
          const previous = Session.tests[1];
          Progressor.tests(true, previous ? !previous.ok : false);
          island.celebrate("Tests passed");
        }
      }
      break;
    }

    case "PostToolUseFailure": {
      State.updateTask(agentId, "working");
      State.appendStep(agentId, "⚠ failed");
      const error = typeof payload.error === "string" ? payload.error : undefined;
      const rec = tracked ? Session.post(payload.tool_name ?? "", payload.tool_use_id, false, error) : null;
      const what = rec?.commandClass ? rec.target.slice(0, 60) : payload.tool_name ?? "Tool";
      const took = rec?.end ? ` after ${formatMs(rec.end - rec.start)}` : "";
      State.log({ text: `Failed · ${what}`, detail: (rec?.error ?? "") + took || undefined, tone: "error", icon: LINE.xCircle, color: STATE_COLOR.error, cat: "error", project });
      fire("tool-failed", `${payload.tool_name ?? "Tool"} failed`, rec?.error ?? undefined, "overview");
      if (live) live.failures++;
      if (rec?.commandClass === "test") Progressor.tests(false, false);
      if (rec?.commandClass) {
        fire("command-failed", `Command failed: ${rec.target.slice(0, 80)}`, rec.error ?? undefined, "overview");
        if (rec.commandClass === "test") fire("tests-failed", "Tests failed", `${rec.target}\n${rec.error ?? ""}`.trim(), "overview");
        if (rec.commandClass === "build") fire("build-failed", "Build failed", `${rec.target}\n${rec.error ?? ""}`.trim(), "overview");
      }
      break;
    }

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(agentId, "ratelimit");
        Sound.play("rate");
      } else if (message.trim().endsWith("?")) {
        State.updateTask(agentId, "question");
        State.appendStep(agentId, message);
        State.log({ text: "Question", detail: message, tone: "alert", icon: LINE.ask, color: STATE_COLOR.question, cat: "session", project });
        fire("question-asked", "Claude is asking a question", message, "question");
        liveState("question", message);
      }
      break;
    }

    case "Stop":
      State.updateTask(agentId, "finished");
      if (tracked) {
        Session.settle();
        const snap = Session.snapshot();
        Progressor.sessionFinished({ tools: snap.tools, failures: snap.failed, files: snap.filesChanged.length });
      }
      liveState("finished", payload.message ?? "Finished");
      State.log({ text: "Finished", detail: payload.message?.slice(0, 120), tone: "success", icon: LINE.checkCircle, color: STATE_COLOR.finished, cat: "session", project });
      fire("session-finished", "Session finished", payload.message?.slice(0, 400), "finished");
      if (payload.message) State.appendStep(agentId, payload.message.slice(0, 60));
      Sound.play("finish");
      if (focused && MODES[State.prefs.mode].autoOpen) surface("finished", true);
      else {
        State.setPillBadge(agentId, "finished");
        State.showFlash(`${taskById(agentId)?.name ?? "Session"} · finished`, STATE_COLOR.finished, "success");
      }
      window.setTimeout(() => {
        if (isExternalAgent) {
          State.removeTask(agentId);
        } else {
          State.updateTask(agentId, "idle");
          State.setPillBadge(agentId, null);
        }
      }, 5200);
      break;

    case "StopFailure":
      State.updateTask(agentId, "error");
      if (tracked) Session.settle();
      liveState("error", payload.message ?? "Stopped on an error");
      State.log({ text: "Stopped on an error", detail: payload.message?.slice(0, 120), tone: "error", icon: LINE.xCircle, color: STATE_COLOR.error, cat: "error", project });
      fire("session-failed", "Session stopped on an error", payload.message?.slice(0, 400), "error");
      Sound.play("error");
      if (focused && MODES[State.prefs.mode].autoOpen) surface("error", true);
      else {
        State.setPillBadge(agentId, "error");
        State.showFlash(`${taskById(agentId)?.name ?? "Session"} · stopped on an error`, STATE_COLOR.error, "error");
      }
      break;

    case "SessionEnd":
      if (isExternalAgent) {
        State.removeTask(agentId);
      } else {
        State.updateTask(agentId, "idle");
        clearSession();
        Session.reset();
        if (payload.session_id) Sessions.end(payload.session_id);
      }
      break;

    case "SubagentStart":
      State.appendStep(agentId, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(agentId, "• subagent done");
      break;

    case "PermissionRequest": {
      // External agents do not get an approval card — showing one would look like
      // a Claude Code request. Decline immediately so the agent re-asks in its
      // terminal. Approval support for other agents will come with Codex support.
      if (isExternalAgent) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      // On hold (panic button): every new request goes back to the terminal.
      if (Guard.hold && requestId) {
        void Bridge.approvalDecline(requestId);
        State.log({ text: "Request sent to the terminal (on hold)", detail: `${payload.tool_name ?? "Tool"} · ${approvalTarget(payload.tool_input ?? {})}`.slice(0, 160), tone: "info", icon: LINE.shield, color: "#9AA3B2", cat: "permission", project });
        State.showFlash("On hold — answer in the terminal", "#F4505E", "error", 4000, true);
        break;
      }
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      upsert(projectName, cwd);
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      const target = approvalTarget(input);
      let risk = null;
      try {
        risk = analyzeRisk(tool, input, cwd || null);
      } catch {
        /* a reading aid only: the card works without it */
      }
      State.pendingApproval = {
        requestId,
        sessionId: payload.session_id ?? "",
        tool,
        command: target ? `${tool} · ${target}` : tool,
        target,
        receivedAt: Date.now(),
        timeoutMs: DECISION_WINDOW_MS,
        risk,
        cwd: cwd || null,
      };
      State.detailExpanded = false;
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(CLAUDE_ID, "approval");
      State.isPinned = true;
      State.log({
        text: risk && risk.level !== "low" ? `Permission requested · ${RISK_LEVEL_LABEL[risk.level]}` : "Permission requested",
        detail: State.pendingApproval.command,
        tone: "alert",
        icon: LINE.shield,
        color: STATE_COLOR.approval,
        cat: "permission",
        project,
      });
      // Automations may tell someone a request is waiting. None can answer it.
      fire("permission-requested", `Permission requested: ${tool}`, State.pendingApproval.command, "approval");
      liveState("approval", State.pendingApproval.command);
      {
        const req = State.pendingApproval;
        // "You allowed this 4× before" — counted by hash, never stored as text.
        void Guard.countsFor(tool, target).then((c) => {
          if (State.pendingApproval === req) {
            req.counts = c ? { allow: c.allow, deny: c.deny } : null;
            State.notify();
          }
        });
        void Guard.log({ at: Date.now(), tool, target, level: risk?.level ?? "low", flags: flagsOf(risk), decision: "pending", project }).then((id) => {
          req.logId = id;
        });
      }
      Sound.play("approval");
      if (focused) {
        island.alert("approval");
      } else {
        // Another agent holds the view, so the card would yank it away. The badge
        // is the signal instead — but it has to be on screen for that to mean
        // anything, hence the reveal. We just told the relay a human can act.
        State.setPillBadge(CLAUDE_ID, "approval");
        island.reveal();
      }
      // Coucou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (!State.pendingApproval) return;
        const expired = State.pendingApproval;
        State.pendingApproval = null;
        State.isPinned = false;
        island.dropPin();
        // Nobody answered in time: Claude Code is asking in the terminal now.
        State.updateTask(CLAUDE_ID, "question");
        State.appendStep(CLAUDE_ID, "Permission · answer in the terminal");
        State.setPillBadge(CLAUDE_ID, null);
        State.log({ text: "Permission expired", detail: expired.command, tone: "alert", icon: LINE.hourglass, color: "#F5A524", cat: "permission", project });
        void Guard.setDecision(expired.logId ?? null, "terminal");
        if (State.view === "approval") island.setView(State.defaultView());
        State.notify();
      }, APPROVAL_TIMEOUT_MS);
      break;
    }

    default:
      break;
  }
  State.notify();
}
