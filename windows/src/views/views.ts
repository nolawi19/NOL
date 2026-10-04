// Island views. Same views, same actions and the same geometry as the macOS
// port (Mochi keeps its spot on the left of every card); the presentation is
// built on the design system in src/design and the primitives in ./ui.

import { h, svg, clear, dot } from "./dom";
import { ICONS, LINE } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask } from "../core/state";
import type { IslandViewName } from "../core/layout";
import { Bridge, sendTo } from "../core/bridge";
import { formatDuration, kindIcon, phaseOf, primaryPhase, STATE_COLOR, toolKind } from "../core/activity";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildCenter } from "./center";
import { buildWelcome } from "./welcome";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { buildBoot, buildInsight, buildPalette, buildTimeline } from "./expansion";
import { MODES, type Mode } from "../core/prefs";
import { REVERSIBILITY_LABEL, RISK_COLOR, RISK_LEVEL_LABEL } from "../core/risk";
import { Session, shortSummary } from "../core/session";
import type { MemoryItem } from "../core/memory";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { button, card, clock, icon, setIcon, stagger, statusChip, TextSwap, tintVars } from "./ui";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  openN8n(): void;
  /** Sends the decision; resolves with what the backend actually did with it. */
  decide(d: "allow" | "deny"): Promise<DecisionResult>;
  toggleSound(): void;
  setVolume(v: number): void;
  /** Explicit hide: retract into the top edge. */
  hide(): void;
  /** Opens the settings window on a given page. */
  openSettingsPage(page: string): void;
  openSettingsWindow(): void;
  /** Re-run the island's size animation after a view changed its own height. */
  relayout(): void;
  blip(): void;
  setMode(mode: Mode): void;
  /** Asks Claude for a summary of the session and shows it in the insight view. */
  summarizeSession(): void;
  /** Asks Claude what the pending permission request would do. */
  explainApproval(): Promise<string>;
  newChat(): void;
  refreshIntegration(id: string): void;
  /** Resolves false when memory is off or storage failed. */
  saveToMemory(kind: MemoryItem["kind"], title: string, text: string, project: string | null): Promise<boolean>;
  /** The startup check ended (or was skipped). */
  bootDone(): void;
}

/** "delivered": the relay got it. "late": it had already timed out. "failed": no relay reached. */
export type DecisionResult = "delivered" | "late" | "failed";

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
  /** The view just came on screen: start its clocks. */
  show?(): void;
  /** The view left the screen (or the island closed): stop everything it runs. */
  hide?(): void;
}

const CLAUDE_ID = "integration_claude";

// ── Shared pieces ─────────────────────────────────────────────────────────────

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return stagger(el);
}

/** Header line of an alert card: tinted glyph, title, then who it is about. */
function viewHead(path: string, title: HTMLElement | string, who?: HTMLElement): HTMLElement {
  const row = h(
    "div",
    { class: "v-head" },
    h("span", { class: "v-icon" }, icon(path, 12, 2.1)),
    typeof title === "string" ? h("span", { class: "v-title", text: title }) : title,
  );
  if (who) row.append(who);
  return row;
}

function whoLabel(task: AgentTask | null): string {
  if (!task) return "";
  return task.id === CLAUDE_ID && task.name === "VS Code" ? "Claude Code" : task.name;
}

function claudeTask(): AgentTask | null {
  return State.tasks.find((t) => t.id === CLAUDE_ID) ?? null;
}

// ── Header ────────────────────────────────────────────────────────────────────

const TABS: { view: IslandViewName; title: string; path: string }[] = [
  { view: "overview", title: "Overview", path: ICONS.house },
  { view: "prompt", title: "Ask Claude", path: ICONS.bubble },
  { view: "upload", title: "Drop a file", path: ICONS.plus },
  { view: "center", title: "Command center", path: LINE.grid },
];

/** Views that already tell the user what is going on: no capsule over them. */
const SELF_EXPLAINING = new Set<IslandViewName>(["approval", "question", "error", "finished", "confused", "greeting", "welcome", "boot"]);

