// Time-based helpers: the focus timer, reminders, the day's recap, the
// late-night nudge, styles that follow the time of day, and a heads-up before
// a Cal.com meeting.
//
// Each uses one single-shot timer aimed at the next moment something has to
// happen — nothing ticks in the background, so an idle Coucou stays at 0 %.

import { MODES, type Mode, type Reminder, todayKey } from "./prefs";
import { State } from "./state";
import { updatePrefs } from "./store";
import { Progressor } from "./progress";
import { LINE } from "../views/icons";

export interface ScheduleHost {
  flash(text: string, color: string, important?: boolean): void;
  sound(name: string): void;
  open(view: "desk" | "insight"): void;
  setMode(mode: Mode): void;
  setStyle(n: number): void;
  recap(): void;
  yawn(): void;
}

let host: ScheduleHost | null = null;

const timers: Record<string, number | null> = { focus: null, reminder: null, recap: null, style: null, meeting: null };

function arm(key: string, at: number, fn: () => void) {
  if (timers[key] != null) window.clearTimeout(timers[key]!);
  // setTimeout can't wait longer than ~24.8 days; re-arm when it fires early.
  const delay = Math.max(0, Math.min(at - Date.now(), 2 ** 31 - 1));
  timers[key] = window.setTimeout(() => {
    timers[key] = null;
    if (Date.now() + 500 < at) arm(key, at, fn);
    else fn();
  }, delay);
}

function disarm(key: string) {
  if (timers[key] != null) window.clearTimeout(timers[key]!);
  timers[key] = null;
}

// ── Focus timer ───────────────────────────────────────────────────────────────

export interface FocusState {
  phase: "work" | "break" | null;
  endsAt: number;
  previousMode: Mode;
}

export const Focus: FocusState & {
  start(): void;
  stop(): void;
  remaining(): number;
} = {
  phase: null,
  endsAt: 0,
  previousMode: "normal",

  start() {
    const prefs = State.prefs;
    this.previousMode = prefs.mode === "focus" ? this.previousMode : prefs.mode;
    this.phase = "work";
    this.endsAt = Date.now() + prefs.focus.workMin * 60_000;
    host?.setMode("focus");
    host?.flash(`Focus for ${prefs.focus.workMin} min`, "#A78BFA", true);
    arm("focus", this.endsAt, () => {
      this.phase = "break";
      this.endsAt = Date.now() + State.prefs.focus.breakMin * 60_000;
      host?.setMode(this.previousMode);
      host?.sound("finish");
      host?.flash(`Focus done — take ${State.prefs.focus.breakMin} min`, "#34D399", true);
      Progressor.focusDone();
      arm("focus", this.endsAt, () => {
        this.phase = null;
        host?.sound("greet");
        host?.flash("Break's over", "#3B9EFF", true);
        State.notify();
      });
      State.notify();
    });
    State.notify();
  },

  stop() {
    if (this.phase === "work") host?.setMode(this.previousMode);
    this.phase = null;
    disarm("focus");
    State.notify();
  },

  remaining() {
    return this.phase ? Math.max(0, this.endsAt - Date.now()) : 0;
  },
};

// ── Reminders ─────────────────────────────────────────────────────────────────

/** "20m check the deploy", "1h30 call Sam", "at 17:30 standup", "in 2 hours stretch". */
export function parseReminder(text: string): { at: number; text: string } | null {
  const t = text.trim().replace(/^(remind( me)?|reminder)\s+/i, "");
  const now = new Date();
  let m = /^(?:at\s+)?(\d{1,2})[:h](\d{2})\s+(.+)$/i.exec(t);
  if (m) {
    const d = new Date(now);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return Number(m[1]) < 24 && Number(m[2]) < 60 ? { at: d.getTime(), text: m[3] } : null;
  }
  m = /^(?:in\s+)?(?:(\d+)\s*(?:h|hours?|hrs?))?\s*(?:(\d+)\s*(?:m|min|mins|minutes?))?\s+(?:to\s+)?(.+)$/i.exec(t);
  if (m && (m[1] || m[2])) {
    const ms = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000;
    if (ms > 0 && ms <= 7 * 86_400_000) return { at: Date.now() + ms, text: m[3] };
  }
  m = /^(?:in\s+)?(\d+)h(\d{1,2})\s+(.+)$/i.exec(t);
  if (m) return { at: Date.now() + (Number(m[1]) * 60 + Number(m[2])) * 60_000, text: m[3] };
  return null;
}

