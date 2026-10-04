// Dev harness: boots the real island in a plain browser and replays Claude Code
// hook events and integration updates through the very same handlers the app
// uses (via the in-page event bus in core/bridge.ts). Not part of the bundle —
// open http://localhost:1420/dev/island-preview.html with `npm run dev`.

import "../src/main";
import { devEmit } from "../src/core/bridge";

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
  ["Needs you", ["Permission", "Long permission", "Question", "Rate limit"]],
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
