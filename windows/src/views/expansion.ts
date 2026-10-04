// The views added with the expansion: the command palette, the full
// timeline, Claude's insights, and the startup check.
//
// Same rules as every other view: everything listed is real state, every
// command does what it says (or isn't listed), and nothing here answers a
// permission request.

import { h, clear } from "./dom";
import { ICONS, LINE } from "./icons";
import { State, type TimelineCat, type TimelineEntry } from "../core/state";
import { Bridge, IS_TAURI, sendTo } from "../core/bridge";
import { Insight } from "../core/insight";
import { MODES, MODE_ORDER } from "../core/prefs";
import { Focus, parseReminder, Reminders } from "../core/schedule";
import { Guard } from "../core/guard";
import { Sessions } from "../core/sessions";
import { Desk } from "../core/desk";
import { styleFromWallpaper } from "../core/wallpaper";
import { updatePrefs } from "../core/store";
import { formatStyleNumber, numberOfStyle, randomStyleNumber, STYLE_COUNT, styleFromNumber, themeInfo } from "../core/styles";
import { Session, WORK_MODE_LABEL, localSummary } from "../core/session";
import { button, card, icon, setIcon } from "./ui";
import type { ViewActions, ViewHost } from "./views";

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return new Date(at).toLocaleDateString();
}

/** Keys typed into a field must not reach the island's Escape-to-collapse. */
function fieldKeys(input: HTMLInputElement, onKey: (e: KeyboardEvent) => void) {
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    onKey(e);
  });
}

// ── Command palette ───────────────────────────────────────────────────────────

export interface PaletteCommand {
  id: string;
  title: string;
  group: string;
  icon: string;
  /** Extra words that should find it. */
  keywords?: string;
  hint?: string;
  run(): void;
}

/** Subsequence match with a bonus for word starts and contiguous runs. */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 100 - direct + (direct === 0 || /\W/.test(t[direct - 1]) ? 40 : 0);
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return 0;
    run = at === ti ? run + 1 : 0;
    score += 1 + run * 2 + (at === 0 || /\W/.test(t[at - 1]) ? 4 : 0);
    ti = at + 1;
  }
  // Scattered letters ("time" in "seTtIngs · MEmory") aren't a match.
  return score >= q.length * 3 ? score : 0;
}

