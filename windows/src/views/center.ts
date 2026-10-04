// Command center — the island, unfolded: what is happening on this computer,
// in one glance. Every line here comes from real state (hook events, the
// chat, Rust's display info, the screen-access bridge, this device's
// identity). Where something doesn't exist yet — a paired phone — it says so.

import { h, clear } from "./dom";
import { LINE } from "./icons";
import { State, type TimelineEntry } from "../core/state";
import { primaryPhase, STATE_COLOR } from "../core/activity";
import { sendTo } from "../core/bridge";
import { shortFingerprint, thisDevice } from "../core/devices";
import { icon } from "./ui";
import type { ViewActions, ViewHost } from "./views";

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function entryRow(e: TimelineEntry, fresh: boolean): HTMLElement {
  const row = h(
    "div",
    { class: fresh ? "tl-row fresh" : "tl-row", "data-tone": e.tone, style: `--c:${e.color}` },
    h("span", { class: "tl-icon" }, icon(e.icon, 10, 2.2)),
    h("span", { class: "tl-text" }, h("b", { text: e.text }), e.detail ? h("span", { text: e.detail }) : null),
    h("time", { class: "tl-ago", "data-at": String(e.at), text: ago(e.at) }),
  );
  return row;
}

interface Tile {
  el: HTMLElement;
  set(state: "ok" | "warn" | "bad" | "off" | "live", value: string, sub: string): void;
}

function tile(title: string, path: string, onClick?: () => void): Tile {
  const value = h("b", { class: "tile-value" });
  const sub = h("span", { class: "tile-sub" });
  const el = h(
    onClick ? "button" : "div",
    { class: "tile", type: onClick ? "button" : undefined },
    h("div", { class: "tile-head" }, icon(path, 11, 2), h("span", { text: title }), h("i", { class: "tile-dot" })),
    value,
    sub,
  );
  if (onClick) el.addEventListener("click", onClick);
  return {
    el,
    set(state, v, s) {
      el.dataset.state = state;
      if (value.textContent !== v) value.textContent = v;
      if (sub.textContent !== s) sub.textContent = s;
    },
  };
}

export function buildCenter(actions: ViewActions): ViewHost {
  const phaseLabel = h("span", { class: "cc-phase" });
  const list = h("div", { class: "tl-list" });
  const empty = h(
    "div",
    { class: "tl-empty" },
    icon(LINE.activity, 14, 2),
    h("span", { text: "Nothing yet. Claude Code events, permissions, integrations and chats appear here as they happen." }),
  );
  const activity = h(
    "div",
    { class: "cc-activity card fx-glass" },
    h("div", { class: "cc-head" }, h("span", { class: "cc-title", text: "Live activity" }), phaseLabel),
    list,
  );

  const claude = tile("Claude Code", LINE.terminal, () => actions.setView("overview"));
  const chat = tile("Claude chat", LINE.sparkle, () => actions.setView("prompt"));
  const requests = tile("Requests", LINE.shield, () => {
    if (State.pendingApproval) actions.setView("approval");
  });
  const screen = tile("Screen", LINE.screen, () => {
    if (State.screen.active) void sendTo("settings", "screen-share-stop", null);
    else actions.openSettingsPage("screen");
  });
  const computer = tile("This computer", LINE.monitor);
  const devices = tile("Devices", LINE.phone, () => actions.openSettingsPage("devices"));
  const tiles = h(
    "div",
    { class: "cc-tiles" },
    claude.el, chat.el, requests.el, screen.el, computer.el, devices.el,
  );

  const el = h("div", { class: "view center" }, h("div", { class: "cc-grid" }, activity, tiles));

  let shownIds = new Set<number>();
  let clock: number | null = null;
  let fingerprint = "";

  function refreshTimes() {
    for (const t of list.querySelectorAll<HTMLTimeElement>("time[data-at]")) {
      t.textContent = ago(Number(t.dataset.at));
    }
  }

  return {
    el,
    show() {
      if (clock == null) clock = window.setInterval(refreshTimes, 10_000);
      if (!fingerprint) {
        void thisDevice()
          .then((d) => {
            fingerprint = shortFingerprint(d.fingerprint);
            State.notify();
          })
          .catch(() => {
            fingerprint = "unavailable";
          });
      }
    },
    hide() {
      if (clock != null) window.clearInterval(clock);
      clock = null;
    },
    sync() {
      // Timeline: newest first, new entries slide in.
      const entries = State.timeline.slice(0, 12);
      const ids = entries.map((e) => e.id).join(",");
      if (list.dataset.ids !== ids) {
        list.dataset.ids = ids;
        clear(list);
        if (entries.length === 0) list.append(empty);
        for (const e of entries) list.append(entryRow(e, shownIds.size > 0 && !shownIds.has(e.id)));
        shownIds = new Set(entries.map((e) => e.id));
      }

      const phase = primaryPhase(State.tasks, State.focusId);
      phaseLabel.textContent = phase ? phase.label : "Idle";
      phaseLabel.style.setProperty("--c", phase?.color ?? STATE_COLOR.idle);
      phaseLabel.dataset.tone = phase?.tone ?? "idle";

      // Claude Code
      const task = State.tasks.find((t) => t.id === "integration_claude");
      const hooks = State.settings.hooksInstalled;
      const session = task && (task.state !== "idle" || task.steps.length > 0);
      claude.set(
        !hooks ? "bad" : session ? "live" : "ok",
        !hooks ? "Hooks off" : session ? (task!.name === "VS Code" ? "Session" : task!.name) : "Ready",
        !hooks ? "Install them in Settings" : session ? (phase && phase.task.id === task!.id ? phase.label : "Idle") : "No session running",
      );

      // Chat (Anthropic API)
      const key = State.apiKeyPresent;
      chat.set(
        key === false ? "off" : State.apiConnected === false ? "bad" : State.apiConnected ? "ok" : "warn",
        key === false ? "No API key" : State.apiConnected === false ? "Key rejected" : State.apiConnected ? "Connected" : key ? "Key saved" : "Unknown",
        State.chatHistory.length ? `${State.chatHistory.length} message${State.chatHistory.length === 1 ? "" : "s"}` : "Anthropic API",
      );

      // Requests
      const req = State.pendingApproval;
      requests.set(req ? "warn" : "ok", req ? "1 waiting" : "None waiting", req ? req.tool : "Permission requests land here");

      // Screen access
      const sc = State.screen;
      screen.set(sc.active ? "live" : "off", sc.active ? "ACTIVE" : "Off", sc.active ? "Click to stop" : "Share from Settings");

      // This computer
      const d = State.display;
      computer.set(
        "ok",
        d ? `${Math.round(d.width * d.scale)}×${Math.round(d.height * d.scale)}` : "This computer",
        d ? `${Math.round(d.scale * 100)}% scale${fingerprint ? ` · ${fingerprint}` : ""}` : fingerprint || "Identity loading…",
      );

      // Devices: honest — no mobile app exists yet.
      devices.set("off", "No phone", "Needs Coucou Mobile");
    },
  };
}