export function tabIndex(view: IslandViewName): number {
  if (view === "empty") return 0;
  const i = TABS.findIndex((t) => t.view === view);
  return i >= 0 ? i : view === "settings" ? TABS.length : -1;
}

export function buildHeader(actions: ViewActions): ViewHost {
  const indicator = h("i", { class: "tab-indicator" });
  const tabEls = TABS.map((t) =>
    h(
      "button",
      { class: "tab", type: "button", title: t.title, "aria-label": t.title, "data-tab": t.view, onclick: () => go(t.view) },
      t.view === "center" ? icon(t.path, 13, 2) : svg(t.path, 13),
    ),
  );

  const gearIcon = svg(ICONS.gear, 14);
  const soundIcon = svg(ICONS.speakerOn, 14);
  const searchBtn = h("button", { class: "hdr-btn search", type: "button", title: "Command palette (Ctrl+K)", "aria-label": "Command palette", onclick: () => go("palette") }, icon(LINE.search, 13, 2.2));
  // Anything but Normal mode is shown, so nobody wonders why it's quiet.
  const modeChip = h("button", { class: "mode-chip", type: "button", onclick: () => actions.openSettingsPage("modes") }, h("i"), h("span"));
  const gearBtn = h("button", { class: "hdr-btn gear", type: "button", title: "Quick settings", "aria-label": "Quick settings", onclick: () => go("settings") }, gearIcon);
  const soundBtn = h("button", { class: "hdr-btn sound", type: "button", title: "Mute", "aria-label": "Mute", onclick: () => actions.toggleSound() }, soundIcon);
  // Closing is always the user's call: these two are the only ways the open
  // island gets smaller (with Escape and the tray).
  const collapseBtn = h("button", { class: "hdr-btn collapse", type: "button", title: "Collapse (Esc)", "aria-label": "Collapse", onclick: () => actions.collapse() }, icon(LINE.chevronUp, 14, 2.2));
  const hideBtn = h("button", { class: "hdr-btn hide", type: "button", title: "Hide into the top edge", "aria-label": "Hide", onclick: () => actions.hide() }, icon(LINE.retract, 14, 2.1));

  // Screen access must never be invisible: while it is on, this stays up.
  const screenBadge = h(
    "button",
    { class: "screen-badge", type: "button", title: "Coucou can see your screen. Click to stop.", "aria-label": "Stop screen access" },
    h("i", { class: "rec" }),
    h("span", { text: "SCREEN ACCESS ACTIVE" }),
    h("b", { text: "Stop" }),
  );
  screenBadge.addEventListener("click", () => void sendTo("settings", "screen-share-stop", null));

  // The status capsule: what Claude is doing, visible from every view.
  const capIcon = icon(LINE.sparkle, 11, 2.2);
  const capLabel = new TextSwap("cap-label");
  const capsule = h(
    "button",
    { class: "capsule off", type: "button" },
    h("span", { class: "cap-dot" }, h("i")),
    h("span", { class: "cap-icon" }, capIcon),
    capLabel.el,
  );
  let capTask: AgentTask | null = null;
  capsule.addEventListener("click", () => {
    if (!capTask) return;
    actions.blip();
    actions.setFocus(capTask.id);
    if (capTask.state === "approval" && State.pendingApproval) actions.setView("approval");
    else actions.setView("overview");
  });

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, indicator, ...tabEls),
    capsule,
    h("div", { class: "header-actions" }, screenBadge, modeChip, searchBtn, gearBtn, soundBtn, h("i", { class: "hdr-sep" }), collapseBtn, hideBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      const idx = tabIndex(v);
      const onTab = idx >= 0 && idx < TABS.length;
      indicator.classList.toggle("off", !onTab);
      if (onTab) indicator.style.transform = `translate3d(${idx * 35}px,0,0)`;
      tabEls.forEach((t, i) => t.classList.toggle("on", i === idx));

      gearBtn.classList.toggle("on", v === "settings");
      setIcon(gearIcon, v === "settings" ? ICONS.gearFill : ICONS.gear);
      const muted = !State.settings.soundEnabled;
      soundBtn.classList.toggle("muted", muted);
      soundBtn.title = muted ? "Unmute" : "Mute";
      setIcon(soundIcon, muted ? ICONS.speakerOff : ICONS.speakerOn);

      screenBadge.classList.toggle("on", State.screen.active);
      searchBtn.classList.toggle("on", v === "palette");
      const mode = State.prefs.mode;
      modeChip.classList.toggle("on", mode !== "normal" && !State.screen.active);
      modeChip.dataset.mode = mode;
      (modeChip.lastChild as HTMLElement).textContent = MODES[mode].title;
      modeChip.title = `${MODES[mode].title} mode — ${MODES[mode].desc} Click to change.`;

      const phase = primaryPhase(State.tasks, State.focusId);
      const redundant =
        !phase || SELF_EXPLAINING.has(v) || State.screen.active ||
        (v === "overview" && phase.task.id === State.focusId);
      capsule.classList.toggle("off", redundant);
      if (phase) {
        capTask = phase.task;
        capsule.dataset.tone = phase.tone;
        capsule.dataset.kind = phase.kind;
        capsule.style.setProperty("--cap", phase.color);
        capsule.title = phase.detail ? `${whoLabel(phase.task)} — ${phase.detail}` : whoLabel(phase.task);
        setIcon(capIcon, phase.icon);
        capLabel.set(phase.label, redundant);
      } else {
        capTask = null;
      }
      el.classList.toggle("dim", v === "confused" || v === "welcome");
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

const BUSY_STATES = new Set<AgentTask["state"]>(["thinking", "working", "searching", "approval", "question", "ratelimit"]);

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();

  // Live session card (Claude Code at work)
  const whoDot = h("i", { class: "dot", style: "width:7px;height:7px" });
  const nameEl = h("span", { class: "name" });
  const toolEl = h("span", { class: "tool" });
  const statsEl = h("span", { class: "stats" });
  const who = h("div", { class: "who" }, whoDot, nameEl, toolEl);
  const phaseIcon = icon(LINE.sparkle, 11, 2.2);
  const phaseLabel = new TextSwap("phase-label");
  const phaseRow = h("div", { class: "phase" }, h("span", { class: "phase-icon" }, phaseIcon), phaseLabel.el, statsEl);
  const tickerBody = h("div", { class: "card-body session" }, who, phaseRow, ticker.el);

  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", type: "button", title: "Open", "aria-label": "Open", onclick: () => actions.openTarget() },
    icon(LINE.external, 9, 2.4),
  );
  const left = card(null, leftBody, jump);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);
  right.classList.add("pills-card");

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";
  /** Which card is up (pill + drill-down), to tell a new card from a data refresh. */
  let cardIdentity = "";
  let clockTimer: number | null = null;

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  /** Time spent on the current prompt — written straight to the DOM once a second. */
  function updateStats() {
    const task = State.focusTask;
    if (!task || mode !== "ticker") return;
    // Only while Claude is busy: an idle session's clock would just count up.
    const busy = BUSY_STATES.has(task.state);
    const since = task.turnStart ?? task.sessionStart;
    statsEl.textContent = busy && since ? formatDuration(Date.now() - since) : "";
    statsEl.title = task.toolCount ? `${task.toolCount} tool call${task.toolCount === 1 ? "" : "s"} this turn` : "";
  }

  function startClock() {
    if (clockTimer != null) return;
    clockTimer = window.setInterval(updateStats, 1000);
  }

  function stopClock() {
    if (clockTimer != null) window.clearInterval(clockTimer);
    clockTimer = null;
  }

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    show() {
      if (mode === "ticker") startClock();
    },
    hide() {
      stopClock();
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // VS Code with a live Claude Code session keeps the ticker; every other
      // pill shows its own card, exactly like IntegrationCardView.
      const sessionActive =
        task?.id === CLAUDE_ID && (task.state !== "idle" || task.steps.length > 0);

      if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          tickerBody.classList.remove("enter");
          void tickerBody.offsetWidth;
          tickerBody.classList.add("enter");
          mode = "ticker";
          cardKey = "";
          startClock();
        }
        whoDot.style.background = task.color;
        nameEl.textContent = task.name;
        toolEl.textContent = task.source === "claudeCode" ? "Claude Code" : "n8n";

        const phase = phaseOf(task);
        const color = phase?.color ?? STATE_COLOR.idle;
        tickerBody.style.setProperty("--accent", color);
        tickerBody.dataset.tone = phase?.tone ?? "idle";
        phaseRow.dataset.kind = phase?.kind ?? "idle";
        setIcon(phaseIcon, phase?.icon ?? LINE.checkCircle);
        phaseLabel.set(phase?.label ?? "Ready for the next prompt");
        updateStats();
        ticker.sync(task);
      } else if (task) {
        stopClock();
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          const identity = `${task.id}:${detailOpen}`;
          const fresh = mode !== "card" || identity !== cardIdentity;
          cardIdentity = identity;
          cardKey = key;
          mode = "card";
          clear(leftBody);
          const rendered = renderIntegrationCard(task, hooks);
          // A new pill or a drill-down animates in; a data refresh just updates.
          if (fresh) rendered.classList.add("int-enter");
          leftBody.append(rendered);
        }
      }

      jump.style.display = detailOpen ? "none" : "";

      const others = State.otherTasks.slice(0, 4);
      const pillKey = others.map((t) => `${t.id}:${t.pillBadge ?? ""}`).join("|");
      if (pillKey !== pillIds) {
        const prevIds = new Set(pillIds.split("|").map((x) => x.split(":")[0]));
        pillIds = pillKey;
        clear(pills);
        others.forEach((t, i) => pills.append(buildPill(t, actions, i, !prevIds.has(t.id))));
        pruneMiniBots();
      }
    },
  };
}

