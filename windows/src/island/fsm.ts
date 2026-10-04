// Island open/close FSM — port of IslandStateMachine.swift, minus every timer.
// No DOM, no Tauri: it only reports transitions.
//
// Coucou never closes, collapses or hides on its own. The macOS port folded
// the island after 15 s without the pointer and hid it after 60 s; this build
// does neither. Size changes come from exactly two sources:
//   · the user — a click, Escape, the collapse / hide buttons, the tray;
//   · something that needs the user — a permission request or a finished
//     session opens the island (it never closes it).

export type FsmState = "hidden" | "petit" | "home" | "coucou";

export class IslandStateMachine {
  state: FsmState = "hidden";

  onTransition: ((from: FsmState, to: FsmState) => void) | null = null;

  /**
   * Kept for callers that mark an alert as waiting for an answer. Nothing
   * closes the island any more, so it no longer changes behaviour.
   */
  pinned = false;

  // ── Inputs ──────────────────────────────────────────────────────────────────

  launch() {
    this.transition("coucou");
  }

  /** The pointer reached the wake strip: peek out. Leaving changes nothing. */
  mouseEntered() {
    if (this.state === "hidden") this.transition("petit");
  }

  /** Inactivity is not a close request: the island stays as it is. */
  mouseLeft() {}

  click() {
    if (this.state === "petit") this.transition("home");
  }

  /** The launch greeting ended: settle into the open island and stay there. */
  greetComplete() {
    if (this.state === "coucou") this.transition("home");
  }

  /** Non-alert work event: show the compact island if it was hidden. */
  reveal() {
    if (this.state === "hidden") this.transition("petit");
  }

  /** Alert or explicit request: open straight to expanded. */
  forceHome() {
    this.transition("home");
  }

  /** Explicit collapse (collapse button, Escape, Done). */
  forcePetit() {
    this.transition("petit");
  }

  /** Explicit hide (hide button, tray). */
  forceHidden() {
    this.transition("hidden");
  }

  private transition(next: FsmState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next);
  }
}
