// Terminal and session awareness, from the hook events alone.
//
// PreToolUse / PostToolUse / PostToolUseFailure come in pairs; matching them
// gives every command a duration and an outcome. From those records the
// tracker knows what is running right now, what kind of work the session is
// doing, and can write a plain summary of a turn — locally, without sending
// anything anywhere. (Claude is only asked for a summary when the user clicks
// for one, or an automation they created says so.)

import { classifyCommand, type CommandClass } from "./risk";

export type WorkMode = "coding" | "debugging" | "testing" | "building" | "deploying" | "exploring" | "planning" | "idle";

export const WORK_MODE_LABEL: Record<WorkMode, string> = {
  coding: "Coding",
  debugging: "Debugging",
  testing: "Testing",
  building: "Building",
  deploying: "Deploying",
  exploring: "Exploring",
  planning: "Planning",
  idle: "Idle",
};

export interface ToolRecord {
  id: string;
  tool: string;
  /** The command, path or URL — whatever the tool acted on. */
  target: string;
  /** Set for shell tools. */
  commandClass: CommandClass | null;
  start: number;
  end: number | null;
  outcome: "running" | "ok" | "failed";
  /** First line of the failure, when Claude Code sent one. */
  error: string | null;
  /** What an Edit / Write / MultiEdit changed, from the request itself. */
  change: FileChange | null;
}

export interface FileChange {
  file: string;
  before: string;
  after: string;
  /** "edit": before → after is the exact replacement; "write": the new contents (the old ones aren't sent). */
  kind: "edit" | "write";
  /** The relay cut one of the strings at 2,000 characters. */
  truncated: boolean;
}

export interface TestRun {
  command: string;
  start: number;
  end: number;
  ok: boolean;
  error: string | null;
  project: string;
}

const MAX_CHANGE = 6000;

/** The change an edit-type tool call carries in its input. */
export function changeOf(tool: string, input: Record<string, unknown>): FileChange | null {
  const s = (k: string, o: Record<string, unknown> = input) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const file = s("file_path") || s("notebook_path");
  const cut = (t: string) => t.slice(0, MAX_CHANGE);
  const trunc = (...t: string[]) => t.some((x) => x.endsWith("…") || x.length > MAX_CHANGE);
  if (tool === "Edit") {
    const before = s("old_string");
    const after = s("new_string");
    return { file, before: cut(before), after: cut(after), kind: "edit", truncated: trunc(before, after) };
  }
  if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    const edits = (input.edits as unknown[]).filter((e): e is Record<string, unknown> => typeof e === "object" && e != null);
    const before = edits.map((e) => s("old_string", e)).join("\n⋯\n");
    const after = edits.map((e) => s("new_string", e)).join("\n⋯\n");
    return { file, before: cut(before), after: cut(after), kind: "edit", truncated: trunc(before, after) };
  }
  if (tool === "Write") {
    const content = s("content");
    return { file, before: "", after: cut(content), kind: "write", truncated: trunc(content) };
  }
  if (tool === "NotebookEdit") {
    const src = s("new_source");
    return { file, before: "", after: cut(src), kind: "edit", truncated: trunc(src) };
  }
  return null;
}

export interface SessionSnapshot {
  project: string;
  cwd: string | null;
  start: number | null;
  turnStart: number | null;
  prompt: string | null;
  tools: number;
  failed: number;
  filesChanged: string[];
  filesRead: number;
  commands: ToolRecord[];
  workMode: WorkMode;
  running: ToolRecord | null;
}

const SHELL = new Set(["Bash", "PowerShell"]);
const EDITS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READS = new Set(["Read", "LS", "Glob", "Grep", "NotebookRead"]);
const MAX_RECORDS = 200;

function targetOf(input: Record<string, unknown>): string {
  for (const k of ["command", "file_path", "notebook_path", "path", "url", "query", "pattern", "description"]) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ");
  }
  return "";
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
}

