// Desk, change preview, session replay, test runs and every session at once.
// All of them read real state (hook events, the OS, the user's own reminders
// and preferences); none of them can answer a permission request.

import { h, clear } from "./dom";
import { ICONS, LINE } from "./icons";
import { State } from "../core/state";
import { Desk, temp, weatherText } from "../core/desk";
import { diffLines, diffStats } from "../core/diff";
import { Focus, parseReminder, Reminders } from "../core/schedule";
import { BADGES, levelOf, levelStart } from "../core/progress";
import { Session, formatMs, type ToolRecord } from "../core/session";
import { formatCost, Sessions } from "../core/sessions";
import { COMMAND_CLASS_LABEL } from "../core/risk";
import { Memory } from "../core/memory";
import { todayKey } from "../core/prefs";
import { Guard } from "../core/guard";
import { button, clock, icon } from "./ui";
import type { ViewActions, ViewHost } from "./views";

function panel(title: string, ...extra: Node[]) {
  const body = h("div", { class: "dk-body" });
  const head = h("div", { class: "pal-head dk-head" }, h("span", { class: "cc-title", text: title }), ...extra);
  const shell = h("div", { class: "pal card fx-glass" }, head, body);
  return { shell, head, body };
}

function widget(title: string, path: string, ...children: Node[]): HTMLElement {
  return h("div", { class: "dk-w" }, h("div", { class: "dk-w-head" }, icon(path, 10, 2.2), h("span", { text: title })), ...children);
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
}

// ── Desk ──────────────────────────────────────────────────────────────────────

