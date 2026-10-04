// Changing preferences from the island: one place that writes, debounces the
// save to settings.json and tells the island to re-apply (sounds, appearance,
// schedules). The settings window has its own copy of this logic.

import { Bridge } from "./bridge";
import { type Prefs } from "./prefs";
import { State } from "./state";

let timer: number | null = null;
let listener: (() => void) | null = null;

export function onPrefsChanged(fn: () => void) {
  listener = fn;
}

export function updatePrefs(mutate: (p: Prefs) => void) {
  const next = structuredClone(State.prefs);
  mutate(next);
  State.settings.prefs = next;
  listener?.();
  if (timer != null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void Bridge.saveSettings(State.settings);
  }, 400);
  State.notify();
}