class Tracker {
  project = "";
  cwd: string | null = null;
  start: number | null = null;
  turnStart: number | null = null;
  prompt: string | null = null;
  records: ToolRecord[] = [];
  /** Test runs, newest first — kept across turns (not across Coucou restarts). */
  tests: TestRun[] = [];
  /** Turn-scoped counters, reset on every prompt. */
  private changed = new Set<string>();
  private reads = 0;
  private turnRecords = 0;
  private seq = 0;

  begin(project: string, cwd: string | null) {
    this.project = project;
    this.cwd = cwd;
    if (this.start == null) this.start = Date.now();
  }

  prompted(text: string | null) {
    this.turnStart = Date.now();
    this.prompt = text;
    this.changed.clear();
    this.reads = 0;
    this.turnRecords = this.records.length;
  }

  /** PreToolUse. Returns the record so the caller can show it. */
  pre(tool: string, input: Record<string, unknown>, toolUseId: string | undefined): ToolRecord {
    const target = targetOf(input);
    // Claude Code calls tools one after another; a non-shell call still
    // "running" when the next one starts lost its PostToolUse (a denied
    // request sends none). Shell commands can run in the background, so
    // those wait for their own result.
    for (const r of this.records) {
      if (r.outcome === "running" && r.commandClass == null) {
        r.outcome = "ok";
        r.end = Date.now();
      }
    }
    const rec: ToolRecord = {
      id: toolUseId || `t${++this.seq}`,
      tool,
      target,
      commandClass: SHELL.has(tool) ? classifyCommand(target) : null,
      start: Date.now(),
      end: null,
      outcome: "running",
      error: null,
      change: changeOf(tool, input),
    };
    this.records.push(rec);
    if (this.records.length > MAX_RECORDS) {
      this.records.shift();
      this.turnRecords = Math.max(0, this.turnRecords - 1);
    }
    if (EDITS.has(tool) && target) this.changed.add(target);
    if (READS.has(tool)) this.reads++;
    return rec;
  }

  /**
   * PostToolUse / PostToolUseFailure. Matched by tool_use_id when Claude Code
   * sends one, otherwise by the oldest running call of the same tool.
   */
  post(tool: string, toolUseId: string | undefined, ok: boolean, error?: string): ToolRecord | null {
    let rec: ToolRecord | undefined;
    if (toolUseId) rec = this.records.find((r) => r.id === toolUseId);
    rec ??= this.records.find((r) => r.outcome === "running" && r.tool === tool);
    if (!rec) return null;
    rec.end = Date.now();
    rec.outcome = ok ? "ok" : "failed";
    if (!ok && error) rec.error = error.split("\n").find((l) => l.trim())?.trim().slice(0, 200) ?? null;
    if (rec.commandClass === "test") {
      this.tests.unshift({ command: rec.target, start: rec.start, end: rec.end, ok, error: rec.error, project: this.project });
      if (this.tests.length > 40) this.tests.length = 40;
    }
    return rec;
  }

  /** The turn ended (Stop / StopFailure): anything still "running" never reported back. */
  settle() {
    for (const r of this.records) if (r.outcome === "running") {
      r.outcome = "ok";
      r.end = r.end ?? Date.now();
    }
  }

  reset() {
    this.project = "";
    this.cwd = null;
    this.start = null;
    this.turnStart = null;
    this.prompt = null;
    this.records = [];
    this.changed.clear();
    this.reads = 0;
    this.turnRecords = 0;
  }

  /** Edit / Write records with their change, oldest first. */
  get changes(): ToolRecord[] {
    return this.records.filter((r) => r.change != null);
  }

  get turn(): ToolRecord[] {
    return this.records.slice(this.turnRecords);
  }

  get running(): ToolRecord | null {
    for (let i = this.records.length - 1; i >= 0; i--) if (this.records[i].outcome === "running") return this.records[i];
    return null;
  }

