// Command center — the island, unfolded: what is happening on this computer,
// in one glance. Every line here comes from real state (hook events, the
// chat, Rust's display info, the screen-access bridge, this device's
// identity). Where something doesn't exist yet — a paired phone — it says so.

import { h, clear } from "./dom";
import { LINE } from "./icons";
import { CORE_STATE_LABEL, State, type TimelineEntry } from "../core/state";
import { formatDuration, primaryPhase, STATE_COLOR } from "../core/activity";
import { Bridge, sendTo, type ProjectInfo, type SystemStats } from "../core/bridge";
import { Session, WORK_MODE_LABEL } from "../core/session";
import { COMMAND_CLASS_LABEL } from "../core/risk";
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

function entryRow(e: TimelineEntry, fresh: boolean, open?: (ref: string) => void): HTMLElement {
  const row = h(
    "div",
    { class: `${fresh ? "tl-row fresh" : "tl-row"}${e.ref ? " has-ref" : ""}`, "data-tone": e.tone, style: `--c:${e.color}`, title: e.ref ? "Show the change" : undefined },
    h("span", { class: "tl-icon" }, icon(e.icon, 10, 2.2)),
    h("span", { class: "tl-text" }, h("b", { text: e.text }), e.detail ? h("span", { text: e.detail }) : null),
    h("time", { class: "tl-ago", "data-at": String(e.at), text: ago(e.at) }),
  );
  if (e.ref && open) row.addEventListener("click", () => open(e.ref!));
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
  // "Now": the core's state by name, the kind of work, what's running, where.
  const nowState = h("b", { class: "cc-state" });
  const nowMode = h("span", { class: "cc-mode" });
  const nowRun = h("span", { class: "cc-run" });
  const nowProj = h("span", { class: "cc-proj" });
  const now = h(
    "div",
    { class: "cc-now" },
    h("div", { class: "cc-now-line" }, nowState, nowMode, nowRun),
    h("div", { class: "cc-now-line sub" }, nowProj),
  );
  const allBtn = h("button", { class: "cc-all", type: "button", title: "Open the full timeline" }, h("span", { text: "Timeline" }), icon(LINE.chevronRight, 9, 2.4));
  allBtn.addEventListener("click", () => actions.setView("timeline"));
  const activity = h(
    "div",
    { class: "cc-activity card fx-glass" },
    now,
    h("div", { class: "cc-head" }, h("span", { class: "cc-title", text: "Live activity" }), phaseLabel, allBtn),
    list,
  );

  const claude = tile("Claude", LINE.terminal, () => actions.setView("overview"));
  const chat = tile("Chat", LINE.sparkle, () => actions.setView("prompt"));
  const requests = tile("Requests", LINE.shield, () => {
    if (State.pendingApproval) actions.setView("approval");
  });
  const screen = tile("Screen", LINE.screen, () => {
    if (State.screen.active) void sendTo("settings", "screen-share-stop", null);
    else actions.openSettingsPage("screen");
  });
  const terminal = tile("Terminal", LINE.terminal, () => actions.setView("timeline"));
  const system = tile("System", LINE.monitor);
  const automations = tile("Rules", LINE.bolt, () => actions.openSettingsPage("automations"));
  const devices = tile("Devices", LINE.phone, () => actions.openSettingsPage("devices"));
  const tiles = h(
    "div",
    { class: "cc-tiles eight" },
    claude.el, requests.el, terminal.el, system.el, chat.el, screen.el, automations.el, devices.el,
  );

  const el = h("div", { class: "view center" }, h("div", { class: "cc-grid" }, activity, tiles));

  let shownIds = new Set<number>();
  let clock: number | null = null;
  let fingerprint = "";
  /** Polled every 2 s while the center is on screen, never otherwise. */
  let stats: SystemStats | null = null;
  let statsTimer: number | null = null;
  let project: ProjectInfo | null = null;
  let probedCwd: string | null = null;

  async function pollStats() {
    stats = await Bridge.systemStats();
    // The core breathes a little faster when the machine is busy.
    const cpu = stats?.cpuPercent;
    document.documentElement.style.setProperty("--energy", cpu == null ? "0" : (cpu / 100).toFixed(2));
    State.notify();
  }

  function probe() {
    const cwd = State.tasks.find((t) => t.id === "integration_claude")?.sessionCwd ?? null;
    if (!cwd || cwd === probedCwd) return;
    probedCwd = cwd;
    void Bridge.projectProbe(cwd).then((p) => {
      project = p;
      State.notify();
    });
  }

  function refreshTimes() {
    for (const t of list.querySelectorAll<HTMLTimeElement>("time[data-at]")) {
      t.textContent = ago(Number(t.dataset.at));
    }
  }

  return {
    el,
    show() {
      if (clock == null) clock = window.setInterval(() => {
        refreshTimes();
        State.notify();
      }, 1000);
      if (statsTimer == null) {
        void pollStats();
        statsTimer = window.setInterval(() => void pollStats(), 2000);
      }
      probe();
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
      if (statsTimer != null) window.clearInterval(statsTimer);
      statsTimer = null;
      document.documentElement.style.setProperty("--energy", "0");
    },
    sync() {
      // Timeline: newest first, new entries slide in.
      const entries = State.timeline.slice(0, 12);
      const ids = entries.map((e) => e.id).join(",");
      if (list.dataset.ids !== ids) {
        list.dataset.ids = ids;
        clear(list);
        if (entries.length === 0) list.append(empty);
        for (const e of entries) list.append(entryRow(e, shownIds.size > 0 && !shownIds.has(e.id), (r) => actions.openDiff(r)));
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

      // Now
      probe();
      const cs = State.coreState;
      nowState.textContent = CORE_STATE_LABEL[cs];
      nowState.dataset.state = cs;
      nowState.style.setProperty("--c", phase?.color ?? STATE_COLOR.idle);
      const snap = Session.snapshot();
      nowMode.textContent = WORK_MODE_LABEL[snap.workMode];
      nowMode.hidden = snap.workMode === "idle";
      const run = snap.running;
      nowRun.textContent = run
        ? `${run.commandClass ? COMMAND_CLASS_LABEL[run.commandClass] : run.tool} · ${formatDuration(Date.now() - run.start)}`
        : "";
      nowRun.title = run?.target ?? "";
      const projName = project?.name ?? (task && task.name !== "VS Code" ? task.name : null);
      nowProj.textContent = projName
        ? [
          projName,
          project?.branch ? `⎇ ${project.branch}` : project?.detached ? "⎇ detached" : project && !project.git ? "no git" : null,
          project?.markers.length ? project.markers.slice(0, 3).join(", ") : null,
        ].filter(Boolean).join(" · ")
        : "No Claude Code session yet";

      // Terminal: what's running, else how the last command went.
      const last = [...Session.records].reverse().find((r) => r.commandClass != null);
      if (run?.commandClass) {
        terminal.set("live", `${COMMAND_CLASS_LABEL[run.commandClass]} · ${formatDuration(Date.now() - run.start)}`, run.target);
      } else if (last) {
        const took = last.end ? formatDuration(last.end - last.start) : "";
        terminal.set(last.outcome === "failed" ? "bad" : "ok", `${last.outcome === "failed" ? "Failed" : "Done"}${took ? ` · ${took}` : ""}`, last.target);
      } else {
        terminal.set("off", "No commands", "Shell commands Claude runs appear here");
      }

      // This computer: only what the OS reports.
      const d = State.display;
      if (stats) {
        const mem = stats.memTotal && stats.memUsed != null ? Math.round((stats.memUsed / stats.memTotal) * 100) : null;
        const cpu = stats.cpuPercent == null ? "…" : `${Math.round(stats.cpuPercent)}%`;
        const up = stats.uptimeSecs != null ? `up ${formatDuration(stats.uptimeSecs * 1000)}` : null;
        const bat = stats.batteryPercent != null ? `battery ${stats.batteryPercent}%${stats.charging ? " ⚡" : ""}` : null;
        system.set(
          (stats.cpuPercent ?? 0) > 85 || (mem ?? 0) > 90 ? "warn" : "ok",
          `CPU ${cpu}${mem != null ? ` · RAM ${mem}%` : ""}`,
          [bat, up, d ? `${Math.round(d.width * d.scale)}×${Math.round(d.height * d.scale)}` : null].filter(Boolean).join(" · ") || fingerprint,
        );
      } else {
        system.set("ok", d ? `${Math.round(d.width * d.scale)}×${Math.round(d.height * d.scale)}` : "This computer", fingerprint || "Reading…");
      }

      // Automations
      const rules = State.prefs.automations;
      const enabled = rules.filter((r) => r.enabled).length;
      const lastRun = State.timeline.find((e) => e.cat === "automation");
      automations.set(enabled ? "ok" : "off", enabled ? `${enabled} on` : rules.length ? "All off" : "None", lastRun ? `${lastRun.text.replace(/^Automation · /, "")} · ${ago(lastRun.at)}` : "Create rules in Settings");

      // Devices: honest — no mobile app exists yet.
      devices.set("off", "No phone", "Needs Coucou Mobile");
    },
  };
}
