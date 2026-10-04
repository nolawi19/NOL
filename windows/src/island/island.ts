// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop, sendTo } from "../core/bridge";
import {
  EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, botPosition, chatPromptHeight,
  islandSize,
  type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State, type CoreState } from "../core/state";
import { BotEngine, hexToRGB } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import { createMiniBot, pruneMiniBots, syncMiniBotStates, tickMiniBots } from "../mochi/minibots";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { buildHeader, buildViews, tabIndex, type DecisionResult, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { icon, setIcon, TextSwap } from "../views/ui";
import { LINE } from "../views/icons";
import { primaryPhase, STATE_COLOR, type Phase } from "../core/activity";
import { IslandStateMachine } from "./fsm";
import { EnergyCore, type CoreKind } from "./core";
import { applyAppearance, MODES, soundAllowed } from "../core/prefs";
import { Automation } from "../core/automation";
import { Insight } from "../core/insight";
import { Memory, scrub } from "../core/memory";
import { localSummary, Session, summaryPrompt } from "../core/session";
import { COMMAND_CLASS_LABEL, REVERSIBILITY_LABEL } from "../core/risk";

/** Views with a text field: the only times the island takes keyboard focus. */
const TEXT_VIEWS: ReadonlySet<IslandViewName> = new Set(["prompt", "palette", "timeline"]);
/** Views that draw Mochi small, without the energy core around it. */
const NO_CORE_VIEWS: ReadonlySet<IslandViewName> = new Set(["welcome", "center", "palette", "timeline"]);

const BOT_OVERHANG = 40;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private core = new EnergyCore();
  private ring!: HTMLElement;
  private scan!: HTMLElement;
  /** Cursor over the island, −1…1 from its centre (0 when away). */
  private parallax = { x: 0, y: 0 };
  /** Named core state bookkeeping: one timer at a time, none while busy. */
  private dormant = false;
  private dormantTimer: number | null = null;
  private transientState: { state: CoreState; until: number } | null = null;
  private transientTimer: number | null = null;
  private prevHeight = 0;
  private lastTone = "idle";
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private wakeStrip!: HTMLElement;
  private shoulderL!: HTMLElement;
  private shoulderR!: HTMLElement;
  private compactStatus!: HTMLElement;
  private compactIcon!: SVGSVGElement;
  private compactText = new TextSwap("cs-text");
  /** Compact island stretched to make room for a status line. */
  private compactWide = false;
  /** View whose show() ran last, so hide() reaches exactly that one. */
  private shownView: IslandViewName | null = null;
  private decisionTimer: number | null = null;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private greeting = new Greeting();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
      },
      openTerminal: () => {
        const cwd = State.focusTask?.sessionCwd ?? null;
        void Bridge.openInVSCode(cwd);
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.id === "integration_claude") void Bridge.openInVSCode(task.sessionCwd ?? null);
        else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      openN8n: () => void Bridge.openN8n(),
      relayout: () => this.animateGeometry(!State.detailExpanded),
      openSettingsPage: (page) => {
        void Bridge.openSettingsWindow();
        void sendTo("settings", "settings-page", page);
      },
      decide: async (d) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req) return "late";
        const answer = await Bridge.approvalDecision(req.requestId, d);
        // Outside the app there is no relay to answer; the preview treats the
        // click as delivered. Inside it, only Rust's word counts.
        const result: DecisionResult = !IS_TAURI ? "delivered" : answer === true ? "delivered" : answer === false ? "late" : "failed";

        // Another request may have replaced this one while we waited.
        if (State.pendingApproval?.requestId === req.requestId) {
          State.pendingApproval = null;
          State.isPinned = false;
          this.fsm.pinned = false;
        }
        State.setPillBadge("integration_claude", null);
        if (result === "delivered") {
          Sound.play(d === "deny" ? "blip" : "approve");
          State.updateTask("integration_claude", "working");
          State.log({
            text: d === "allow" ? "Allowed" : "Denied",
            detail: req.command,
            tone: d === "allow" ? "success" : "info",
            icon: d === "allow" ? LINE.check : LINE.x,
            color: d === "allow" ? "#34D399" : "#9AA3B2",
            cat: "permission",
          });
        } else {
          // Claude Code took the question back to the terminal: say so.
          Sound.play("error");
          State.updateTask("integration_claude", "question");
          State.appendStep("integration_claude", "Permission · answer in the terminal");
          State.log({
            text: result === "late" ? "Permission expired" : "Permission not delivered",
            detail: "Answer it in the terminal",
            tone: "alert",
            icon: LINE.hourglass,
            color: "#F5A524",
            cat: "permission",
          });
        }
        State.notify();
        // The card shows the outcome for a moment, then returns to the overview —
        // the island itself stays open.
        if (this.decisionTimer != null) window.clearTimeout(this.decisionTimer);
        this.decisionTimer = window.setTimeout(() => {
          this.decisionTimer = null;
          if (State.view === "approval" && !State.pendingApproval) this.setView(State.defaultView());
        }, result === "delivered" ? 820 : 2600);
        return result;
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      hide: () => this.hide(),
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
      setMode: (mode) => {
        State.settings.prefs = { ...State.prefs, mode };
        this.applySettings();
        void Bridge.saveSettings(State.settings);
        State.log({ text: `${MODES[mode].title} mode`, detail: MODES[mode].desc, tone: "info", icon: LINE.moon, color: "#A78BFA", cat: "session" });
        State.showFlash(`${MODES[mode].title} mode`, "#A78BFA", "info", 2600, true);
        State.notify();
      },
      summarizeSession: () => {
        this.setView("insight");
        void this.summarize().catch(() => {});
      },
      explainApproval: async () => {
        const req = State.pendingApproval;
        if (!req) throw new Error("The request is gone.");
        const r = req.risk;
        const prompt = [
          "A developer is about to approve or deny this Claude Code permission request. Explain what it would do,",
          "what it could affect, and whether any part is risky or irreversible. Say if you're unsure.",
          "",
          `Tool: ${req.tool}`,
          `Request: ${req.target || "(no target)"}`,
          req.cwd ? `Working folder: ${req.cwd}` : "",
          r ? `Local reading: ${r.flags.map((f) => f.label).join(", ") || "no risky pattern found"}; ${REVERSIBILITY_LABEL[r.reversibility]}${r.commandClass ? `; ${COMMAND_CLASS_LABEL[r.commandClass]}` : ""}` : "",
        ].filter(Boolean).join("\n");
        // Credentials that happen to be in the command line never leave the computer.
        return Insight.run("explain", `Explaining · ${req.tool}`, scrub(prompt), State.focusTask?.name ?? null);
      },
      newChat: () => {
        State.chatHistory = [];
        State.droppedFile = null;
        State.promptContext = null;
        void Bridge.chatReset();
        this.setView("prompt");
      },
      refreshIntegration: (id) => {
        void Bridge.refreshIntegration(id);
        State.showFlash("Refreshing…", "#9AA3B2", "info", 2000, true);
      },
      saveToMemory: async (kind, title, text, project) => {
        if (!State.prefs.memory.enabled) return false;
        try {
          await Memory.add({ kind, title, text, project });
          State.log({ text: "Saved to memory", detail: title, tone: "info", icon: LINE.folder, color: "#A78BFA", cat: "session" });
          State.notify();
          return true;
        } catch (err) {
          State.showFlash(`Couldn't save: ${String((err as Error)?.message ?? err)}`, "#F4505E", "error", 4000, true);
          return false;
        }
      },
      bootDone: () => {
        if (State.view === "boot") this.launch();
      },
    };
    Automation.init({
      open: (view) => this.alert(view),
      summarize: () => this.summarize(),
    });

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.ring = h("div", { id: "island-ring" });
    this.scan = h("div", { id: "island-scan", class: "fx-scan" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    // Concave fillets that tie the island to the top edge of the screen.
    this.shoulderL = h("div", { class: "shoulder l" });
    this.shoulderR = h("div", { class: "shoulder r" });
    this.compactIcon = icon(LINE.sparkle, 11, 2.2);
    this.compactStatus = h(
      "div",
      { id: "compact-status" },
      h("span", { class: "cs-icon" }, this.compactIcon),
      this.compactText.el,
    );

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The drop sequence draws the card, the bar and its own Mochi. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      cancel: () => this.setView(State.defaultView()),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip", class: "fx-spotlight" },
      h("div", { id: "island-sheen", class: "fx-scanlines" }),
      // Cursor light, under the glass cards so it shows through them.
      h("div", { class: "fx-spot" }),
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
      this.compactStatus,
      h("div", { id: "island-edge" }, h("i")),
      this.scan,
    );
    this.islandEl = h(
      "div",
      { id: "island", "data-mode": "hidden" },
      h("div", { id: "island-aura" }),
      this.shoulderL,
      this.shoulderR,
      this.clipEl,
      this.ring,
      this.core.el,
      this.botCanvas,
      this.miniGrid,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "coucou") this.greeting.interrupt();
          else if (from === "hidden") Sound.play("peek");
          this.setMode("compact");
          if (from === "coucou") State.view = State.defaultView();
          break;
        case "home":
          // Coming out of the greeting the greeting canvas has finished; any
          // other way in opens on the default view.
          if (from === "coucou") this.greeting.interrupt();
          this.expand(State.defaultView());
          break;
        case "coucou":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  /** Startup check (skippable), then the usual greeting. */
  boot() {
    this.fsm.forceHome();
    this.expand("boot");
  }

  /** Asks Claude to summarise the current session; the insight view shows it. */
  summarize(): Promise<string> {
    const snap = Session.snapshot();
    const lines = State.timeline
      .filter((e) => !e.project || e.project === snap.project)
      .slice(0, 30)
      .map((e) => `${new Date(e.at).toLocaleTimeString()} ${e.text}${e.detail ? ` — ${e.detail.slice(0, 160)}` : ""}`);
    const project = snap.project || null;
    const title = `Session summary${project ? ` · ${project}` : ""}`;
    // Nothing to summarise: say so locally instead of spending tokens.
    if (snap.tools === 0 && !snap.prompt && lines.length === 0) {
      Insight.current = { status: "ready", kind: "summary", title, text: localSummary(snap), project, at: Date.now() };
      State.notify();
      return Promise.resolve(Insight.current.text);
    }
    return Insight.run("summary", title, scrub(summaryPrompt(snap, lines)), project).then((text) => {
      State.log({ text: "Summary ready", detail: text.slice(0, 120), tone: "success", icon: LINE.sparkle, color: "#A78BFA", cat: "session", project: project ?? undefined });
      if (State.view !== "insight") State.showFlash("Claude's summary is ready", "#A78BFA", "info", 5000, true);
      return text;
    });
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    this.islandEl.dataset.mode = mode;
    if (mode === "expanded") {
      Sound.play("open");
      // Re-arm the staggered entrance of the header and the card.
      this.contentEl.classList.remove("enter");
      void this.contentEl.offsetWidth;
      this.contentEl.classList.add("enter");
    }
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      this.syncViewLifecycle(null);
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  /** Tells the views which way the user is travelling between tabs. */
  private markDirection(view: IslandViewName) {
    const from = tabIndex(State.view);
    const to = tabIndex(view);
    this.viewsEl.dataset.dir = from >= 0 && to >= 0 && from !== to ? (to > from ? "fwd" : "back") : "none";
    if (view !== State.view) State.detailExpanded = false;
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    this.markDirection(view);
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    this.markDirection(view);
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = islandSize("expanded", view, State.chatHistory.length).h >=
      islandSize("expanded", State.view, State.chatHistory.length, { detail: State.detailExpanded }).h;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  /** First launch, or "Replay introduction" in Settings. */
  showWelcome() {
    this.fsm.forceHome();
    this.expand("welcome");
  }

  /** A file (a screenshot from Settings) to ask Claude about. */
  attachFile(name: string, path: string) {
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.chatHistory = [];
    void Bridge.chatReset();
    Sound.play("attach");
    this.fsm.forceHome();
    this.expand("prompt");
  }

  /** Explicit hide: the island retracts into the top edge until the pointer wakes it. */
  hide() {
    State.isPinned = false;
    this.fsm.pinned = false;
    // Screen access is never allowed to become invisible: while it is on the
    // island only goes as far as compact, where it keeps saying so.
    if (State.screen.active) {
      this.fsm.forcePetit();
      State.showFlash("Screen access is on — stop it to hide Coucou", "#F4505E", "error", 4000, true);
      return;
    }
    this.fsm.forceHidden();
  }

  collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path);
        break;
      }
    }
  }

  /**
   * Mochi eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.chatHistory = [];
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => this.setView(State.defaultView()), 2400);
      });
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once Mochi has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    const { w, h } = islandSize(State.mode, State.view, State.chatHistory.length, {
      detail: State.detailExpanded,
      wide: this.compactWide,
    });
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (REDUCED_MOTION.matches) {
      // Reduced motion: the island changes size in one step instead of travelling.
      this.width.jump(w);
      this.height.jump(h);
      this.radius.jump(r);
    } else if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.islandEl.style.transform = `translateX(-50%)`;
    // The fillets grow with the corner radius, and vanish as the island retracts.
    // Liquid neck: while the island pours out of the edge the fillets swell
    // with its speed, then settle back as it comes to rest.
    const speed = Math.abs(hh - this.prevHeight);
    this.prevHeight = hh;
    const sh = Math.max(0, Math.min(r * 0.62 + Math.min(9, speed * 0.9), hh * 0.9));
    const shPx = `${sh.toFixed(2)}px`;
    for (const el of [this.shoulderL, this.shoulderR]) {
      el.style.width = shPx;
      el.style.height = shPx;
    }
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.miniGrid.style.left = `${w - 40 - 14.5}px`;
    this.miniGrid.style.top = `${hh / 2 - 14.5}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const rect = { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") this.fsm.mouseEntered();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      if (State.mode !== "expanded") {
        this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    window.addEventListener("keydown", (e) => {
      // Ctrl+K (⌘K): the command palette, from anywhere in the island.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        this.setView(State.view === "palette" ? State.defaultView() : "palette");
        return;
      }
      if (e.key === "Escape" && State.mode === "expanded" && !State.isPinned) this.collapse();
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => this.onDragDrop(e));

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    if (inIsland && !this.wasInIsland) {
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.fsm.mouseEntered();
    }
    // Leaving the island is not a request to close it: nothing happens.

    // Parallax: layers behind the glass lean toward the pointer.
    const px = inIsland && State.mode === "expanded" ? clamp((x - rect.x) / rect.w * 2 - 1, -1, 1) : 0;
    const py = inIsland && State.mode === "expanded" ? clamp((y - rect.y) / Math.max(1, rect.h) * 2 - 1, -1, 1) : 0;
    if (Math.abs(px - this.parallax.x) > 0.02 || Math.abs(py - this.parallax.y) > 0.02) {
      this.parallax = { x: px, y: py };
      this.islandEl.style.setProperty("--px", px.toFixed(3));
      this.islandEl.style.setProperty("--py", py.toFixed(3));
    }
    this.wasInIsland = inIsland;

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own Mochi
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    this.views.get(State.view)?.tick?.(nowMs);
    if (UploadSeq.isActive) this.stepSequence();

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || UploadSeq.isActive;

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Mochi; two of them would overlap.
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    const coreOn =
      State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive && p.diameter > 0 &&
      // These two draw their own: the onboarding core and the activity panel.
      !NO_CORE_VIEWS.has(State.view);
    this.core.place(this.botCx.value, this.botCy.value, p.diameter, coreOn, this.parallax.x, this.parallax.y);
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - w / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const focus = State.focusTask;
    this.engine.bodyColor = focus?.isIntegration ? hexToRGB(focus.color) : null;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hCss);
    this.engine.draw(ctx, w, hCss);
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }
    this.syncViewLifecycle(expanded && !greetingActive ? State.view : null);
    this.syncPhase();

    // The chat is the only view with a text field, so it is the only time the
    // island is allowed to take keyboard focus.
    if (this.lastSyncedView !== State.view) {
      const hadField = this.lastSyncedView != null && TEXT_VIEWS.has(this.lastSyncedView);
      this.lastSyncedView = State.view;
      if (TEXT_VIEWS.has(State.view)) {
        void Bridge.focusWindow(true);
        const v = State.view;
        window.setTimeout(() => this.views.get(v)?.focus?.(), 120);
      } else if (hadField) {
        void Bridge.focusWindow(false);
      }
    }

    // Compact mini grid
    const showGrid = State.mode === "compact";
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    if (showGrid) {
      const others = State.otherTasks.slice(0, 4);
      const key = others.map((t) => t.id).join("|");
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(createMiniBot(t, 13));
        }
        pruneMiniBots();
      }
    }

    syncMiniBotStates(State.tasks);
    this.engine.setState(State.effectiveState);
  }

  /** Runs hide() on the view that left and show() on the one that arrived. */
  private syncViewLifecycle(active: IslandViewName | null) {
    if (active === this.shownView) return;
    if (this.shownView) this.views.get(this.shownView)?.hide?.();
    this.shownView = active;
    if (active) this.views.get(active)?.show?.();
  }

  /**
   * The island's light: the underglow, the travelling edge and the alert ring
   * all follow the most urgent thing going on. The compact island also spells
   * it out, and widens a little to make room.
   */
  private syncPhase() {
    const phase: Phase | null = primaryPhase(State.tasks, State.focusId);
    const override = State.stateOverride;
    const tone = override === "dizzy" ? "idle" : override === "thinking" ? "active" : phase?.tone ?? "idle";
    const color = override === "thinking" ? STATE_COLOR.thinking : phase?.color ?? STATE_COLOR.idle;
    if (this.islandEl.dataset.tone !== tone) this.islandEl.dataset.tone = tone;
    this.islandEl.style.setProperty("--accent", color);

    const coreKind: CoreKind = override === "thinking" ? "chat" : override === "dizzy" ? "idle" : phase?.kind ?? "idle";
    this.core.setPhase(coreKind, tone, color);
    this.syncCoreState(coreKind, tone);
    // The rim turns to aurora only while something waits on the user.
    this.ring.classList.toggle("fx-aurora", tone === "alert");
    // A new kind of state sweeps a scan line across the island, once.
    if (tone !== this.lastTone) {
      this.lastTone = tone;
      if (tone !== "idle" && State.mode === "expanded") {
        this.scan.classList.remove("run");
        void this.scan.offsetWidth;
        this.scan.classList.add("run");
      }
    }

    let line: string | null = null;
    let path: string = LINE.sparkle;
    let lineColor = color;
    this.islandEl.classList.toggle("screen-on", State.screen.active);
    if (State.screen.active) {
      line = "SCREEN ACCESS ACTIVE";
      path = LINE.screen;
      lineColor = "#F4505E";
    } else if (phase) {
      line = phase.detail && phase.tone !== "alert" ? `${phase.label} · ${phase.detail}` : phase.label;
      path = phase.icon;
    } else if (State.flash) {
      line = State.flash.text;
      path = State.flash.tone === "error" ? LINE.xCircle : State.flash.tone === "success" ? LINE.checkCircle : LINE.info;
      lineColor = State.flash.color;
    }
    this.compactStatus.classList.toggle("on", line != null);
    this.compactStatus.style.setProperty("--cs", lineColor);
    if (line != null) {
      setIcon(this.compactIcon, path);
      this.compactText.set(line, State.mode !== "compact");
    }

    const wide = line != null;
    if (wide !== this.compactWide) {
      this.compactWide = wide;
      if (State.mode === "compact") this.animateGeometry(!wide);
    }
  }

  /**
   * The core's named state. Quiet for `dormantAfter` seconds → dormant; the
   * first activity after that → awakening (1.2 s); a success or failure
   * fading back to idle → cooling (2.4 s). Single-shot timers, no polling.
   */
  private syncCoreState(kind: CoreKind, tone: string) {
    const prev = State.coreState;
    let next: CoreState =
      tone === "error" || kind === "error" ? "failure"
      : tone === "success" || kind === "done" ? "success"
      : kind === "permission" ? "permission"
      : kind === "question" || kind === "ratelimit" ? "warning"
      : kind === "chat" ? "communicating"
      : kind === "think" || kind === "plan" ? "thinking"
      : kind === "read" || kind === "search" || kind === "web" ? "analyzing"
      : kind === "idle" ? "idle"
      : "executing";

    const now = Date.now();
    if (next === "idle") {
      if ((prev === "success" || prev === "failure") && !this.dormant) this.setTransient("cooling", 2400);
      if (this.dormant) next = "dormant";
      else if (this.dormantTimer == null) {
        this.dormantTimer = window.setTimeout(() => {
          this.dormantTimer = null;
          this.dormant = true;
          State.notify();
        }, State.prefs.dormantAfter * 1000);
      }
    } else {
      if (this.dormantTimer != null) window.clearTimeout(this.dormantTimer);
      this.dormantTimer = null;
      if (this.dormant) {
        this.dormant = false;
        this.setTransient("awakening", 1200);
      }
    }
    if (this.transientState && this.transientState.until > now && (next === "idle" || this.transientState.state === "awakening")) {
      next = this.transientState.state;
    }
    if (next !== prev) {
      State.coreState = next;
      this.core.el.dataset.state = next;
      this.islandEl.dataset.core = next;
    }
  }

  private setTransient(state: CoreState, ms: number) {
    this.transientState = { state, until: Date.now() + ms };
    if (this.transientTimer != null) window.clearTimeout(this.transientTimer);
    this.transientTimer = window.setTimeout(() => {
      this.transientTimer = null;
      this.transientState = null;
      State.notify();
    }, ms + 20);
  }

  /** Applies settings coming from Rust at boot, and every change after. */
  applySettings() {
    const prefs = State.prefs;
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    Sound.gate = (name) => soundAllowed(State.prefs, name);
    Sound.setScale(prefs.mode === "night" ? 0.5 : 1);
    applyAppearance(prefs);
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