function buildPill(task: AgentTask, actions: ViewActions, index: number, isNew: boolean): HTMLElement {
  const label = task.id === CLAUDE_ID ? "VS Code" : task.name;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "button",
    {
      class: isNew ? "pill pill-new" : "pill",
      type: "button",
      title: `Show ${label}`,
      style: `${tintVars(task.color)};--i:${index}`,
      onclick: () => actions.setFocus(task.id),
    },
    canvas,
    h("span", { class: "lbl", text: label }),
  );

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const badge = h(
      "div",
      { class: `pill-badge ${task.pillBadge}`, style: `--badge:${colors[task.pillBadge]}` },
      h("i", {}, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 })),
    );
    pill.append(badge);
  }
  return pill;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = stack(
    118,
    18,
    h("div", { class: "title", text: "All quiet." }),
    h("div", { class: "sub", text: "Nothing is running. Ask Claude something, or drop a file on me." }),
    h(
      "div",
      { class: "actions" },
      button("Ask Claude", "primary", () => actions.setView("prompt"), { icon: ICONS.bubble, iconFilled: true }),
      button("Drop a file", "secondary", () => actions.setView("upload"), { icon: LINE.upload }),
    ),
  );
  const el = h("div", { class: "view" }, card("soft", body));
  return { el, sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

/** Ring that drains over the time Coucou has left to answer. */
function timeoutRing() {
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, "svg");
  el.setAttribute("viewBox", "0 0 36 36");
  el.setAttribute("class", "ring");
  const track = document.createElementNS(ns, "circle");
  const fill = document.createElementNS(ns, "circle");
  for (const c of [track, fill]) {
    c.setAttribute("cx", "18");
    c.setAttribute("cy", "18");
    c.setAttribute("r", "16");
    c.setAttribute("pathLength", "100");
  }
  track.setAttribute("class", "ring-track");
  fill.setAttribute("class", "ring-fill");
  el.append(track, fill);
  return {
    el,
    restart(totalMs: number, elapsedMs: number) {
      fill.style.animation = "none";
      void el.getBoundingClientRect();
      fill.style.animation = `ring-drain ${totalMs}ms linear ${-elapsedMs}ms forwards`;
    },
  };
}