function paletteCommands(actions: ViewActions, query = ""): PaletteCommand[] {
  const list: PaletteCommand[] = [];
  const add = (c: PaletteCommand) => list.push(c);
  // "#123456" (or just the digits) jumps straight to that style.
  const jump = /^#?(\d{1,6})$/.exec(query.trim());
  if (jump) {
    const n = Number(jump[1]);
    add({ id: "style-jump", title: `Style ${formatStyleNumber(n)}`, group: "Style", icon: LINE.sparkle, keywords: query, hint: themeInfo(styleFromNumber(n).theme).name, run: () => actions.setStyle(n) });
  }
  const claude = State.tasks.find((t) => t.id === "integration_claude");
  const session = claude && (claude.state !== "idle" || claude.steps.length > 0);

  if (State.pendingApproval) {
    add({ id: "approval", title: "Show the permission request", group: "Now", icon: LINE.shield, hint: State.pendingApproval.tool, run: () => actions.setView("approval") });
  }
  // Typed shortcuts: "remind 20m stretch", "note buy milk".
  const rem = /^remind(?:er)?\s+(.+)$/i.exec(query.trim());
  if (rem) {
    const r = parseReminder(rem[1]);
    if (r) add({ id: "remind", title: `Remind me “${r.text}”`, group: "Reminder", icon: LINE.hourglass, keywords: query, hint: new Date(r.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }), run: () => { Reminders.add(r.at, r.text); State.showFlash(`Reminder set · ${r.text}`, "#F5A524", "info", 3000, true); } });
  }
  const note = /^note\s+(.+)$/i.exec(query.trim());
  if (note) {
    add({ id: "note", title: `Save note “${note[1].slice(0, 40)}”`, group: "Memory", icon: LINE.compose, keywords: query, hint: State.prefs.memory.enabled ? "Memory" : "Turn on memory first", run: () => {
      if (!State.prefs.memory.enabled) return actions.openSettingsPage("memory");
      void actions.saveToMemory("note", note[1].slice(0, 60), note[1], null);
    } });
  }
  if (Guard.hold) add({ id: "release", title: "Release hold", group: "Now", icon: LINE.shieldCheck, keywords: "panic hold", run: () => actions.releaseHold() });
  else add({ id: "panic", title: "Panic: deny and hold every request", group: "Safety", icon: LINE.shield, keywords: "stop emergency hold deny", hint: "Requests go to the terminal", run: () => void actions.panic() });

  add({ id: "overview", title: "Overview", group: "Go to", icon: ICONS.house, keywords: "home sessions", run: () => actions.setView(State.defaultView()) });
  add({ id: "chat", title: "Ask Claude", group: "Go to", icon: LINE.compose, keywords: "chat prompt question", run: () => actions.setView("prompt") });
  add({ id: "center", title: "Command center", group: "Go to", icon: LINE.grid, keywords: "mission control dashboard system", run: () => actions.setView("center") });
  add({ id: "timeline", title: "Timeline", group: "Go to", icon: LINE.activity, keywords: "history events log activity", run: () => actions.setView("timeline") });
  add({ id: "desk", title: "Desk", group: "Go to", icon: ICONS.timer, keywords: "focus pomodoro reminders music weather clock docker mochi", run: () => actions.setView("desk") });
  add({ id: "sessions", title: "All sessions", group: "Go to", icon: LINE.terminal, keywords: "terminals projects cost", hint: Sessions.list.length ? `${Sessions.list.length} open` : undefined, run: () => actions.setView("sessions") });
  add({ id: "tests", title: "Test runs", group: "Go to", icon: LINE.checkCircle, keywords: "tests dashboard pass fail", run: () => actions.setView("tests") });
  add({ id: "replay", title: "Replay the session", group: "Go to", icon: LINE.activity, keywords: "replay history steps", run: () => actions.setView("replay") });
  add({ id: "diff", title: "Show the last change", group: "Go to", icon: LINE.compose, keywords: "diff edit file preview", run: () => actions.openDiff() });
  add({ id: "drop", title: "Drop a file", group: "Go to", icon: LINE.upload, keywords: "upload attach", run: () => actions.setView("upload") });
  if (Insight.current.status !== "idle") {
    add({ id: "insight", title: "Last answer from Claude", group: "Go to", icon: LINE.sparkle, hint: Insight.current.title, run: () => actions.setView("insight") });
  }
  add({ id: "quick", title: "Quick settings", group: "Go to", icon: ICONS.gear, run: () => actions.setView("settings") });

  if (session) {
    add({ id: "summarize", title: "Summarize this session with Claude", group: "Claude Code", icon: LINE.sparkle, keywords: "summary recap ai", hint: "Uses your API key", run: () => actions.summarizeSession() });
    add({ id: "copy-summary", title: "Copy a session summary", group: "Claude Code", icon: LINE.copy, keywords: "clipboard recap", hint: "Written locally", run: () => void navigator.clipboard?.writeText(localSummary(Session.snapshot())).then(() => State.showFlash("Session summary copied", "#34D399", "success", 3000, true)) });
  }
  if (claude?.sessionCwd) {
    add({ id: "vscode", title: "Open the project in VS Code", group: "Claude Code", icon: LINE.external, hint: claude.name, run: () => actions.openTerminal() });
  }
  add({ id: "clipboard", title: "Ask Claude about the clipboard", group: "Chat", icon: LINE.copy, keywords: "paste explain clipboard", run: () => void actions.askClipboard() });
  add({ id: "next", title: "What should I do next?", group: "Claude Code", icon: LINE.sparkle, keywords: "suggest advice next step", hint: "Uses your API key", run: () => actions.whatNext() });
  add({ id: "focus", title: Focus.phase ? "Stop the focus timer" : `Start a ${State.prefs.focus.workMin}-minute focus`, group: "Desk", icon: LINE.hourglass, keywords: "pomodoro focus timer", run: () => (Focus.phase ? Focus.stop() : Focus.start()) });
  add({ id: "media", title: "Play / pause music", group: "Desk", icon: ICONS.speakerOn, keywords: "spotify music media pause play", run: () => void Desk.media_("toggle") });
  add({ id: "media-next", title: "Next track", group: "Desk", icon: LINE.chevronRight, keywords: "spotify music skip", run: () => void Desk.media_("next") });
  add({ id: "recap", title: "Today's recap", group: "Desk", icon: LINE.checkCircle, keywords: "daily summary day", run: () => { Desk.showRecap(); actions.setView("insight"); } });
  add({ id: "feed", title: "Feed Mochi", group: "Mochi", icon: LINE.sparkle, keywords: "pet snack", run: () => actions.feed() });
  add({ id: "pet", title: "Pet Mochi", group: "Mochi", icon: LINE.sparkle, keywords: "love", run: () => actions.pet() });
  add({ id: "dance", title: "Make Mochi dance", group: "Mochi", icon: LINE.sparkle, keywords: "party fun", run: () => actions.dance() });
  if (State.chatHistory.length) add({ id: "new-chat", title: "New conversation", group: "Chat", icon: LINE.refresh, keywords: "reset clear chat", run: () => actions.newChat() });

  for (const m of MODE_ORDER) {
    if (m === State.prefs.mode) continue;
    add({ id: `mode-${m}`, title: `${MODES[m].title} mode`, group: "Mode", icon: m === "night" ? LINE.moon : m === "silent" ? ICONS.speakerOff : m === "focus" ? LINE.eyeOff : m === "presentation" ? LINE.screen : LINE.sparkle, keywords: "mode dnd do not disturb quiet", hint: MODES[m].desc.split(".")[0], run: () => actions.setMode(m) });
  }
  {
    const spec = State.prefs.style.spec;
    const num = spec ? numberOfStyle(spec) : null;
    add({ id: "style-random", title: "Random style", group: "Style", icon: LINE.sparkle, keywords: "theme colors look shuffle surprise", hint: `${STYLE_COUNT.toLocaleString()} styles`, run: () => actions.setStyle(randomStyleNumber()) });
    if (num != null) {
      add({ id: "style-next", title: "Next style", group: "Style", icon: LINE.chevronRight, keywords: "theme", hint: formatStyleNumber((num + 1) % STYLE_COUNT), run: () => actions.setStyle((num + 1) % STYLE_COUNT) });
    }
    add({ id: "style-wallpaper", title: "Match my wallpaper", group: "Style", icon: LINE.screen, keywords: "theme colors desktop background", hint: "Reads the wallpaper on this computer", run: () => {
      void styleFromWallpaper()
        .then((spec) => {
          updatePrefs((p) => (p.style.spec = spec));
          State.showFlash(`Matched your wallpaper · ${themeInfo(spec.theme).name}`, "#A78BFA", "info", 3500, true);
        })
        .catch((err) => State.showFlash(String((err as Error)?.message ?? err), "#F4505E", "error", 4000, true));
    } });
    if (spec) add({ id: "style-copy", title: "Copy this style's number", group: "Style", icon: LINE.copy, keywords: "share", hint: num != null ? formatStyleNumber(num) : "custom styles have no number", run: () => {
      if (num != null) void navigator.clipboard?.writeText(`Coucou style ${formatStyleNumber(num)}`);
    } });
    if (spec) add({ id: "style-default", title: "Coucou's own style", group: "Style", icon: LINE.refresh, keywords: "theme reset default", run: () => actions.setStyle(null) });
  }
  add({ id: "sound", title: State.settings.soundEnabled ? "Mute sounds" : "Unmute sounds", group: "Island", icon: State.settings.soundEnabled ? ICONS.speakerOff : ICONS.speakerOn, keywords: "audio volume", run: () => actions.toggleSound() });
  add({ id: "collapse", title: "Collapse the island", group: "Island", icon: LINE.chevronUp, keywords: "close small minimise", run: () => actions.collapse() });
  add({ id: "hide", title: "Hide the island", group: "Island", icon: LINE.retract, keywords: "close away", run: () => actions.hide() });

  if (State.screen.active) {
    add({ id: "screen-stop", title: "Stop screen access", group: "Screen", icon: LINE.eyeOff, keywords: "share capture", run: () => void sendTo("settings", "screen-share-stop", null) });
  } else {
    add({ id: "screen", title: "Share the screen with Coucou…", group: "Screen", icon: LINE.screen, keywords: "capture see", hint: "Asks first", run: () => actions.openSettingsPage("screen") });
  }

  for (const id of State.settings.activeIntegrations) {
    const t = State.tasks.find((x) => x.id === id);
    if (t && State.integrations[id]?.configured) {
      add({ id: `refresh-${id}`, title: `Refresh ${t.name}`, group: "Integrations", icon: LINE.refresh, run: () => actions.refreshIntegration(id) });
    }
  }

  const pages: [string, string, string, string][] = [
    ["claude-code", "Claude Code hooks", LINE.terminal, "install hooks"],
    ["claude", "Claude API key and model", LINE.key, "anthropic key model"],
    ["integrations", "Integrations", LINE.plug, "vercel github stripe n8n"],
    ["modes", "Modes", LINE.moon, "focus silent presentation night"],
    ["appearance", "Appearance", LINE.sparkle, "glass glow particles motion core"],
    ["styles", "Styles", LINE.sparkle, "theme themes palette colors look wallpaper"],
    ["desk", "Desk & Mochi", ICONS.timer, "focus weather reminders recap outfit skin texture budget cost"],
    ["sound", "Sounds", LINE.speaker, "audio events volume"],
    ["automations", "Automations", LINE.bolt, "rules triggers webhook"],
    ["memory", "Memory", LINE.folder, "notes summaries"],
    ["permissions", "Security center", LINE.shield, "permissions grants capabilities"],
    ["devices", "Devices", LINE.phone, "phone pairing handoff"],
    ["about", "About and privacy", LINE.info, "version log"],
  ];
  for (const [page, title, path, kw] of pages) {
    add({ id: `settings-${page}`, title: `Settings · ${title}`, group: "Settings", icon: path, keywords: kw, run: () => actions.openSettingsPage(page) });
  }
  add({ id: "intro", title: "Replay the introduction", group: "Help", icon: LINE.sparkle, keywords: "welcome tour onboarding", run: () => actions.setView("welcome") });
  return list;
}

