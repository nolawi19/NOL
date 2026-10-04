// Integration events → island state. Port of the `handle…` methods in the Swift
// pollers: a genuinely new item flips the pill to finished/error, badges it when
// the pill isn't focused, plays a sound, and clears itself after 60 s.

import { onEvent, Bridge, type IntegrationUpdate } from "../core/bridge";
import { Sound } from "../core/sound";
import { Automation } from "../core/automation";
import { MODES } from "../core/prefs";
import { Schedule } from "../core/schedule";
import { State } from "../core/state";
import type { Island } from "./island";
import { LINE } from "../views/icons";

/** Which Credential Manager key backs each pill. */
const KEY_FOR: Record<string, string> = {
  integration_stripe: "stripe-api-key",
  integration_github: "github-token",
  integration_vercel: "vercel-token",
  integration_n8n: "n8n-api-key",
  integration_resend: "resend-api-key",
  integration_notion: "notion-api-key",
  integration_calcom: "calcom-api-key",
  integration_sentry: "sentry-token",
  integration_linear: "linear-api-key",
  integration_jira: "jira-token",
};

const clearTimers = new Map<string, number>();

export function registerIntegrationHandlers(island: Island) {
  void onEvent<IntegrationUpdate>("integration", (update) => handle(island, update));
  void refreshConfigured();
}

/** Asks Rust which keys exist so the idle cards can say so. */
export async function refreshConfigured() {
  for (const [id, key] of Object.entries(KEY_FOR)) {
    const present = (await Bridge.secretPresent(key)) ?? false;
    const info = State.integrations[id] ?? { data: {}, error: null, loaded: false, configured: false };
    State.integrations[id] = { ...info, configured: present };
  }
  const hooks = State.settings.hooksInstalled;
  const claude = State.integrations.integration_claude ?? {
    data: {}, error: null, loaded: false, configured: false,
  };
  State.integrations.integration_claude = { ...claude, configured: hooks };
  State.notify();
}

function handle(island: Island, update: IntegrationUpdate) {
  if (State.paused) return;

  const previous = State.integrations[update.id];
  State.integrations[update.id] = {
    data: update.error ? (previous?.data ?? {}) : update.data,
    error: update.error,
    loaded: update.error ? (previous?.loaded ?? false) : true,
    configured: previous?.configured ?? true,
  };
  // A heads-up ten minutes before the next Cal.com booking.
  if (update.id === "integration_calcom" && !update.error) {
    const bookings = (update.data as { bookings?: { title: string; start: string }[] }).bookings ?? [];
    Schedule.bookings(bookings);
  }

  const event = update.event;
  if (event) {
    const task = State.tasks.find((t) => t.id === update.id);
    if (task) {
      task.state = event.success ? "finished" : "error";
      task.steps = event.detail ? [event.label, event.detail] : [event.label];
      task.stepIndex = task.steps.length - 1;
      if (State.focusId !== update.id) {
        task.pillBadge = event.success ? "finished" : "error";
      }
      Sound.play(event.success ? "finish" : "error");
      State.log({
        text: `${task.name} · ${event.label}`,
        detail: event.detail ?? undefined,
        tone: event.success ? "success" : "error",
        icon: event.success ? LINE.checkCircle : LINE.xCircle,
        color: event.success ? "#34D399" : "#F4505E",
        cat: "integration",
      });
      Automation.fire(event.success ? "integration-success" : "integration-failure", {
        project: task.name,
        text: `${task.name} · ${event.label}`,
        detail: event.detail ?? undefined,
        view: "overview",
      });
      State.showFlash(
        `${task.name} · ${event.label}`,
        event.success ? "#34D399" : "#F4505E",
        event.success ? "success" : "error",
      );
      // Same as the Swift pollers: show the compact island so the badge is seen,
      // but never steal the screen for a successful deploy.
      // Presentation and focus modes: nothing appears by itself.
      if (MODES[State.prefs.mode].autoOpen) island.reveal();

      const existing = clearTimers.get(update.id);
      if (existing != null) window.clearTimeout(existing);
      clearTimers.set(
        update.id,
        window.setTimeout(() => {
          clearTimers.delete(update.id);
          const t = State.tasks.find((x) => x.id === update.id);
          if (!t || (t.state !== "finished" && t.state !== "error")) return;
          t.state = "idle";
          t.steps = [];
          t.stepIndex = 0;
          t.pillBadge = null;
          State.notify();
        }, 60_000),
      );
    }
  }

  State.notify();
}