function buildApproval(actions: ViewActions): ViewHost {
  const ring = timeoutRing();
  const badge = h("span", { class: "appr-icon" }, ring.el, icon(LINE.shield, 14, 2.1));
  const titleEl = h("span", { class: "v-title", text: "Permission needed" });
  const who = h("span", { class: "v-who" });
  const countdown = h("span", { class: "appr-count", title: "After this, Claude Code asks in the terminal" });
  const riskChip = h("span", { class: "risk-chip" });
  const head = h("div", { class: "v-head" }, badge, titleEl, who, riskChip, h("span", { class: "grow" }), countdown);

  const toolIcon = icon(LINE.terminal, 10, 2.3);
  const toolName = h("span");
  const toolBadge = h("span", { class: "tool-badge" }, toolIcon, toolName);
  const code = h("div", { class: "code appr-code" });
  const target = h("div", { class: "appr-target" }, toolBadge, code);

  // What the request would do — a reading aid, shown with "Details".
  const riskSummary = h("div", { class: "risk-summary" });
  const riskFlags = h("div", { class: "risk-flags" });
  const riskMeta = h("div", { class: "risk-meta" });
  const explainOut = h("div", { class: "risk-explain" });
  const riskBox = h("div", { class: "risk-box" }, riskSummary, riskFlags, riskMeta, explainOut);
  let explainFor: string | null = null;
  const explainBtn = button("Explain", "ghost", () => void explain(), { icon: LINE.sparkle, title: "Ask Claude what this would do (uses your API key; sends only this request's text)" });

  const moreLabel = h("span", { text: "Show all" });
  const moreIcon = icon(LINE.chevronDown, 10, 2.4);
  const more = h("button", { class: "more-btn", type: "button" }, moreLabel, moreIcon);
  more.hidden = true;

  const deny = button("Deny", "secondary", () => decide("deny"), { icon: LINE.x, title: "Refuse this action" });
  const allow = button("Allow", "allow", () => decide("allow"), { icon: LINE.check, title: "Let Claude Code do this once" });
  const row = h("div", { class: "actions" }, deny, allow, h("span", { class: "grow" }), explainBtn, more);

  const body = stack(116, 16, head, target, riskBox, row);
  const shell = card("amber", body);
  shell.classList.add("approval-card");
  const el = h("div", { class: "view approval" }, shell);

  let shownId: string | null = null;
  let decided: "allow" | "deny" | null = null;
  let timer: number | null = null;

  const label = (b: HTMLButtonElement, text: string) =>
    ((b.querySelector(".btn-label") as HTMLElement).textContent = text);

  async function decide(d: "allow" | "deny") {
    if (decided || !State.pendingApproval) return;
    decided = d;
    deny.disabled = true;
    allow.disabled = true;
    const pressed = d === "allow" ? allow : deny;
    pressed.classList.add("chosen", "sending");
    label(pressed, d === "allow" ? "Allowing…" : "Denying…");
    const result = await actions.decide(d);
    pressed.classList.remove("sending");
    // Only what the backend confirmed is shown as done.
    if (result === "delivered") {
      shell.dataset.decided = d;
      label(pressed, d === "allow" ? "Allowed" : "Denied");
    } else {
      shell.dataset.decided = "late";
      pressed.classList.remove("chosen");
      label(pressed, d === "allow" ? "Allow" : "Deny");
      titleEl.textContent = result === "late" ? "Too late — answer in the terminal" : "Couldn't reach Claude Code";
      countdown.textContent = "";
    }
  }

  /** The relay stopped waiting: the terminal has the question now. */
  function expire() {
    if (decided) return;
    decided = "deny";
    deny.disabled = true;
    allow.disabled = true;
    shell.dataset.decided = "late";
    titleEl.textContent = "Handed back to the terminal";
    countdown.textContent = "0:00";
  }

  function tickCountdown() {
    const req = State.pendingApproval;
    if (!req || decided) return;
    const left = req.receivedAt + req.timeoutMs - Date.now();
    if (left <= 0) return expire();
    countdown.textContent = clock(left);
    countdown.classList.toggle("urgent", left < 20_000);
  }

  more.addEventListener("click", () => {
    State.detailExpanded = !State.detailExpanded;
    State.notify();
    actions.relayout();
  });

  async function explain() {
    const req = State.pendingApproval;
    if (!req || explainFor === req.requestId) return;
    explainFor = req.requestId;
    explainBtn.disabled = true;
    explainOut.dataset.state = "loading";
    explainOut.textContent = "Asking Claude…";
    if (!State.detailExpanded) {
      State.detailExpanded = true;
      State.notify();
      actions.relayout();
    }
    try {
      const text = await actions.explainApproval();
      if (State.pendingApproval?.requestId !== req.requestId) return;
      explainOut.dataset.state = "ready";
      explainOut.textContent = text;
    } catch (err) {
      if (State.pendingApproval?.requestId !== req.requestId) return;
      explainOut.dataset.state = "error";
      explainOut.textContent = String((err as Error)?.message ?? err);
      explainFor = null;
      explainBtn.disabled = false;
    }
  }

  return {
    el,
    show() {
      tickCountdown();
      if (timer == null) timer = window.setInterval(tickCountdown, 1000);
    },
    hide() {
      if (timer != null) window.clearInterval(timer);
      timer = null;
    },
    sync() {
      const req = State.pendingApproval;
      if (req && req.requestId !== shownId) {
        shownId = req.requestId;
        decided = null;
        delete shell.dataset.decided;
        deny.disabled = false;
        allow.disabled = false;
        for (const b of [deny, allow]) b.classList.remove("chosen", "sending");
        titleEl.textContent = "Permission needed";
        explainFor = null;
        explainBtn.disabled = false;
        delete explainOut.dataset.state;
        explainOut.textContent = "";
        const risk = req.risk;
        riskChip.hidden = !risk;
        shell.dataset.risk = risk?.level ?? "unknown";
        if (risk) {
          riskChip.textContent = RISK_LEVEL_LABEL[risk.level];
          riskChip.dataset.level = risk.level;
          riskChip.style.setProperty("--rc", RISK_COLOR[risk.level]);
          riskChip.title = risk.flags.length ? risk.flags.map((f) => f.label).join(" · ") : "Nothing risky found in the request text. Still read it.";
          riskSummary.textContent = risk.summary;
          riskFlags.replaceChildren(
            ...risk.flags.map((f) => h("span", { class: "risk-flag", "data-w": String(f.weight), title: f.why, text: f.label })),
          );
          riskMeta.replaceChildren(
            h("span", { class: `rev ${risk.reversibility}`, text: REVERSIBILITY_LABEL[risk.reversibility] }),
            ...(risk.paths.length ? [h("span", { class: "risk-paths", title: risk.paths.join("\n"), text: risk.paths.slice(0, 3).join(" · ") })] : []),
          );
        } else {
          riskSummary.textContent = "";
          riskFlags.replaceChildren();
          riskMeta.replaceChildren();
        }
        (deny.querySelector(".btn-label") as HTMLElement).textContent = "Deny";
        (allow.querySelector(".btn-label") as HTMLElement).textContent = "Allow";
        ring.restart(req.timeoutMs, Date.now() - req.receivedAt);
        // Re-run the entrance so a second request visibly arrives.
        shell.classList.remove("arrive");
        void shell.offsetWidth;
        shell.classList.add("arrive");
      }
      if (req) {
        // The whole point of approving here rather than in the terminal: this
        // is the command, the file path or the URL being authorised.
        code.textContent = req.target || req.tool;
        toolName.textContent = req.tool;
        setIcon(toolIcon, kindIcon(toolKind(req.tool)));
        tickCountdown();
      }
      who.textContent = whoLabel(claudeTask());

      const expanded = State.detailExpanded;
      code.classList.toggle("expanded", expanded);
      riskBox.classList.toggle("open", expanded);
      const hasDetail = !!req?.risk;
      moreLabel.textContent = expanded ? "Less" : hasDetail ? "Details" : "Show all";
      more.classList.toggle("open", expanded);
      explainBtn.hidden = State.apiKeyPresent === false || !!shell.dataset.decided;
      // Offer more only when there is more: a risk reading, or a cut-off target.
      requestAnimationFrame(() => {
        more.hidden = !expanded && !hasDetail && code.scrollHeight <= code.clientHeight + 1;
      });
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(actions: ViewActions): ViewHost {
  const who = h("span", { class: "v-who" });
  const head = viewHead(LINE.ask, "Claude is asking", who);
  const title = h("div", { class: "title clamp-2" });
  const row = h(
    "div",
    { class: "actions" },
    button("Open in VS Code", "primary", () => actions.openTerminal(), { icon: LINE.external }),
    h("span", { class: "hint", text: "Answer in your terminal" }),
  );
  const shell = card("cyan", stack(116, 16, head, title, row));
  shell.style.setProperty("--accent", "var(--c-question)");
  const el = h("div", { class: "view" }, shell);
  return {
    el,
    sync() {
      const task = State.focusTask;
      who.textContent = whoLabel(task);
      title.textContent = task?.steps.at(-1) ?? "Claude needs an answer.";
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("span", { class: "v-who" });
  const titleEl = h("span", { class: "v-title" });
  const head = viewHead(LINE.xCircle, titleEl, who);
  const detail = h("div", { class: "detail clamp-2" });
  const openBtn = button("Open in VS Code", "primary", () => {
    if (State.focusTask?.source === "n8n") actions.openN8n();
    else actions.openTerminal();
  }, { icon: LINE.external });
  const row = h(
    "div",
    { class: "actions" },
    openBtn,
    button("Dismiss", "secondary", () => actions.setView(State.defaultView())),
  );
  const shell = card("red", stack(116, 16, head, detail, row));
  shell.style.setProperty("--accent", "var(--c-error)");
  const el = h("div", { class: "view" }, shell);
  return {
    el,
    sync() {
      const task = State.focusTask;
      const n8n = task?.source === "n8n";
      who.textContent = whoLabel(task);
      titleEl.textContent = n8n ? "Workflow stopped" : "Session stopped on an error";
      (openBtn.querySelector(".btn-label") as HTMLElement).textContent = n8n ? "Open n8n" : "Open in VS Code";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("span", { class: "v-who" });
  const burst = h("span", { class: "burst" }, ...Array.from({ length: 8 }, (_, i) => h("i", { style: `--a:${i * 45}deg` })));
  const iconWrap = h("span", { class: "v-icon done" }, icon(LINE.check, 12, 2.6), burst);
  const head = h("div", { class: "v-head" }, iconWrap, h("span", { class: "v-title", text: "Claude Code finished" }), who);
  const title = h("div", { class: "title clamp-2" });
  const meta = h("div", { class: "meta" });
  const summarize = button("Summary", "secondary", () => actions.summarizeSession(), { icon: LINE.sparkle, title: "Ask Claude to summarise this session (uses your API key)" });
  const row = h(
    "div",
    { class: "actions" },
    button("Open in VS Code", "primary", () => actions.openTerminal(), { icon: LINE.external }),
    summarize,
    button("Done", "secondary", () => actions.collapse()),
    h("span", { class: "grow" }),
    meta,
  );
  const shell = card("green", stack(116, 16, head, title, row));
  shell.style.setProperty("--accent", "var(--c-success)");
  const el = h("div", { class: "view" }, shell);
  return {
    el,
    show() {
      burst.classList.remove("go");
      void burst.offsetWidth;
      burst.classList.add("go");
    },
    sync() {
      const task = State.focusTask;
      who.textContent = whoLabel(task);
      title.textContent = task?.steps.at(-1) ?? "Session finished";
      const isClaude = task?.id === CLAUDE_ID;
      summarize.style.display = isClaude && State.apiKeyPresent !== false ? "" : "none";
      if (isClaude) {
        // Written from the matched hook events: files, tools, failures, time.
        const snap = Session.snapshot();
        meta.textContent = shortSummary(snap);
        meta.title = snap.filesChanged.length ? `Changed: ${snap.filesChanged.join(", ")}` : "";
      } else {
        const parts: string[] = [];
        if (task?.toolCount) parts.push(`${task.toolCount} tool${task.toolCount === 1 ? "" : "s"}`);
        if (task?.turnStart) parts.push(formatDuration(Date.now() - task.turnStart));
        meta.textContent = parts.join(" · ");
      }
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = stack(
    128,
    18,
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(actions: ViewActions): ViewHost {
  const title = h("div", { class: "title clamp-2" });
  const settingsBtn = button("Open settings", "primary", () => actions.openSettingsWindow(), { icon: LINE.sliders });
  const row = h(
    "div",
    { class: "actions" },
    settingsBtn,
    button("Back", "secondary", () => actions.setView(State.defaultView()), { icon: LINE.arrowLeft }),
  );
  const head = viewHead(LINE.info, "Heads up");
  const shell = card("red", stack(98, 18, head, title, row));
  shell.style.setProperty("--accent", "var(--c-error)");
  const el = h("div", { class: "view" }, shell);
  return {
    el,
    sync() {
      const msg = State.noteMessage ?? "";
      title.textContent = msg;
      // Point at the fix when the message is about configuration.
      settingsBtn.style.display = /key|settings|token/i.test(msg) ? "" : "none";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────


function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", {
    class: "switch",
    type: "button",
    role: "switch",
    "aria-label": "Sound",
    onclick: () => actions.toggleSound(),
  });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005", "aria-label": "Volume",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;

  const claudeChip = h("span");
  const apiChip = h("span");
  let apiKey: boolean | null = null;

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { class: "q-label", text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      icon(ICONS.timer, 13, 0),
      h("span", { class: "q-label", text: "Island" }),
      h("span", { class: "q-value", text: "stays open until you close it" }),
      h("div", { class: "grow" }),
      button("Collapse", "ghost", () => actions.collapse(), { icon: LINE.chevronUp }),
      button("Hide", "ghost", () => actions.hide(), { icon: LINE.retract }),
    ),
    h(
      "div",
      { class: "settings-row" },
      claudeChip,
      apiChip,
      h("div", { class: "grow" }),
      button("All settings", "ghost", () => actions.openSettingsWindow(), { icon: LINE.sliders }),
    ),
  );
  stagger(rows);

  const el = h("div", { class: "view quick-settings" },
    card(null, h("div", { class: "stack", style: "padding:12px 16px 12px 84px" }, rows)));

  return {
    el,
    show() {
      // Ask Rust whether a key exists — never for the key itself.
      void Bridge.secretPresent("anthropic-api-key").then((present) => {
        apiKey = present;
        State.notify();
      });
    },
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      soundSwitch.setAttribute("aria-checked", String(s.soundEnabled));
      volume.value = String(s.soundVolume);
      volume.style.setProperty("--val", `${(s.soundVolume / 0.2) * 100}%`);
      volume.disabled = !s.soundEnabled;

      claudeChip.replaceChildren(
        statusChip(s.hooksInstalled ? "#22C55E" : "#F4505E", s.hooksInstalled ? "Hooks on" : "Hooks off"),
      );
      apiChip.replaceChildren(
        apiKey == null
          ? statusChip("#6D727B", "API key")
          : statusChip(apiKey ? "#22C55E" : "#F4505E", apiKey ? "API key set" : "No API key"),
      );
    },
  };
}

// ── Views the Windows build does not offer ────────────────────────────────────

function buildPlaceholder(title: string): ViewHost {
  const body = stack(118, 18, h("div", { class: "title", text: title }));
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion(actions));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote(actions));
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange, (page) => actions.openSettingsPage(page)));
  map.set("center", buildCenter(actions));
  map.set("welcome", buildWelcome(actions));
  map.set("palette", buildPalette(actions));
  map.set("timeline", buildTimeline(actions));
  map.set("insight", buildInsight(actions));
  map.set("boot", buildBoot(() => actions.bootDone()));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Never navigated to on Windows / Linux (no email, no window attach); kept so
  // every IslandViewName still resolves to something.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version."));
  map.set("searching", buildPlaceholder("Claude is searching…"));
  map.set("result", buildPlaceholder("Result"));
  return map;
}

export { dot };
