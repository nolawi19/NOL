// Mochi grows with you: experience for finished sessions, passing tests,
// deploys and answered requests; levels; badges for milestones. All of it is
// counted locally from real events and kept in preferences (no server, no
// leaderboard). It never affects what Coucou does.

import { todayKey, emptyDay, type Progress } from "./prefs";
import { State } from "./state";
import { updatePrefs } from "./store";

export interface BadgeDef {
  id: string;
  title: string;
  desc: string;
}

export const BADGES: BadgeDef[] = [
  { id: "first-session", title: "Hello, Claude", desc: "Finished a first Claude Code session." },
  { id: "ten-sessions", title: "Regular", desc: "Ten finished sessions." },
  { id: "hundred-sessions", title: "Centurion", desc: "A hundred finished sessions." },
  { id: "green", title: "Green", desc: "A test run passed." },
  { id: "bug-squasher", title: "Bug squasher", desc: "Tests passed right after failing." },
  { id: "ship-it", title: "Ship it", desc: "A deploy command succeeded." },
  { id: "careful", title: "Careful", desc: "Denied a high-risk request." },
  { id: "night-owl", title: "Night owl", desc: "Finished a session after 11 pm." },
  { id: "early-bird", title: "Early bird", desc: "Finished a session before 7 am." },
  { id: "streak-3", title: "Three in a row", desc: "Sessions on three days in a row." },
  { id: "streak-7", title: "Week streak", desc: "Sessions on seven days in a row." },
  { id: "deep-work", title: "Deep work", desc: "Finished a focus timer." },
  { id: "stylist", title: "Stylist", desc: "Picked a style." },
];

export const XP = { session: 10, testsPassed: 3, deploy: 15, decision: 1, focus: 8 } as const;

export function levelOf(xp: number): number {
  return Math.floor(Math.sqrt(xp / 40)) + 1;
}

/** XP at which `level` starts. */
export function levelStart(level: number): number {
  return 40 * (level - 1) ** 2;
}

export interface Award {
  levelUp: number | null;
  badges: BadgeDef[];
}

type Listener = (a: Award) => void;
let onAward: Listener | null = null;

export function onProgress(fn: Listener) {
  onAward = fn;
}

function streak(days: string[]): number {
  let n = 0;
  const d = new Date();
  for (;;) {
    if (!days.includes(todayKey(d))) return n;
    n++;
    d.setDate(d.getDate() - 1);
  }
}

/** Applies a change to progress, then reports level-ups and new badges. */
function bump(mutate: (p: Progress) => string[]) {
  const before = State.prefs.progress;
  const beforeLevel = levelOf(before.xp);
  let earned: string[] = [];
  updatePrefs((prefs) => {
    const p = prefs.progress;
    if (p.today.date !== todayKey()) p.today = emptyDay();
    earned = mutate(p).filter((b) => !p.badges.includes(b));
    p.badges.push(...earned);
  });
  const after = State.prefs.progress;
  const level = levelOf(after.xp);
  const award: Award = {
    levelUp: level > beforeLevel ? level : null,
    badges: BADGES.filter((b) => earned.includes(b.id)),
  };
  if (award.levelUp || award.badges.length) onAward?.(award);
}

export const Progressor = {
  sessionFinished(stats: { tools: number; failures: number; files: number }) {
    bump((p) => {
      p.xp += XP.session;
      p.sessions++;
      p.today.sessions++;
      p.today.tools += stats.tools;
      p.today.failures += stats.failures;
      p.today.files += stats.files;
      const today = todayKey();
      if (p.days[0] !== today) p.days = [today, ...p.days.filter((d) => d !== today)].slice(0, 60);
      const b: string[] = ["first-session"];
      if (p.sessions >= 10) b.push("ten-sessions");
      if (p.sessions >= 100) b.push("hundred-sessions");
      const h = new Date().getHours();
      if (h >= 23) b.push("night-owl");
      if (h < 7 && h >= 4) b.push("early-bird");
      const s = streak(p.days);
      if (s >= 3) b.push("streak-3");
      if (s >= 7) b.push("streak-7");
      return b;
    });
  },

  tests(ok: boolean, afterFailure: boolean) {
    bump((p) => {
      if (!ok) {
        p.today.testsFailed++;
        return [];
      }
      p.xp += XP.testsPassed;
      p.testsPassed++;
      p.today.testsPassed++;
      return afterFailure ? ["green", "bug-squasher"] : ["green"];
    });
  },

  deploy() {
    bump((p) => {
      p.xp += XP.deploy;
      p.deploys++;
      return ["ship-it"];
    });
  },

  decision(denied: boolean, highRisk: boolean) {
    bump((p) => {
      p.xp += XP.decision;
      p.today.decisions++;
      return denied && highRisk ? ["careful"] : [];
    });
  },

  focusDone() {
    bump((p) => {
      p.xp += XP.focus;
      return ["deep-work"];
    });
  },

  styled() {
    bump(() => ["stylist"]);
  },
};
