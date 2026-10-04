// Automations: "when this happens, do that" — rules the user writes in
// Settings → Automations, run by the island.
//
// Triggers are real events only (hook events, matched tool results,
// integration pollers, the chat). Actions are only things this build can
// really do: flash the compact island, open it, play a sound, post to a
// webhook the user saved in the vault, ask Claude for a summary.
//
// There is deliberately no action that answers a permission request, runs a
// command, or changes a file. Every run is written to the timeline, and rules
// are rate-limited so a noisy session can't turn into a flood of webhooks.

import { Bridge, IS_TAURI } from "./bridge";
import { prefsOf, TRIGGERS, type ActionSpec, type AutomationRule, type TriggerId } from "./prefs";
import { Sound } from "./sound";
import { State } from "./state";
import { LINE } from "../views/icons";
import { Guard } from "./guard";
import type { IslandViewName } from "./layout";

export interface TriggerContext {
  project: string;
  /** "Session finished", "npm test failed"… */
  text: string;
  /** The command, error or message, when there is one. Only sent if the rule says so. */
  detail?: string;
  /** The view that shows this best when a rule opens the island. */
  view?: IslandViewName;
}

export interface AutomationHost {
  open(view: IslandViewName): void;
  summarize(): Promise<string>;
}

/** At most one run per rule every 10 s, and 30 per rule per hour. */
const MIN_GAP_MS = 10_000;
const HOURLY_CAP = 30;
const runs = new Map<string, number[]>();

let host: AutomationHost | null = null;

function allowed(rule: AutomationRule, now: number): boolean {
  const list = (runs.get(rule.id) ?? []).filter((t) => now - t < 3_600_000);
  runs.set(rule.id, list);
  if (list.length && now - list[list.length - 1] < MIN_GAP_MS) return false;
  if (list.length >= HOURLY_CAP) return false;
  list.push(now);
  return true;
}

function matches(rule: AutomationRule, trigger: TriggerId, ctx: TriggerContext): boolean {
  if (!rule.enabled || rule.trigger !== trigger || rule.actions.length === 0) return false;
  const want = rule.projectContains.trim().toLowerCase();
  return !want || ctx.project.toLowerCase().includes(want);
}

function logRun(rule: AutomationRule, outcome: string, ok: boolean) {
  State.log({
    text: `Automation · ${rule.name}`,
    detail: outcome,
    tone: ok ? "info" : "error",
    icon: LINE.bolt,
    color: ok ? "#A78BFA" : "#F4505E",
    cat: "automation",
  });
}

async function runAction(rule: AutomationRule, a: ActionSpec, trigger: TriggerId, ctx: TriggerContext): Promise<string> {
  switch (a.type) {
    case "flash":
      // The user asked for this flash in a rule: it shows in every mode.
      State.showFlash(`${rule.name} · ${ctx.text}`, "#A78BFA", "info", 6000, true);
      return "flashed";
    case "open":
      host?.open(ctx.view ?? State.defaultView());
      return "opened the island";
    case "sound":
      Sound.play(a.sound);
      return `played ${a.sound}`;
    case "webhook": {
      const meta = prefsOf(State.settings).webhooks.find((w) => w.slot === a.slot);
      if (!IS_TAURI) throw new Error("webhooks only run inside the app");
      const title = TRIGGERS.find((t) => t.id === trigger)?.title ?? trigger;
      // Without "include details" only the event and the project leave the
      // computer — never the command or message text.
      const text = a.details && ctx.detail
        ? `Coucou · ${title} · ${ctx.project}\n${ctx.text}\n${ctx.detail}`
        : `Coucou · ${title} · ${ctx.project}`;
      const status = await Bridge.webhookSend(a.slot, meta?.kind ?? "json", text);
      return `sent to ${meta?.label ?? a.slot} (${status})`;
    }
    case "summarize": {
      if (!host) throw new Error("not ready");
      await host.summarize();
      return "summary ready";
    }
  }
}

export const Automation = {
  init(h: AutomationHost) {
    host = h;
  },

  /** Runs every matching rule. Never throws; failures go to the timeline. */
  fire(trigger: TriggerId, ctx: TriggerContext) {
    // Paused, or on hold after the panic button: no automation runs.
    if (State.paused || Guard.hold) return;
    const rules = prefsOf(State.settings).automations;
    if (rules.length === 0) return;
    const now = Date.now();
    for (const rule of rules) {
      if (!matches(rule, trigger, ctx)) continue;
      if (!allowed(rule, now)) {
        logRun(rule, "skipped — ran moments ago (rate limit)", true);
        continue;
      }
      void (async () => {
        const done: string[] = [];
        for (const a of rule.actions) {
          try {
            done.push(await runAction(rule, a, trigger, ctx));
          } catch (err) {
            logRun(rule, `${a.type} failed: ${String((err as Error)?.message ?? err)}`, false);
            State.notify();
            return;
          }
        }
        logRun(rule, done.join(" · "), true);
        State.notify();
      })();
    }
  },
};
