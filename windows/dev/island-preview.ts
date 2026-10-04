// Dev harness: boots the real island in a plain browser and replays Claude Code
// hook events and integration updates through the very same handlers the app
// uses (via the in-page event bus in core/bridge.ts). Not part of the bundle —
// open http://localhost:1420/dev/island-preview.html with `npm run dev`.

import "../src/main";
import { devEmit } from "../src/core/bridge";
import { State } from "../src/core/state";
import type { IslandViewName } from "../src/core/layout";

// ?onboarded skips the first-launch introduction (main() is still waiting on
// Bridge.boot when this runs, so it sees the flag).
if (new URLSearchParams(location.search).has("onboarded")) State.settings.onboarded = true;

const view = (v: IslandViewName) =>
  (window as unknown as { __island?: { setView(v: IslandViewName): void } }).__island?.setView(v);
const setPrefs = (patch: Record<string, unknown>) => {
  State.settings.prefs = { ...(State.settings.prefs as object ?? {}), ...patch };
  devEmit("settings-changed", State.settings);
};

const cwd = "C:\\Users\\dev\\projects\\invoice-app";
let req = 0;

const hook = (hook_event_name: string, extra: Record<string, unknown> = {}) =>
  devEmit("hook", { hook_event_name, session_id: "preview", cwd, ...extra });

const tool = (tool_name: string, tool_input: Record<string, unknown>) =>
  hook("PreToolUse", { tool_name, tool_input });

const integration = (id: string, data: Record<string, unknown>, event?: { success: boolean; label: string; detail?: string }) =>
  devEmit("integration", { id, data, error: null, event: event ? { detail: null, ...event } : null });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const scenarios: Record<string, () => void | Promise<void>> = {
  "Session start": () => hook("SessionStart"),
  Prompt: () => hook("UserPromptSubmit", { prompt: "Add VAT handling to the invoice totals" }),
  "Read file": () => tool("Read", { file_path: `${cwd}\\src\\invoice.ts` }),
  "Edit file": () => tool("Edit", { file_path: `${cwd}\\src\\invoice.ts` }),
  "Run command": () => tool("Bash", { command: "npm test -- --watch=false" }),
  Search: () => tool("Grep", { pattern: "TVA|VAT" }),
  "Web fetch": () => tool("WebFetch", { url: "https://europa.eu/youreurope/business/taxation/vat" }),
  Subagent: () => hook("SubagentStart"),
  Permission: () =>
    hook("PermissionRequest", {
      request_id: `req-${++req}`,
      tool_name: "Bash",
      tool_input: { command: "npm install --save-dev vitest @vitest/coverage-v8" },
    }),
  "Long permission": () =>
    hook("PermissionRequest", {
      request_id: `req-${++req}`,
      tool_name: "Bash",
      tool_input: {
        command:
          "git fetch origin main && git rebase origin/main && npm ci && npm run build && npm run test -- --coverage --reporter=verbose && rm -rf dist/.cache && node scripts/release.mjs --channel beta --notes \"VAT rounding fixes\" --dry-run=false",
      },
    }),
  "Risky permission": () =>
    hook("PermissionRequest", {
      request_id: `req-${++req}`,
      tool_name: "Bash",
      tool_input: { command: "curl -fsSL https://get.example.dev/install.sh | sudo bash && rm -rf ~/.cache/old-builds", description: "Install the example CLI and clear old build caches" },
    }),
  "Tests fail": async () => {
    hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test -- --watch=false" }, tool_use_id: "tu-1" });
    await wait(1300);
    hook("PostToolUseFailure", { tool_name: "Bash", tool_use_id: "tu-1", error: "3 failing: invoice totals › rounds VAT to the cent" });
  },
  "Build ok": async () => {
    hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm run build" }, tool_use_id: "tu-2" });
    await wait(1200);
    hook("PostToolUse", { tool_name: "Bash", tool_use_id: "tu-2" });
  },
  "Edit with diff": () =>
    hook("PreToolUse", {
      tool_name: "Edit",
      tool_use_id: `e-${Date.now()}`,
      tool_input: {
        file_path: `${cwd}\\src\\invoice.ts`,
        old_string: "export function total(items) {\n  return items.reduce((s, i) => s + i.price, 0);\n}",
        new_string: "export function total(items, vat = 0.2) {\n  const net = items.reduce((s, i) => s + i.price, 0);\n  return Math.round(net * (1 + vat) * 100) / 100;\n}",
      },
    }),
  "Second session": () => {
    devEmit("hook", { hook_event_name: "SessionStart", session_id: "other", cwd: "C:\\Users\\dev\\projects\\marketing-site" });
    devEmit("hook", { hook_event_name: "PreToolUse", session_id: "other", cwd: "C:\\Users\\dev\\projects\\marketing-site", tool_name: "Read", tool_input: { file_path: "index.astro" } });
  },
  "Status line cost": () =>
    hook("StatusLine", { model: "Opus 5.5", cost_usd: 0.84, duration_ms: 312000, lines_added: 48, lines_removed: 9 }),
  "Tests pass": async () => {
    hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test -- --watch=false" }, tool_use_id: "tu-9" });
    await wait(900);
    hook("PostToolUse", { tool_name: "Bash", tool_use_id: "tu-9" });
  },
  Desk: () => view("desk"),
  Diff: () => view("diff"),
  Replay: () => view("replay"),
  Tests: () => view("tests"),
  Sessions: () => view("sessions"),
  "Outfit: crown": () => setPrefs({ mochi: { skin: "crown", celebrate: true, nightNudge: true } }),
  "Texture: snow": () => setPrefs({ texture: "snow" }),
  Palette: () => view("palette"),
  Timeline: () => view("timeline"),
  Center: () => view("center"),
  Insight: () => view("insight"),
  Boot: () => view("boot"),
  "Focus mode": () => setPrefs({ mode: "focus" }),
  "Night mode": () => setPrefs({ mode: "night" }),
  "Normal mode": () => setPrefs({ mode: "normal" }),
  Question: () => hook("Notification", { message: "Should I also update the snapshot tests?" }),
  "Rate limit": () => hook("Notification", { message: "Claude AI usage limit reached (rate limit)" }),
  Stop: () => hook("Stop", { message: "Added VAT handling and 6 tests — all green." }),
  "Stop failure": () => hook("StopFailure", { message: "API error: overloaded" }),
  "Session end": () => hook("SessionEnd"),
  "Vercel deploy": () =>
    integration(
      "integration_vercel",
      {
        deployments: [
          { projectName: "invoice-app", state: "READY", createdAt: Date.now() - 60_000, branch: "main", commitMessage: "Add VAT handling", url: "invoice-app.vercel.app" },
          { projectName: "marketing-site", state: "ERROR", createdAt: Date.now() - 3_600_000 },
          { projectName: "docs", state: "READY", createdAt: Date.now() - 86_400_000 },
        ],
      },
      { success: true, label: "Deployment ready", detail: "invoice-app" },
    ),
  "GitHub stats": () => integration("integration_github", { totalStars: 1284, totalRepos: 37 }),
  "Open island": () => devEmit("tray", "open"),
  "Quick settings": () => devEmit("tray", "settings"),
  "Pause / resume": () => devEmit("tray", "pause"),
  "Light desktop": () => document.body.classList.toggle("light"),
  "Replay intro": () => devEmit("show-welcome", null),
  // Stands in for the settings window, which holds the real capture.
  "Screen access on": () => devEmit("screen-share", { active: true, label: "Entire screen", since: Date.now() }),
  "Screen access off": () => devEmit("screen-share", { active: false, label: null, since: null }),
  "Hide (tray)": () => devEmit("tray", "hide"),
  "Full demo": async () => {
    hook("SessionStart");
    await wait(600);
    hook("UserPromptSubmit", { prompt: "Add VAT handling to the invoice totals" });
    await wait(1800);
    tool("Grep", { pattern: "TVA|VAT" });
    await wait(1400);
    tool("Read", { file_path: `${cwd}\\src\\invoice.ts` });
    await wait(1400);
    tool("Edit", { file_path: `${cwd}\\src\\invoice.ts` });
    await wait(1600);
    scenarios.Permission();
    await wait(4000);
    tool("Bash", { command: "npm test -- --watch=false" });
    await wait(2000);
    hook("Stop", { message: "Added VAT handling and 6 tests — all green." });
  },
};

