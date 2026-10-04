// The Desk: clock, weather, what's playing, Docker, the day's numbers and the
// recap. Everything is fetched on request — when the Desk is on screen, or
// for the compact clock every 15 minutes at most — never polled in the
// background while the island is hidden.

import { Bridge, IS_TAURI, type Container, type NowPlaying, type WeatherNow } from "./bridge";
import { Insight } from "./insight";
import { todayKey } from "./prefs";
import { localSummary, Session, summaryPrompt } from "./session";
import { formatCost, Sessions } from "./sessions";
import { State } from "./state";
import { levelOf } from "./progress";

/** WMO weather codes (Open-Meteo) → a word and a glyph. */
export function weatherText(code: number): { text: string; glyph: string } {
  if (code === 0) return { text: "Clear", glyph: "☀" };
  if (code <= 2) return { text: "Partly cloudy", glyph: "⛅" };
  if (code === 3) return { text: "Overcast", glyph: "☁" };
  if (code === 45 || code === 48) return { text: "Fog", glyph: "🌫" };
  if (code >= 51 && code <= 57) return { text: "Drizzle", glyph: "🌦" };
  if (code >= 61 && code <= 67) return { text: "Rain", glyph: "🌧" };
  if (code >= 71 && code <= 77) return { text: "Snow", glyph: "❄" };
  if (code >= 80 && code <= 82) return { text: "Showers", glyph: "🌦" };
  if (code >= 85 && code <= 86) return { text: "Snow showers", glyph: "🌨" };
  if (code >= 95) return { text: "Thunderstorm", glyph: "⛈" };
  return { text: "—", glyph: "·" };
}

export function temp(c: number): string {
  return State.prefs.weather.unit === "f" ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°`;
}

const WEATHER_EVERY = 15 * 60_000;

export const Desk = {
  /** The change the diff view shows (a tool record id), or null for the latest. */
  diffRef: null as string | null,
  weather: null as WeatherNow | null,
  weatherAt: 0,
  weatherError: "",
  media: null as NowPlaying | null,
  mediaError: "",
  docker: null as Container[] | null,
  dockerError: "",

  clockLine(): string {
    const now = new Date();
    const t = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    void this.refreshWeather();
    const w = this.weather;
    return w ? `${t} · ${temp(w.temperature)} ${weatherText(w.code).glyph}` : t;
  },

  async refreshWeather(force = false) {
    const p = State.prefs.weather;
    if (!p.enabled || !p.name || !IS_TAURI) return;
    if (!force && Date.now() - this.weatherAt < WEATHER_EVERY) return;
    this.weatherAt = Date.now();
    try {
      this.weather = await Bridge.weatherNow(p.lat, p.lon);
      this.weatherError = "";
    } catch (err) {
      this.weatherError = String((err as Error)?.message ?? err);
    }
    State.notify();
  },

  async refreshMedia() {
    if (!IS_TAURI) return;
    try {
      this.media = await Bridge.nowPlaying();
      this.mediaError = "";
    } catch (err) {
      this.mediaError = String((err as Error)?.message ?? err);
    }
    State.notify();
  },

  async media_(action: "toggle" | "next" | "previous") {
    try {
      await Bridge.mediaControl(action);
      window.setTimeout(() => void this.refreshMedia(), 400);
    } catch (err) {
      this.mediaError = String((err as Error)?.message ?? err);
      State.notify();
    }
  },

  async refreshDocker() {
    if (!IS_TAURI) {
      this.dockerError = "Only inside the app.";
      State.notify();
      return;
    }
    try {
      this.docker = await Bridge.dockerContainers();
      this.dockerError = "";
    } catch (err) {
      this.docker = null;
      this.dockerError = String((err as Error)?.message ?? err);
    }
    State.notify();
  },

  /** The day, written locally from the counters. */
  recapText(): string {
    const p = State.prefs.progress;
    const t = p.today.date === todayKey() ? p.today : null;
    const lines = [
      `Today — ${new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}`,
      t
        ? `${t.sessions} session${t.sessions === 1 ? "" : "s"} finished · ${t.tools} tool calls · ${t.files} files changed · ${t.failures} failures`
        : "No finished Claude Code session yet today.",
    ];
    if (t && (t.testsPassed || t.testsFailed)) lines.push(`Tests: ${t.testsPassed} passed, ${t.testsFailed} failed`);
    if (t?.decisions) lines.push(`${t.decisions} permission request${t.decisions === 1 ? "" : "s"} answered`);
    const cost = Sessions.totalCost;
    if (cost != null) lines.push(`Claude Code cost (open sessions): ${formatCost(cost)}`);
    lines.push(`Level ${levelOf(p.xp)} · ${p.xp} XP · ${p.badges.length} badge${p.badges.length === 1 ? "" : "s"}`);
    const recent = State.timeline.filter((e) => e.cat === "session" && e.text === "Finished").slice(0, 5);
    for (const e of recent) lines.push(`✓ ${e.project ?? "Session"}${e.detail ? ` — ${e.detail.slice(0, 90)}` : ""}`);
    return lines.join("\n");
  },

  showRecap() {
    Insight.current = { status: "ready", kind: "summary", title: "Your day", text: this.recapText(), project: null, at: Date.now() };
    State.notify();
  },

  /** "What should I do next?" — Claude reads the recent activity. */
  async next(): Promise<string> {
    const snap = Session.snapshot();
    const lines = State.timeline.slice(0, 30).map((e) => `${e.text}${e.detail ? ` — ${e.detail.slice(0, 140)}` : ""}`);
    const tests = Session.tests.slice(0, 5).map((t) => `${t.ok ? "PASS" : "FAIL"} ${t.command}${t.error ? ` — ${t.error}` : ""}`);
    const prompt = [
      "Based on this developer's recent Claude Code activity, suggest the single most useful next step, then up to two alternatives.",
      "Be specific to what's below; say if there isn't enough to go on. Plain text, at most 6 lines.",
      "",
      localSummary(snap),
      "",
      tests.length ? `Recent test runs:\n${tests.join("\n")}` : "",
      "",
      summaryPrompt(snap, lines).split("\n").slice(-30).join("\n"),
    ].join("\n");
    return Insight.run("summary", "What next?", prompt, snap.project || null);
  },
};
