// First launch. Shown instead of the greeting until the user finishes it;
// "onboarded" lives in settings.json (Rust), so an interrupted setup simply
// shows again next launch, and a finished one never does.
//
//   intro    dark island → the core wakes around Mochi → "Coucou" → glass
//            panel forms → welcome line → Get started        (~2.6 s, skippable)
//   tour     three things Coucou does, one after another
//   setup    live checklist: Claude Code hooks, Anthropic key. Each row reads
//            the real state and links to the settings page that fixes it.

import { h } from "./dom";
import { LINE } from "./icons";
import { Bridge, onEvent } from "../core/bridge";
import { State } from "../core/state";
import { Sound } from "../core/sound";
import { button, icon } from "./ui";
import type { ViewActions, ViewHost } from "./views";

type Stage = "intro" | "tour" | "setup";

interface Check {
  el: HTMLElement;
  set(state: "loading" | "ok" | "todo" | "bad", status: string): void;
}

function checkRow(title: string, path: string, actionLabel: string, onAction: () => void): Check {
  const status = h("span", { class: "wl-status" });
  const action = button(actionLabel, "ghost", onAction, { icon: LINE.chevronRight });
  const el = h(
    "div",
    { class: "wl-check", "data-state": "loading" },
    h("span", { class: "wl-check-icon" }, icon(path, 13, 2), h("i", { class: "wl-tick" }, icon(LINE.check, 9, 3))),
    h("span", { class: "wl-check-text" }, h("b", { text: title }), status),
    action,
  );
  return {
    el,
    set(state, text) {
      el.dataset.state = state;
      status.textContent = text;
      action.style.visibility = state === "ok" ? "hidden" : "visible";
    },
  };
}

