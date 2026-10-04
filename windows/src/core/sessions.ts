// Every Claude Code session at once, keyed by session_id — so two terminals
// working on two projects show up side by side, each with its own Mochi
// colour. The main pill still follows the most recent one, as before.
//
// Cost, duration and lines changed come from Claude Code's status line, when
// Coucou is installed as it (Settings → Claude Code). Without it they stay
// empty: there is no other source for them.

import { colorForProject } from "./layout";

export interface LiveSession {
  id: string;
  project: string;
  cwd: string;
  color: string;
  state: "working" | "thinking" | "approval" | "question" | "finished" | "error" | "idle";
  lastStep: string;
  lastAt: number;
  startedAt: number;
  tools: number;
  failures: number;
  cost: number | null;
  model: string;
  durationMs: number;
  linesAdded: number;
  linesRemoved: number;
  bigContext: boolean;
  /** The budget alert fired for this session. */
  budgetAlerted: boolean;
}

const sessions = new Map<string, LiveSession>();

export const Sessions = {
  get list(): LiveSession[] {
    return [...sessions.values()].sort((a, b) => b.lastAt - a.lastAt);
  },

  get(id: string): LiveSession | undefined {
    return sessions.get(id);
  },

  touch(id: string, project: string, cwd: string): LiveSession {
    let s = sessions.get(id);
    if (!s) {
      s = {
        id, project, cwd, color: colorForProject(project), state: "idle", lastStep: "", lastAt: Date.now(), startedAt: Date.now(),
        tools: 0, failures: 0, cost: null, model: "", durationMs: 0, linesAdded: 0, linesRemoved: 0, bigContext: false, budgetAlerted: false,
      };
      sessions.set(id, s);
      // A dozen is plenty; the oldest quiet one goes first.
      if (sessions.size > 12) {
        const oldest = [...sessions.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
        sessions.delete(oldest.id);
      }
    }
    if (project) s.project = project;
    if (cwd) s.cwd = cwd;
    s.lastAt = Date.now();
    return s;
  },

  end(id: string) {
    sessions.delete(id);
  },

  /** Claude Code's status line numbers. */
  status(id: string, p: Record<string, unknown>): LiveSession | null {
    const s = sessions.get(id);
    if (!s) return null;
    const n = (k: string) => (typeof p[k] === "number" && Number.isFinite(p[k]) ? (p[k] as number) : 0);
    s.cost = n("cost_usd");
    s.durationMs = n("duration_ms");
    s.linesAdded = n("lines_added");
    s.linesRemoved = n("lines_removed");
    s.model = typeof p.model === "string" ? p.model.slice(0, 40) : s.model;
    s.bigContext = p.exceeds_200k_tokens === true;
    return s;
  },

  /** Sum of every known session's cost, or null when none reported one. */
  get totalCost(): number | null {
    let total: number | null = null;
    for (const s of sessions.values()) if (s.cost != null) total = (total ?? 0) + s.cost;
    return total;
  },
};

export function formatCost(usd: number | null): string {
  if (usd == null) return "—";
  return usd < 0.01 && usd > 0 ? "<$0.01" : `$${usd.toFixed(2)}`;
}