export function buildDesk(actions: ViewActions): ViewHost {
  const { shell, head, body } = panel("Desk");
  const holdBtn = button("Panic", "danger", () => void (Guard.hold ? actions.releaseHold() : actions.panic()), { icon: LINE.shield, title: "Deny the request on screen and send every new one to the terminal" });
  head.append(h("span", { class: "grow" }), holdBtn);

  // Clock & weather
  const time = h("b", { class: "dk-big" });
  const wx = h("span", { class: "dk-sub" });
  const clockW = widget("Now", LINE.monitor, time, wx);

  // Focus timer
  const focusTime = h("b", { class: "dk-big" });
  const focusBtn = button("Start focus", "secondary", () => (Focus.phase ? Focus.stop() : Focus.start()), { icon: LINE.eyeOff });
  const focusW = widget("Focus", LINE.hourglass, focusTime, focusBtn);

  // Reminders
  const remList = h("div", { class: "dk-list" });
  const remInput = h("input", { class: "dk-input", type: "text", placeholder: "20m check the deploy", "aria-label": "New reminder" }) as HTMLInputElement;
  remInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key !== "Enter") return;
    const r = parseReminder(remInput.value);
    if (!r) {
      remInput.classList.add("bad");
      return;
    }
    remInput.classList.remove("bad");
    remInput.value = "";
    Reminders.add(r.at, r.text);
  });
  const remW = widget("Reminders", LINE.ask, remList, remInput);

  // Next meeting (Cal.com)
  const meet = h("span", { class: "dk-sub" });
  const meetW = widget("Next meeting", LINE.activity, meet);

  // Now playing
  const song = h("b", { class: "dk-line" });
  const artist = h("span", { class: "dk-sub" });
  const ctrl = h(
    "div",
    { class: "dk-ctrl" },
    button("", "ghost", () => void Desk.media_("previous"), { icon: LINE.arrowLeft, title: "Previous" }),
    button("", "ghost", () => void Desk.media_("toggle"), { icon: ICONS.speakerOn, iconFilled: true, title: "Play / pause" }),
    button("", "ghost", () => void Desk.media_("next"), { icon: LINE.chevronRight, title: "Next" }),
  );
  const mediaW = widget("Playing", LINE.speaker, song, artist, ctrl);

  // Mochi: level, XP, pets
  const lvl = h("b", { class: "dk-line" });
  const xpBar = h("i", { class: "dk-xp" }, h("i"));
  const badges = h("span", { class: "dk-sub" });
  const pets = h(
    "div",
    { class: "dk-ctrl" },
    button("Feed", "ghost", () => actions.feed()),
    button("Pet", "ghost", () => actions.pet()),
    button("Dance", "ghost", () => actions.dance()),
  );
  const mochiW = widget("Mochi", LINE.sparkle, lvl, xpBar, badges, pets);

  // Docker
  const dockList = h("div", { class: "dk-list" });
  const dockBtn = button("Check", "ghost", () => void Desk.refreshDocker(), { icon: LINE.refresh, title: "Runs docker ps (read-only)" });
  const dockW = widget("Docker", LINE.grid, dockList, dockBtn);

  // Notes
  const noteInput = h("input", { class: "dk-input", type: "text", placeholder: "A quick note…", "aria-label": "Quick note" }) as HTMLInputElement;
  const noteMsg = h("span", { class: "dk-sub" });
  noteInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key !== "Enter" || !noteInput.value.trim()) return;
    if (!State.prefs.memory.enabled) {
      noteMsg.textContent = "Turn on memory in Settings first.";
      return;
    }
    const text = noteInput.value.trim();
    void Memory.add({ kind: "note", title: text.slice(0, 60), text, project: null }).then(() => {
      noteInput.value = "";
      noteMsg.textContent = "Saved to memory.";
    });
  });
  const noteW = widget("Note", LINE.compose, noteInput, noteMsg);

  // Today
  const todayLine = h("span", { class: "dk-sub" });
  const costLine = h("span", { class: "dk-sub" });
  const todayW = widget(
    "Today",
    LINE.checkCircle,
    todayLine,
    costLine,
    h(
      "div",
      { class: "dk-ctrl" },
      button("Recap", "ghost", () => {
        Desk.showRecap();
        actions.setView("insight");
      }),
      button("What next?", "ghost", () => actions.whatNext(), { title: "Asks Claude (uses your API key)" }),
    ),
  );

  body.classList.add("dk-grid");
  body.append(clockW, focusW, remW, mochiW, mediaW, todayW, meetW, dockW, noteW);
  const el = h("div", { class: "view desk" }, shell);
  let tick: number | null = null;

  return {
    el,
    show() {
      void Desk.refreshWeather();
      void Desk.refreshMedia();
      tick ??= window.setInterval(() => State.notify(), 1000);
    },
    hide() {
      if (tick != null) window.clearInterval(tick);
      tick = null;
    },
    sync() {
      const now = new Date();
      time.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const w = Desk.weather;
      const wp = State.prefs.weather;
      wx.textContent = !wp.enabled ? now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" })
        : w ? `${temp(w.temperature)} ${weatherText(w.code).glyph} ${weatherText(w.code).text} · ${wp.name}` : Desk.weatherError || "Weather…";

      focusTime.textContent = Focus.phase ? `${Focus.phase === "work" ? "Focus" : "Break"} ${clock(Focus.remaining())}` : `${State.prefs.focus.workMin} min`;
      (focusBtn.querySelector(".btn-label") as HTMLElement).textContent = Focus.phase ? "Stop" : "Start focus";

      const rems = State.prefs.reminders;
      const rk = rems.map((r) => r.id).join(",");
      if (remList.dataset.k !== rk) {
        remList.dataset.k = rk;
        clear(remList);
        if (!rems.length) remList.append(h("span", { class: "dk-sub", text: "None. Type “20m stretch” + Enter." }));
        for (const r of rems.slice(0, 3)) {
          const x = h("button", { class: "dk-x", type: "button", title: "Remove", text: "×" });
          x.addEventListener("click", () => Reminders.remove(r.id));
          remList.append(h("div", { class: "dk-row" }, h("span", { text: `${new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ${r.text}` }), x));
        }
      }

      const bookings = (State.integrations.integration_calcom?.data?.bookings as { title: string; start: string }[] | undefined) ?? [];
      const next = bookings.map((b) => ({ ...b, at: Date.parse(b.start) })).filter((b) => b.at > Date.now()).sort((a, b) => a.at - b.at)[0];
      meet.textContent = next
        ? `${next.title} · ${new Date(next.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
        : State.integrations.integration_calcom?.configured ? "Nothing booked." : "Connect Cal.com in Settings → Integrations.";

      const m = Desk.media;
      song.textContent = m?.title || (Desk.mediaError ? "Unavailable" : "Nothing playing");
      artist.textContent = m ? `${m.artist}${m.source ? ` · ${m.source}` : ""}${m.playing ? "" : " · paused"}` : Desk.mediaError;

      const p = State.prefs.progress;
      const level = levelOf(p.xp);
      const from = levelStart(level);
      const to = levelStart(level + 1);
      lvl.textContent = `Level ${level} · ${p.xp} XP`;
      (xpBar.firstChild as HTMLElement).style.width = `${Math.round(((p.xp - from) / (to - from)) * 100)}%`;
      badges.textContent = `${p.badges.length}/${BADGES.length} badges`;
      badges.title = BADGES.filter((b) => p.badges.includes(b.id)).map((b) => b.title).join(", ");

      const dk = Desk.docker;
      const dkey = dk ? dk.map((c) => c.name + c.state + c.health).join("|") : Desk.dockerError;
      if (dockList.dataset.k !== dkey) {
        dockList.dataset.k = dkey;
        clear(dockList);
        if (!dk) dockList.append(h("span", { class: "dk-sub", text: Desk.dockerError || "Click Check to list containers." }));
        else if (!dk.length) dockList.append(h("span", { class: "dk-sub", text: "No containers." }));
        else {
          const running = dk.filter((c) => c.state === "running").length;
          const bad = dk.filter((c) => c.health === "unhealthy" || c.state === "exited" || c.state === "dead");
          dockList.append(h("span", { class: "dk-sub", text: `${running} running · ${bad.length} need a look` }));
          for (const c of (bad.length ? bad : dk).slice(0, 2)) {
            dockList.append(h("div", { class: `dk-row ${c.health === "unhealthy" || c.state !== "running" ? "bad" : ""}` }, h("span", { text: `${c.name} · ${c.health || c.state}` })));
          }
        }
      }

      const t = p.today.date === todayKey() ? p.today : null;
      todayLine.textContent = t ? `${t.sessions} sessions · ${t.files} files · ${t.testsPassed}✓ ${t.testsFailed}✗` : "Nothing finished yet today.";
      const cost = Sessions.totalCost;
      costLine.textContent = cost != null ? `Claude Code ${formatCost(cost)}` : "";

      (holdBtn.querySelector(".btn-label") as HTMLElement).textContent = Guard.hold ? "Release hold" : "Panic";
      holdBtn.classList.toggle("btn-danger", !Guard.hold);
      holdBtn.classList.toggle("btn-secondary", Guard.hold);
    },
  };
}

// ── Change preview ────────────────────────────────────────────────────────────

export function buildDiff(actions: ViewActions): ViewHost {
  const name = h("span", { class: "df-file" });
  const stats = h("span", { class: "df-stats" });
  const prev = button("", "ghost", () => step(-1), { icon: LINE.arrowLeft, title: "Previous change" });
  const next = button("", "ghost", () => step(1), { icon: LINE.chevronRight, title: "Next change" });
  const { shell, head, body } = panel("Change", name, stats, h("span", { class: "grow" }), prev, next);
  void head;
  body.classList.add("df-body");
  const el = h("div", { class: "view diff" }, shell);
  let shown = "";

  function list(): ToolRecord[] {
    return Session.changes;
  }

  function current(): ToolRecord | null {
    const all = list();
    return all.find((r) => r.id === Desk.diffRef) ?? all.at(-1) ?? null;
  }

  function step(d: number) {
    const all = list();
    const i = all.findIndex((r) => r.id === current()?.id);
    const n = all[Math.max(0, Math.min(all.length - 1, i + d))];
    if (n) {
      Desk.diffRef = n.id;
      State.notify();
    }
  }

  return {
    el,
    sync() {
      const rec = current();
      const key = rec ? rec.id : "none";
      const all = list();
      const i = rec ? all.indexOf(rec) : -1;
      prev.disabled = i <= 0;
      next.disabled = i < 0 || i >= all.length - 1;
      if (key === shown) return;
      shown = key;
      clear(body);
      if (!rec?.change) {
        name.textContent = "";
        stats.textContent = "";
        body.append(h("div", { class: "tl-empty" }, icon(LINE.compose, 14, 2), h("span", { text: "No file changes yet. When Claude edits or writes a file, the change appears here, line by line." })));
        return;
      }
      const c = rec.change;
      name.textContent = basename(c.file);
      name.title = c.file;
      const lines = diffLines(c.before, c.after);
      const st = diffStats(lines);
      stats.textContent = `${c.kind === "write" ? "new contents · " : ""}+${st.added} −${st.removed}${c.truncated ? " · cut at 2,000 chars" : ""} · ${i + 1}/${all.length}`;
      const pre = h("div", { class: "df-code" });
      for (const l of lines.slice(0, 400)) {
        pre.append(h("div", { class: `df-l ${l.kind}` }, h("i", { text: l.kind === "add" ? "+" : l.kind === "del" ? "−" : " " }), h("span", { text: l.text || " " })));
      }
      body.append(pre);
      void actions;
    },
  };
}

// ── Session replay ────────────────────────────────────────────────────────────

export function buildReplay(actions: ViewActions): ViewHost {
  const pos = h("span", { class: "df-stats" });
  const playBtn = button("Play", "secondary", () => toggle());
  const range = h("input", { class: "rp-range", type: "range", min: "0", max: "0", value: "0", "aria-label": "Step" }) as HTMLInputElement;
  const { shell, head, body } = panel("Replay", pos, h("span", { class: "grow" }), playBtn);
  void head;
  const card = h("div", { class: "rp-card" });
  body.append(range, card);
  const el = h("div", { class: "view replay" }, shell);
  let i = 0;
  let timer: number | null = null;

  range.addEventListener("input", () => {
    i = Number(range.value);
    State.notify();
  });

  function toggle() {
    if (timer != null) return stop();
    if (i >= Session.records.length - 1) i = 0;
    timer = window.setInterval(() => {
      if (i >= Session.records.length - 1) return stop();
      i++;
      State.notify();
    }, 900);
    State.notify();
  }

  function stop() {
    if (timer != null) window.clearInterval(timer);
    timer = null;
    State.notify();
  }

  return {
    el,
    show() {
      i = 0;
    },
    hide() {
      stop();
    },
    sync() {
      const recs = Session.records;
      range.max = String(Math.max(0, recs.length - 1));
      range.value = String(i);
      range.disabled = recs.length < 2;
      (playBtn.querySelector(".btn-label") as HTMLElement).textContent = timer != null ? "Pause" : "Play";
      pos.textContent = recs.length ? `step ${i + 1} of ${recs.length}` : "";
      clear(card);
      const r = recs[i];
      if (!r) {
        card.append(h("div", { class: "tl-empty" }, icon(LINE.activity, 14, 2), h("span", { text: "Nothing to replay yet: every tool call of the session (up to 200) can be stepped through here." })));
        return;
      }
      const t0 = recs[0].start;
      card.append(
        h("div", { class: "rp-step", "data-o": r.outcome },
          h("b", { text: `${r.commandClass ? COMMAND_CLASS_LABEL[r.commandClass] : r.tool}` }),
          h("span", { class: "rp-at", text: `+${formatMs(r.start - t0)}${r.end ? ` · took ${formatMs(r.end - r.start)}` : ""}` }),
        ),
        h("div", { class: "code rp-target", text: r.target || r.tool }),
      );
      if (r.error) card.append(h("div", { class: "rp-err", text: r.error }));
      if (r.change) card.append(button("Show the change", "ghost", () => actions.openDiff(r.id), { icon: LINE.compose }));
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

export function buildTests(actions: ViewActions): ViewHost {
  const summary = h("span", { class: "df-stats" });
  const { shell, body } = panel("Tests", summary);
  const el = h("div", { class: "view tests" }, shell);
  void actions;
  return {
    el,
    sync() {
      const runs = Session.tests;
      const pass = runs.filter((r) => r.ok).length;
      summary.textContent = runs.length ? `${pass} passed · ${runs.length - pass} failed · last ${runs.length}` : "";
      const key = runs.map((r) => r.start).join(",");
      if (body.dataset.k === key) return;
      body.dataset.k = key;
      clear(body);
      if (!runs.length) {
        body.append(h("div", { class: "tl-empty" }, icon(LINE.checkCircle, 14, 2), h("span", { text: "No test runs yet. npm test, cargo test, pytest… run by Claude Code show up here with their time and the first error." })));
        return;
      }
      // The first failure after a pass: where it broke.
      let broke = -1;
      for (let k = runs.length - 1; k > 0; k--) if (runs[k].ok && !runs[k - 1].ok) broke = k - 1;
      const bars = h("div", { class: "ts-bars", title: "Oldest → newest" }, ...[...runs].reverse().map((r) => h("i", { class: r.ok ? "ok" : "bad", title: `${r.ok ? "Passed" : "Failed"} · ${formatMs(r.end - r.start)}` })));
      body.append(bars);
      runs.slice(0, 10).forEach((r, k) => {
        body.append(
          h(
            "div",
            { class: `tl-row ts-row ${r.ok ? "ok" : "bad"}`, style: `--c:${r.ok ? "#34D399" : "#F4505E"}` },
            h("span", { class: "tl-icon" }, icon(r.ok ? LINE.check : LINE.x, 10, 2.4)),
            h("span", { class: "tl-text" }, h("b", { text: `${r.command.slice(0, 70)}${k === broke ? "  ← first failure" : ""}` }), h("span", { text: r.ok ? `${r.project} · passed` : r.error ?? "failed" })),
            h("time", { class: "tl-ago", text: formatMs(r.end - r.start) }),
          ),
        );
      });
    },
  };
}

// ── Every session ─────────────────────────────────────────────────────────────

export function buildSessions(actions: ViewActions): ViewHost {
  const total = h("span", { class: "df-stats" });
  const { shell, body } = panel("Sessions", total);
  body.classList.add("ss-grid");
  const el = h("div", { class: "view sessions" }, shell);
  let tick: number | null = null;
  const STATE_LABEL: Record<string, string> = {
    working: "Working", thinking: "Thinking", approval: "Needs permission", question: "Asking", finished: "Finished", error: "Error", idle: "Idle",
  };
  return {
    el,
    show() {
      tick ??= window.setInterval(() => State.notify(), 5000);
    },
    hide() {
      if (tick != null) window.clearInterval(tick);
      tick = null;
    },
    sync() {
      const list = Sessions.list;
      const cost = Sessions.totalCost;
      total.textContent = `${list.length} session${list.length === 1 ? "" : "s"}${cost != null ? ` · ${formatCost(cost)}` : ""}`;
      clear(body);
      if (!list.length) {
        body.append(h("div", { class: "tl-empty" }, icon(LINE.terminal, 14, 2), h("span", { text: "No Claude Code session yet. Each terminal gets its own card here — two projects at once show side by side." })));
        return;
      }
      for (const s of list.slice(0, 6)) {
        const card = h(
          "button",
          { class: "ss-card", type: "button", "data-state": s.state, style: `--c:${s.color}`, title: s.cwd },
          h("div", { class: "ss-top" }, h("i", { class: "ss-mochi" }), h("b", { text: s.project }), h("span", { class: "ss-state", text: STATE_LABEL[s.state] ?? s.state })),
          h("span", { class: "ss-step", text: s.lastStep || "—" }),
          h("span", { class: "ss-meta", text: [`${s.tools} tools`, s.failures ? `${s.failures} failed` : "", s.cost != null ? formatCost(s.cost) : "", s.model, s.bigContext ? "> 200k context" : ""].filter(Boolean).join(" · ") }),
        );
        card.addEventListener("click", () => actions.setView("overview"));
        body.append(card);
      }
    },
  };
}