export function buildWelcome(actions: ViewActions): ViewHost {
  // The awakening core sits behind Mochi (Mochi is drawn by the island).
  const particles = h(
    "span",
    { class: "fx-particles wl-particles" },
    ...Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2;
      return h("i", {
        style: `--px:${50 + Math.cos(a) * 18}%;--py:${50 + Math.sin(a) * 18}%;--dx:${Math.cos(a) * 46}px;--dy:${Math.sin(a) * 46}px;--pd:${3.2 + (i % 4) * 0.6}s;--pdelay:${(i * 0.27).toFixed(2)}s;--ps:${i % 3 === 0 ? 3 : 2}px`,
      });
    }),
  );
  const coreArt = h(
    "div",
    { class: "wl-core" },
    h("i", { class: "wl-glow" }),
    h("i", { class: "wl-ring a" }),
    h("i", { class: "wl-ring b" }),
    h("i", { class: "wl-ring c" }),
    particles,
  );

  // ── Intro ──
  const getStarted = button("Get started", "primary", () => go("tour"), { icon: LINE.chevronRight });
  getStarted.classList.add("fx-magnetic");
  const intro = h(
    "div",
    { class: "wl-stage", "data-stage": "intro" },
    h("span", { class: "wl-eyebrow", text: "COUCOU" }),
    h("h1", { class: "wl-title fx-gradient-text", text: "Your AI, at the top of your screen." }),
    h("p", { class: "wl-sub", text: "Watch Claude Code work, answer its questions and permissions, and chat with Claude — without leaving what you're doing." }),
    h("div", { class: "actions" }, getStarted, button("Skip", "ghost", () => go("setup"))),
  );

  // ── Tour ──
  const feature = (path: string, title: string, text: string, i: number) =>
    h(
      "div",
      { class: "wl-feature", style: `--i:${i}` },
      h("span", { class: "wl-feature-icon" }, icon(path, 14, 2)),
      h("span", {}, h("b", { text: title }), h("span", { text })),
    );
  const tour = h(
    "div",
    { class: "wl-stage", "data-stage": "tour" },
    h("span", { class: "wl-eyebrow", text: "WHAT IT DOES" }),
    h(
      "div",
      { class: "wl-features" },
      feature(LINE.activity, "Live Claude Code activity", "Thinking, reading, editing, running — as it happens, from any terminal.", 0),
      feature(LINE.shieldCheck, "Permissions, answered here", "See the exact command, then Allow or Deny. Nothing is ever approved without your click.", 1),
      feature(LINE.sparkle, "Chat and drop files", "Ask Claude anything, or drop a file on Mochi and ask about it.", 2),
    ),
    h("div", { class: "actions" }, button("Continue", "primary", () => go("setup"), { icon: LINE.chevronRight }), button("Back", "ghost", () => go("intro"))),
  );

  // ── Setup ──
  const hooks = checkRow("Claude Code hooks", LINE.terminal, "Set up", () => actions.openSettingsPage("claude-code"));
  const key = checkRow("Anthropic API key", LINE.key, "Add key", () => actions.openSettingsPage("claude"));
  const finish = button("Finish", "primary", () => void complete(), { icon: LINE.check });
  finish.classList.add("fx-magnetic");
  const note = h("span", { class: "wl-note" });
  const setup = h(
    "div",
    { class: "wl-stage", "data-stage": "setup" },
    h("span", { class: "wl-eyebrow", text: "SET UP" }),
    h("div", { class: "wl-checks" }, hooks.el, key.el),
    h("div", { class: "actions" }, finish, button("Check again", "ghost", () => void refresh(), { icon: LINE.refresh }), note),
  );

  const panel = h("div", { class: "wl-panel" }, intro, tour, setup);
  const el = h("div", { class: "view welcome" }, h("div", { class: "card fx-glass fx-holo wl-card" }, coreArt, panel));

  let stage: Stage = "intro";
  let timers: number[] = [];
  let unlisten: (() => void)[] = [];

  function go(next: Stage) {
    Sound.play("blip");
    stage = next;
    el.dataset.stage = next;
    if (next === "setup") void refresh();
  }

  /** Reads the real state of each step; nothing here is assumed. */
  async function refresh() {
    hooks.set("loading", "Checking…");
    key.set("loading", "Checking…");
    const status = await Bridge.hooksStatus();
    if (!status) hooks.set("todo", "Open Settings to install them");
    else if (status.installed) hooks.set("ok", "Installed — sessions will show up here");
    else if (!status.hookReady) hooks.set("bad", "The relay is missing — Settings explains how to fix it");
    else hooks.set("todo", "Not installed yet — you'll review the change first");

    const present = await Bridge.secretPresent("anthropic-api-key");
    State.apiKeyPresent = present;
    if (!present) {
      key.set("todo", "Optional — only the chat needs it");
      return;
    }
    const check = await Bridge.claudeCheckKey();
    if (!check || check.status === "connected") {
      key.set("ok", check ? "Connected" : "Saved");
      if (check) State.apiConnected = true;
    } else {
      key.set("bad", check.detail);
      State.apiConnected = false;
    }
  }

  async function complete() {
    State.settings.onboarded = true;
    await Bridge.saveSettings(State.settings);
    State.log({ text: "Setup complete", tone: "success", icon: LINE.checkCircle, color: "#34D399" });
    Sound.play("finish");
    actions.setView(State.defaultView());
  }

  return {
    el,
    show() {
      // Each time it opens: dark → core → identity → panel → text.
      stage = "intro";
      el.dataset.stage = "intro";
      el.classList.remove("awake", "formed", "spoken");
      void el.offsetWidth;
      timers.forEach(clearTimeout);
      timers = [
        window.setTimeout(() => el.classList.add("awake"), 120),
        window.setTimeout(() => el.classList.add("formed"), 900),
        window.setTimeout(() => el.classList.add("spoken"), 1500),
      ];
      Sound.play("greet");
      // Hooks installed or a key saved in Settings: re-read the checklist.
      for (const name of ["settings-changed", "secrets-changed"]) {
        void onEvent(name, () => {
          if (stage === "setup") void refresh();
        }).then((u) => unlisten.push(u));
      }
      note.textContent = "You can change all of this later in Settings.";
    },
    hide() {
      timers.forEach(clearTimeout);
      timers = [];
      unlisten.forEach((u) => u());
      unlisten = [];
    },
    sync() {},
  };
}