  /** What kind of work the last dozen tool calls add up to. */
  get workMode(): WorkMode {
    const recent = this.records.slice(-12);
    if (recent.length === 0) return "idle";
    const last = recent.at(-1)!;
    if (last.commandClass === "deploy") return "deploying";
    if (last.commandClass === "test") return "testing";
    if (last.commandClass === "build" || last.commandClass === "install") return "building";
    const failures = recent.filter((r) => r.outcome === "failed").length;
    const edits = recent.filter((r) => EDITS.has(r.tool)).length;
    const reads = recent.filter((r) => READS.has(r.tool) || r.tool === "WebFetch" || r.tool === "WebSearch").length;
    if (failures >= 2 || (failures >= 1 && edits >= 1)) return "debugging";
    if (recent.some((r) => r.tool === "TodoWrite") && edits === 0) return "planning";
    if (edits >= Math.max(2, reads / 2)) return "coding";
    if (reads > 0) return "exploring";
    return edits > 0 ? "coding" : "exploring";
  }

  snapshot(): SessionSnapshot {
    const turn = this.turn;
    return {
      project: this.project,
      cwd: this.cwd,
      start: this.start,
      turnStart: this.turnStart,
      prompt: this.prompt,
      tools: turn.length,
      failed: turn.filter((r) => r.outcome === "failed").length,
      filesChanged: [...this.changed],
      filesRead: this.reads,
      commands: turn.filter((r) => r.commandClass != null),
      workMode: this.workMode,
      running: this.running,
    };
  }
}

export const Session = new Tracker();

export function formatMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** One line for the finished card: "4 files · 12 tools · 2 failed · 3m 10s". */
export function shortSummary(s: SessionSnapshot): string {
  const parts: string[] = [];
  if (s.filesChanged.length) parts.push(`${s.filesChanged.length} file${s.filesChanged.length === 1 ? "" : "s"} changed`);
  if (s.tools) parts.push(`${s.tools} tool${s.tools === 1 ? "" : "s"}`);
  if (s.failed) parts.push(`${s.failed} failed`);
  if (s.turnStart) parts.push(formatMs(Date.now() - s.turnStart));
  return parts.join(" · ");
}

/** The plain-text summary of a turn, written from the records alone. */
export function localSummary(s: SessionSnapshot): string {
  const lines: string[] = [];
  lines.push(`${s.project || "Claude Code"}${s.turnStart ? ` — ${formatMs(Date.now() - s.turnStart)}` : ""}`);
  if (s.prompt) lines.push(`Asked: ${s.prompt.slice(0, 160)}`);
  lines.push(`Work: ${WORK_MODE_LABEL[s.workMode].toLowerCase()} · ${s.tools} tool call${s.tools === 1 ? "" : "s"}${s.failed ? `, ${s.failed} failed` : ""} · ${s.filesRead} read${s.filesRead === 1 ? "" : "s"}`);
  if (s.filesChanged.length) {
    const names = s.filesChanged.map(basename);
    lines.push(`Changed: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ` and ${names.length - 8} more` : ""}`);
  }
  for (const c of s.commands.slice(-6)) {
    const dur = c.end ? ` (${formatMs(c.end - c.start)})` : "";
    lines.push(`${c.outcome === "failed" ? "✗" : c.outcome === "running" ? "…" : "✓"} ${c.target.slice(0, 90)}${dur}${c.error ? ` — ${c.error.slice(0, 100)}` : ""}`);
  }
  return lines.join("\n");
}

/** The prompt sent when the user asks Claude to summarise the session. */
export function summaryPrompt(s: SessionSnapshot, timelineLines: string[]): string {
  return [
    "Summarise what this Claude Code session just did, for the developer who was away.",
    "Lead with the outcome; mention anything that failed or needs their attention. Plain text, at most 6 lines.",
    "",
    localSummary(s),
    "",
    "Recent events (newest first):",
    ...timelineLines.slice(0, 30),
  ].join("\n");
}
