// The energy core: the light around Mochi that shows what Claude is doing.
//
// It has no state of its own. The island hands it the current phase (from
// core/activity.ts, itself derived from hook events and the chat) and where
// Mochi is; CSS does the rest with transform/opacity animations keyed on
// data-kind and data-tone. Idle has no running animation, and a hidden island
// pauses everything (see the hidden rules in style.css).

import { h } from "../views/dom";
import type { ActivityKind, ActivityTone } from "../core/activity";

export type CoreKind = ActivityKind | "idle" | "chat";

export class EnergyCore {
  readonly el: HTMLElement;
  private size = 0;
  private kind: CoreKind = "idle";
  private tone: ActivityTone = "idle";

  constructor() {
    const orbit = (n: number, cls: string) => h("span", { class: `core-orbit ${cls}` }, ...Array.from({ length: n }, () => h("i")));
    this.el = h(
      "div",
      { id: "core", "data-kind": "idle", "data-tone": "idle", "aria-hidden": "true" },
      h("i", { class: "core-halo" }),
      h("i", { class: "core-sweep" }),
      h("i", { class: "core-ring r1" }),
      h("i", { class: "core-ring r2" }),
      orbit(3, "o1"),
      orbit(2, "o2"),
      h("i", { class: "core-burst" }),
    );
  }

  /** Called every frame the island draws: follows Mochi. Cheap — one transform. */
  place(cx: number, cy: number, diameter: number, visible: boolean, parallaxX = 0, parallaxY = 0) {
    this.el.classList.toggle("on", visible);
    if (!visible) return;
    // Big enough to frame Mochi, small enough to stay inside its card.
    const d = Math.round(diameter * 1.74);
    if (d !== this.size) {
      this.size = d;
      this.el.style.width = `${d}px`;
      this.el.style.height = `${d}px`;
    }
    const x = cx - d / 2 + parallaxX * 3;
    const y = cy - d / 2 + parallaxY * 2;
    this.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }

  /** The phase changed: retarget the CSS. One-shot effects replay on arrival. */
  setPhase(kind: CoreKind, tone: ActivityTone, color: string) {
    this.el.style.setProperty("--accent", color);
    if (kind === this.kind && tone === this.tone) return;
    const arrived = tone !== this.tone;
    this.kind = kind;
    this.tone = tone;
    this.el.dataset.kind = kind;
    this.el.dataset.tone = tone;
    if (arrived && (tone === "success" || tone === "error" || tone === "alert")) {
      const burst = this.el.querySelector(".core-burst") as HTMLElement;
      burst.classList.remove("go");
      void burst.offsetWidth;
      burst.classList.add("go");
    }
  }
}