function armReminders() {
  const next = [...State.prefs.reminders].sort((a, b) => a.at - b.at)[0];
  if (!next) return disarm("reminder");
  arm("reminder", next.at, () => {
    const due = State.prefs.reminders.filter((r) => r.at <= Date.now() + 1000);
    updatePrefs((p) => (p.reminders = p.reminders.filter((r) => !due.some((d) => d.id === r.id))));
    for (const r of due) {
      // You asked for it: a reminder shows in every mode.
      host?.sound("question");
      host?.flash(`⏰ ${r.text}`, "#F5A524", true);
      State.log({ text: "Reminder", detail: r.text, tone: "alert", icon: LINE.hourglass, color: "#F5A524", cat: "session" });
    }
    host?.open("desk");
    armReminders();
  });
}

export const Reminders = {
  add(at: number, text: string): Reminder {
    const r = { id: Math.random().toString(36).slice(2, 10), at, text: text.slice(0, 140) };
    updatePrefs((p) => {
      p.reminders.push(r);
      p.reminders.sort((a, b) => a.at - b.at);
    });
    armReminders();
    return r;
  },
  remove(id: string) {
    updatePrefs((p) => (p.reminders = p.reminders.filter((r) => r.id !== id)));
    armReminders();
  },
};

// ── Recap, timed styles, night nudge ──────────────────────────────────────────

function nextAt(hour: number, minute = 0): number {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function armRecap() {
  const r = State.prefs.recap;
  if (!r.enabled) return disarm("recap");
  arm("recap", nextAt(r.hour), () => {
    host?.recap();
    armRecap();
  });
}

/** Morning 6–12, day 12–19, night 19–6. */
export function styleSlot(d = new Date()): "morning" | "day" | "night" {
  const h = d.getHours();
  return h >= 6 && h < 12 ? "morning" : h >= 12 && h < 19 ? "day" : "night";
}

function armStyle() {
  const s = State.prefs.styleSchedule;
  if (!s.enabled) return disarm("style");
  const h = new Date().getHours();
  const boundary = h < 6 ? 6 : h < 12 ? 12 : h < 19 ? 19 : 6;
  arm("style", nextAt(boundary), () => {
    const now = State.prefs.styleSchedule;
    if (now.enabled) host?.setStyle(now[styleSlot()]);
    armStyle();
  });
}

let nudgedOn = "";

export const Schedule = {
  init(h: ScheduleHost) {
    host = h;
    this.refresh();
  },

  /** Preferences changed: re-aim every timer. */
  refresh() {
    armReminders();
    armRecap();
    armStyle();
  },

  /** Applies the time-of-day style now (when turned on). */
  applyStyleNow() {
    const s = State.prefs.styleSchedule;
    if (s.enabled) host?.setStyle(s[styleSlot()]);
  },

  /** Claude Code activity: late at night, Mochi suggests a rest — once a night. */
  activity() {
    if (!State.prefs.mochi.nightNudge) return;
    const h = new Date().getHours();
    if (h < 23 && h >= 5) return;
    const night = h >= 23 ? todayKey() : todayKey(new Date(Date.now() - 86_400_000));
    if (nudgedOn === night) return;
    nudgedOn = night;
    host?.yawn();
    if (MODES[State.prefs.mode].flashes) host?.flash("It's late — Mochi thinks you've earned some rest", "#A78BFA");
  },

  /** Cal.com bookings: a heads-up ten minutes before the next one. */
  bookings(list: { title: string; start: string }[]) {
    const next = list
      .map((b) => ({ title: b.title, at: Date.parse(b.start) }))
      .filter((b) => Number.isFinite(b.at) && b.at > Date.now())
      .sort((a, b) => a.at - b.at)[0];
    if (!next) return disarm("meeting");
    arm("meeting", next.at - 10 * 60_000, () => {
      host?.sound("tick");
      host?.flash(`In 10 min: ${next.title}`, "#C9956A", true);
    });
  },
};
