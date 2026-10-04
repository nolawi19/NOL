// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent, sendTo } from "./core/bridge";
import { installPointerFx } from "./fx/pointer";
import { Sound } from "./core/sound";
import { State, type ScreenAccess, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { LINE } from "./views/icons";

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
    State.display = { width: boot.screen.width, height: boot.screen.height, scale: boot.screen.scale };
    State.version = boot.version;
  }
  installPointerFx();
  const refreshKey = async () => {
    State.apiKeyPresent = await Bridge.secretPresent("anthropic-api-key");
    if (!State.apiKeyPresent) State.apiConnected = null;
    State.notify();
  };
  void refreshKey();
  island.applySettings();
  State.loadIntegrationTasks();
  if (boot && !boot.cursorPoll) island.followPageCursor();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "hide":
        island.hide();
        break;
      case "collapse":
        island.collapse();
        break;
      case "pause":
        setPaused(!State.paused);
        // Paused means paused: screen access ends too.
        if (State.paused && State.screen.active) void sendTo("settings", "screen-share-stop", null);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  // Screen access is held by the settings window; the island shows it.
  await onEvent<ScreenAccess>("screen-share", (s) => {
    const was = State.screen.active;
    State.screen = s;
    if (s.active !== was) {
      State.log({
        text: s.active ? "Screen access started" : "Screen access stopped",
        detail: s.label ?? undefined,
        tone: s.active ? "alert" : "info",
        icon: LINE.screen,
        color: s.active ? "#F4505E" : "#9AA3B2",
      });
      // Never hidden while active: make sure the indicator can be seen.
      if (s.active) island.reveal();
    }
    State.notify();
  });
  void sendTo("settings", "screen-share-query", null);

  // A screenshot taken in Settings → Screen, attached to the chat.
  await onEvent<{ name: string; path: string }>("chat-attach", (f) => island.attachFile(f.name, f.path));
  await onEvent<null>("show-welcome", () => island.showWelcome());
  await onEvent<null>("secrets-changed", () => void refreshKey());

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
  });

  registerHookHandlers(island);
  registerIntegrationHandlers(island);

  // First launch (or an unfinished setup) opens on the introduction; every
  // launch after that greets as before.
  if (State.settings.onboarded) island.launch();
  else island.showWelcome();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