export function buildPalette(actions: ViewActions): ViewHost {
  const input = h("input", {
    class: "pal-input",
    type: "text",
    placeholder: "Type a command…",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": "Command",
  }) as HTMLInputElement;
  const list = h("div", { class: "pal-list", role: "listbox" });
  const head = h(
    "div",
    { class: "pal-head" },
    h("span", { class: "pal-glyph" }, icon(LINE.search, 12, 2.2)),
    input,
    h("kbd", { text: "Esc" }),
  );
  const shell = h("div", { class: "pal card fx-glass" }, head, list);
  const el = h("div", { class: "view palette" }, shell);

  let items: PaletteCommand[] = [];
  let index = 0;

  function render() {
    const q = input.value.trim();
    const scored = paletteCommands(actions, q)
      .map((c) => ({ c, s: Math.max(fuzzyScore(q, c.title) * 1.5, fuzzyScore(q, `${c.group} ${c.keywords ?? ""}`)) }))
      .filter((x) => x.s > 0);
    if (q) scored.sort((a, b) => b.s - a.s);
    items = scored.map((x) => x.c);
    index = Math.min(index, Math.max(0, items.length - 1));
    clear(list);
    if (items.length === 0) {
      list.append(h("div", { class: "pal-empty", text: `Nothing matches “${q}”.` }));
      return;
    }
    let group = "";
    items.forEach((c, i) => {
      if (!q && c.group !== group) {
        group = c.group;
        list.append(h("div", { class: "pal-group", text: group }));
      }
      const row = h(
        "button",
        { class: i === index ? "pal-row on" : "pal-row", type: "button", role: "option", "aria-selected": String(i === index), "data-i": String(i) },
        h("span", { class: "pal-icon" }, icon(c.icon, 11, 2)),
        h("span", { class: "pal-title", text: c.title }),
        c.hint ? h("span", { class: "pal-hint", text: c.hint }) : null,
        q ? h("span", { class: "pal-tag", text: c.group }) : null,
      );
      row.addEventListener("mousemove", () => select(i, false));
      row.addEventListener("click", () => run(i));
      list.append(row);
    });
  }

  function select(i: number, scroll = true) {
    if (i === index) return;
    index = i;
    for (const r of list.querySelectorAll<HTMLElement>(".pal-row")) {
      const on = Number(r.dataset.i) === index;
      r.classList.toggle("on", on);
      r.setAttribute("aria-selected", String(on));
      if (on && scroll) r.scrollIntoView({ block: "nearest" });
    }
  }

  function run(i: number) {
    const c = items[i];
    if (!c) return;
    actions.blip();
    input.value = "";
    c.run();
  }

  input.addEventListener("input", () => {
    index = 0;
    render();
  });
  fieldKeys(input, (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      select(Math.min(items.length - 1, index + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      select(Math.max(0, index - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(index);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (input.value) {
        input.value = "";
        render();
      } else actions.setView(State.defaultView());
    }
  });

  return {
    el,
    show() {
      index = 0;
      input.value = "";
      render();
    },
    focus() {
      input.focus();
    },
    sync() {},
  };
}

// ── Timeline ──────────────────────────────────────────────────────────────────

const FILTERS: { id: "all" | TimelineCat | "claude"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "claude", label: "Claude Code" },
  { id: "permission", label: "Permissions" },
  { id: "error", label: "Errors" },
  { id: "integration", label: "Integrations" },
  { id: "chat", label: "Chat" },
  { id: "automation", label: "Automations" },
];

function passes(e: TimelineEntry, filter: (typeof FILTERS)[number]["id"], q: string): boolean {
  if (filter === "claude" && !(e.cat === "session" || e.cat === "tool")) return false;
  if (filter !== "all" && filter !== "claude" && e.cat !== filter) return false;
  if (!q) return true;
  return `${e.text} ${e.detail ?? ""} ${e.project ?? ""}`.toLowerCase().includes(q);
}

function timelineRow(e: TimelineEntry, open?: (ref: string) => void): HTMLElement {
  const row = h(
    "div",
    { class: e.ref ? "tl-row has-ref" : "tl-row", "data-tone": e.tone, style: `--c:${e.color}`, title: e.ref ? "Show the change" : new Date(e.at).toLocaleString() },
    h("span", { class: "tl-icon" }, icon(e.icon, 10, 2.2)),
    h("span", { class: "tl-text" }, h("b", { text: e.text }), e.detail ? h("span", { text: e.detail }) : null),
    h("time", { class: "tl-ago", "data-at": String(e.at), text: ago(e.at) }),
  );
  if (e.ref && open) row.addEventListener("click", () => open(e.ref!));
  return row;
}

export function buildTimeline(actions: ViewActions): ViewHost {
  const input = h("input", { class: "tlv-search", type: "search", placeholder: "Search events", spellcheck: "false", "aria-label": "Search the timeline" }) as HTMLInputElement;
  const count = h("span", { class: "tlv-count" });
  const groupBtn = h("button", { class: "tlv-group-btn", type: "button", title: "Group by project" }, icon(LINE.folder, 11, 2), h("span", { text: "By project" }));
  const head = h("div", { class: "tlv-head" }, h("span", { class: "cc-title", text: "Timeline" }), input, count, groupBtn);
  const chips = h("div", { class: "tlv-chips", role: "tablist" });
  const list = h("div", { class: "tl-list tlv-list" });
  const shell = h("div", { class: "tlv card fx-glass" }, head, chips, list);
  const el = h("div", { class: "view timeline" }, shell);

  let filter: (typeof FILTERS)[number]["id"] = "all";
  let grouped = false;
  let key = "";
  let clockTimer: number | null = null;

  const chipEls = FILTERS.map((f) => {
    const b = h("button", { class: "tlv-chip", type: "button", role: "tab", text: f.label });
    b.addEventListener("click", () => {
      filter = f.id;
      key = "";
      draw();
    });
    chips.append(b);
    return b;
  });
  groupBtn.addEventListener("click", () => {
    grouped = !grouped;
    key = "";
    draw();
  });
  input.addEventListener("input", () => draw());
  fieldKeys(input, (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (input.value) {
        input.value = "";
        draw();
      } else actions.setView("center");
    }
  });

  function draw() {
    const q = input.value.trim().toLowerCase();
    const entries = State.timeline.filter((e) => passes(e, filter, q));
    const k = `${filter}|${grouped}|${q}|${entries.map((e) => e.id).join(",")}`;
    chipEls.forEach((b, i) => {
      const on = FILTERS[i].id === filter;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    });
    groupBtn.classList.toggle("on", grouped);
    count.textContent = `${entries.length}`;
    if (k === key) return;
    key = k;
    clear(list);
    if (entries.length === 0) {
      list.append(h("div", { class: "tl-empty" }, icon(LINE.activity, 14, 2), h("span", { text: State.timeline.length ? "No event matches." : "Nothing yet. Hook events, permission decisions, integrations, chats and automations appear here." })));
      return;
    }
    if (!grouped) {
      for (const e of entries.slice(0, 120)) list.append(timelineRow(e, (r) => actions.openDiff(r)));
      return;
    }
    const groups = new Map<string, TimelineEntry[]>();
    for (const e of entries) {
      const g = e.project ?? (e.cat === "integration" ? "Integrations" : e.cat === "chat" ? "Chat" : "Coucou");
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(e);
    }
    for (const [name, items] of groups) {
      list.append(h("div", { class: "tlv-group" }, h("b", { text: name }), h("span", { text: `${items.length} event${items.length === 1 ? "" : "s"} · last ${ago(items[0].at)}` })));
      for (const e of items.slice(0, 40)) list.append(timelineRow(e, (r) => actions.openDiff(r)));
    }
  }

  return {
    el,
    show() {
      key = "";
      draw();
      clockTimer ??= window.setInterval(() => {
        for (const t of list.querySelectorAll<HTMLTimeElement>("time[data-at]")) t.textContent = ago(Number(t.dataset.at));
      }, 10_000);
    },
    hide() {
      if (clockTimer != null) window.clearInterval(clockTimer);
      clockTimer = null;
    },
    focus() {
      input.focus();
    },
    sync() {
      draw();
    },
  };
}

// ── Insight ───────────────────────────────────────────────────────────────────

export function buildInsight(actions: ViewActions): ViewHost {
  const titleEl = h("span", { class: "v-title" });
  const who = h("span", { class: "v-who" });
  const glyph = icon(LINE.sparkle, 12, 2.1);
  const head = h("div", { class: "v-head" }, h("span", { class: "v-icon" }, glyph), titleEl, who);
  const body = h("div", { class: "ins-body" });
  const copyBtn = button("Copy", "secondary", () => {
    void navigator.clipboard?.writeText(Insight.current.text).then(() => {
      (copyBtn.querySelector(".btn-label") as HTMLElement).textContent = "Copied";
      window.setTimeout(() => ((copyBtn.querySelector(".btn-label") as HTMLElement).textContent = "Copy"), 1400);
    });
  }, { icon: LINE.copy });
  const saveBtn = button("Save to memory", "secondary", () => void save(), { icon: LINE.folder });
  const settingsBtn = button("Open settings", "primary", () => actions.openSettingsPage("claude"), { icon: LINE.sliders });
  const backBtn = button("Back", "ghost", () => actions.setView(State.defaultView()), { icon: LINE.arrowLeft });
  // Read aloud with the system's own voices (nothing leaves the computer).
  const canSpeak = typeof window.speechSynthesis !== "undefined";
  const speakBtn = button("Read aloud", "secondary", () => {
    const synth = window.speechSynthesis;
    if (synth.speaking) {
      synth.cancel();
      return;
    }
    const u = new SpeechSynthesisUtterance(Insight.current.text);
    u.rate = 1.02;
    u.onend = () => State.notify();
    synth.speak(u);
    State.notify();
  }, { icon: LINE.speaker });
  const source = h("span", { class: "ins-source" });
  const row = h("div", { class: "actions" }, copyBtn, speakBtn, saveBtn, settingsBtn, backBtn, h("span", { class: "grow" }), source);
  const shell = card("indigo", h("div", { class: "stack ins-stack" }, head, body, row));
  shell.style.setProperty("--accent", "#A78BFA");
  const el = h("div", { class: "view insight" }, shell);
  let savedFor = 0;

  async function save() {
    const cur = Insight.current;
    if (!State.prefs.memory.enabled) {
      actions.openSettingsPage("memory");
      return;
    }
    const ok = await actions.saveToMemory("insight", cur.title, cur.text, cur.project);
    if (ok) {
      savedFor = cur.at;
      State.notify();
    }
  }

  return {
    el,
    sync() {
      const cur = Insight.current;
      titleEl.textContent = cur.title || "Claude";
      who.textContent = cur.project ?? "";
      shell.dataset.status = cur.status;
      setIcon(glyph, cur.status === "error" ? LINE.xCircle : LINE.sparkle);
      if (cur.status === "loading") {
        if (!body.querySelector(".ins-shimmer")) {
          clear(body);
          body.append(h("div", { class: "ins-shimmer" }, h("i"), h("i"), h("i")), h("span", { class: "ins-wait", text: "Asking Claude…" }));
        }
      } else if (body.dataset.at !== String(cur.at) || body.dataset.status !== cur.status) {
        clear(body);
        body.append(h("p", { text: cur.text || "Nothing to show yet." }));
      }
      body.dataset.at = String(cur.at);
      body.dataset.status = cur.status;
      const ready = cur.status === "ready";
      copyBtn.style.display = ready ? "" : "none";
      speakBtn.style.display = ready && canSpeak ? "" : "none";
      if (canSpeak) (speakBtn.querySelector(".btn-label") as HTMLElement).textContent = window.speechSynthesis.speaking ? "Stop" : "Read aloud";
      saveBtn.style.display = ready ? "" : "none";
      settingsBtn.style.display = cur.status === "error" && /key|settings|401|403/i.test(cur.text) ? "" : "none";
      (saveBtn.querySelector(".btn-label") as HTMLElement).textContent =
        savedFor === cur.at ? "Saved" : State.prefs.memory.enabled ? "Save to memory" : "Turn on memory…";
      saveBtn.disabled = savedFor === cur.at;
      source.textContent = ready ? `Anthropic API · ${new Date(cur.at).toLocaleTimeString()}` : "";
    },
  };
}

// ── Startup check ─────────────────────────────────────────────────────────────

interface BootLine {
  label: string;
  value: string;
  state: "ok" | "warn" | "off";
}

/** The real state of everything Coucou depends on, read once at launch. */
async function bootChecks(): Promise<BootLine[]> {
  const lines: BootLine[] = [];
  const hooks = await Bridge.hooksStatus();
  if (!IS_TAURI) {
    lines.push({ label: "Relay", value: "preview only", state: "off" });
  } else {
    lines.push({ label: "Relay", value: hooks?.hookReady ? "coucou-hook ready" : "not found", state: hooks?.hookReady ? "ok" : "warn" });
    lines.push({ label: "Claude Code hooks", value: hooks?.installed ? "installed" : "not installed", state: hooks?.installed ? "ok" : "warn" });
  }
  const d = State.display;
  lines.push({ label: "Display", value: d ? `${Math.round(d.width * d.scale)}×${Math.round(d.height * d.scale)} · ${Math.round(d.scale * 100)}%` : `${window.screen.width}×${window.screen.height}`, state: "ok" });
  const key = IS_TAURI ? await Bridge.secretPresent("anthropic-api-key") : null;
  lines.push({ label: "Claude API key", value: key ? "saved in the vault" : key === false ? "not set (chat off)" : "unknown", state: key ? "ok" : "off" });
  lines.push({ label: "Network", value: navigator.onLine ? "online" : "offline", state: navigator.onLine ? "ok" : "warn" });
  if (State.prefs.mode !== "normal") lines.push({ label: "Mode", value: MODES[State.prefs.mode].title, state: "ok" });
  return lines;
}

export function buildBoot(onDone: () => void): ViewHost {
  const list = h("div", { class: "boot-lines" });
  const skip = button("Skip", "ghost", () => finish(), { icon: LINE.chevronRight, title: "Skip the startup check" });
  const title = h("div", { class: "boot-title" }, h("b", { class: "fx-gradient-text", text: "Coucou" }), h("span", { text: "Starting up" }));
  const particles = h(
    "span",
    { class: "fx-particles boot-particles" },
    ...Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * Math.PI * 2;
      return h("i", { style: `--dx:${Math.cos(a) * 52}px;--dy:${Math.sin(a) * 52}px;--pdelay:${(0.5 + i * 0.05).toFixed(2)}s` });
    }),
  );
  const el = h(
    "div",
    { class: "view boot" },
    h("div", { class: "boot-stage" }, h("i", { class: "boot-point" }), h("i", { class: "boot-wave" }), particles),
    h("div", { class: "boot-panel" }, title, list, h("div", { class: "boot-foot" }, skip)),
  );
  let timers: number[] = [];
  let done = false;

  function finish() {
    if (done) return;
    done = true;
    timers.forEach((t) => window.clearTimeout(t));
    timers = [];
    onDone();
  }

  return {
    el,
    show() {
      done = false;
      clear(list);
      el.classList.remove("go");
      void el.offsetWidth;
      el.classList.add("go");
      void bootChecks().then((lines) => {
        lines.forEach((l, i) => {
          timers.push(window.setTimeout(() => {
            list.append(h("div", { class: `boot-line ${l.state}` }, h("i"), h("span", { text: l.label }), h("b", { text: l.value })));
          }, 380 + i * 170));
        });
        timers.push(window.setTimeout(finish, 380 + lines.length * 170 + 900));
      });
    },
    hide() {
      timers.forEach((t) => window.clearTimeout(t));
      timers = [];
    },
    sync() {},
  };
}

/** Text for the center's "Now" panel and the core's tooltip. */
export function workModeLabel(): string {
  return WORK_MODE_LABEL[Session.workMode];
}