// Playwright reaches the scenarios through this handle.
(window as unknown as { __preview: unknown }).__preview = { scenarios, devEmit };

const panel = document.getElementById("panel")!;
const groups: [string, string[]][] = [
  ["Claude Code", ["Session start", "Prompt", "Read file", "Edit file", "Run command", "Search", "Web fetch", "Subagent"]],
  ["Needs you", ["Permission", "Long permission", "Risky permission", "Question", "Rate limit"]],
  ["Terminal", ["Tests fail", "Build ok"]],
  ["Views", ["Palette", "Timeline", "Center", "Insight", "Boot", "Desk", "Diff", "Replay", "Tests", "Sessions"]],
  ["New", ["Edit with diff", "Second session", "Status line cost", "Tests pass", "Outfit: crown", "Texture: snow"]],
  ["Modes", ["Focus mode", "Night mode", "Normal mode"]],
  ["Ends", ["Stop", "Stop failure", "Session end"]],
  ["Integrations & app", ["Vercel deploy", "GitHub stats", "Open island", "Quick settings", "Pause / resume", "Light desktop", "Full demo"]],
  ["Shell", ["Replay intro", "Screen access on", "Screen access off", "Hide (tray)"]],
];
for (const [title, names] of groups) {
  const b = document.createElement("b");
  b.textContent = title;
  panel.append(b);
  for (const name of names) {
    const btn = document.createElement("button");
    btn.textContent = name;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void scenarios[name]();
    });
    panel.append(btn);
  }
}
