// Safety tools: the panic button, approval counts and the security log.
//
// Panic denies the request on screen (you pressed the button — that's the
// click) and puts Coucou on hold: every new request goes straight back to the
// terminal, where Claude Code asks as usual, and automations stop. Hold never
// approves anything and never stops Claude Code itself — that's Esc in the
// terminal.
//
// Approval counts remember how often you allowed or denied the same request,
// stored only as a SHA-256 of the tool and target — the command itself is not
// kept. The security log (off by default) keeps scrubbed request lines on this
// computer for the weekly report. Both can be cleared in Security center.

import type { RiskReport } from "./risk";
import { scrub } from "./memory";
import { State } from "./state";

const DB = "coucou-guard";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("Storage isn't available."));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("counts")) db.createObjectStore("counts", { keyPath: "hash" });
      if (!db.objectStoreNames.contains("log")) db.createObjectStore("log", { keyPath: "id", autoIncrement: true }).createIndex("at", "at");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Couldn't open storage."));
  });
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? (req.result as T) : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

async function hashOf(tool: string, target: string): Promise<string> {
  const data = new TextEncoder().encode(`${tool}\n${target}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Counts {
  hash: string;
  allow: number;
  deny: number;
  last: number;
}

export interface LogEntry {
  id?: number;
  at: number;
  tool: string;
  target: string;
  level: string;
  flags: string[];
  decision: "allow" | "deny" | "terminal" | "pending";
  project: string;
}

export interface Report {
  days: number;
  total: number;
  byLevel: Record<string, number>;
  denied: number;
  topFlags: [string, number][];
  risky: LogEntry[];
}

type Listener = () => void;
let holdListener: Listener | null = null;

export const Guard = {
  /** On hold: new requests go back to the terminal, automations pause. */
  hold: false,

  onHold(fn: Listener) {
    holdListener = fn;
  },

  setHold(on: boolean) {
    this.hold = on;
    holdListener?.();
    State.notify();
  },

  async countsFor(tool: string, target: string): Promise<Counts | null> {
    if (!State.prefs.security.approvalCounts) return null;
    try {
      const h = await hashOf(tool, target);
      return (await run<Counts>("counts", "readonly", (s) => s.get(h))) ?? null;
    } catch {
      return null;
    }
  },

  async recordDecision(tool: string, target: string, decision: "allow" | "deny") {
    if (!State.prefs.security.approvalCounts) return;
    try {
      const h = await hashOf(tool, target);
      const c = (await run<Counts>("counts", "readonly", (s) => s.get(h))) ?? { hash: h, allow: 0, deny: 0, last: 0 };
      c[decision]++;
      c.last = Date.now();
      await run("counts", "readwrite", (s) => s.put(c));
    } catch {
      /* counts are a nicety */
    }
  },

  async log(entry: LogEntry): Promise<number | null> {
    if (!State.prefs.security.log) return null;
    try {
      const clean = { ...entry, target: scrub(entry.target).slice(0, 240) };
      delete clean.id;
      const id = await run<IDBValidKey>("log", "readwrite", (s) => s.add(clean));
      // Keep 90 days.
      const cutoff = Date.now() - 90 * 86_400_000;
      await run("log", "readwrite", (s) => {
        const r = s.index("at").openCursor(IDBKeyRange.upperBound(cutoff));
        r.onsuccess = () => {
          const c = r.result;
          if (c) {
            c.delete();
            c.continue();
          }
        };
      });
      return typeof id === "number" ? id : null;
    } catch {
      return null;
    }
  },

  async setDecision(id: number | null, decision: LogEntry["decision"]) {
    if (id == null) return;
    try {
      const e = await run<LogEntry>("log", "readonly", (s) => s.get(id));
      if (!e) return;
      e.decision = decision;
      await run("log", "readwrite", (s) => s.put(e));
    } catch {
      /* best effort */
    }
  },

  async report(days = 7): Promise<Report> {
    const since = Date.now() - days * 86_400_000;
    const all = ((await run<LogEntry[]>("log", "readonly", (s) => s.getAll())) ?? []).filter((e) => e.at >= since);
    const byLevel: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    const flags = new Map<string, number>();
    for (const e of all) {
      byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
      for (const f of e.flags) flags.set(f, (flags.get(f) ?? 0) + 1);
    }
    return {
      days,
      total: all.length,
      byLevel,
      denied: all.filter((e) => e.decision === "deny").length,
      topFlags: [...flags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
      risky: all.filter((e) => e.level === "high" || e.level === "critical").sort((a, b) => b.at - a.at).slice(0, 20),
    };
  },

  async clear(which: "counts" | "log") {
    await run(which, "readwrite", (s) => s.clear());
  },
};

export function flagsOf(risk: RiskReport | null): string[] {
  return risk ? risk.flags.map((f) => f.label) : [];
}
