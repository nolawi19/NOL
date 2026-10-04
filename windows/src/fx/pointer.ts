// Pointer-driven effects: spotlight, magnetic pull and tilt. One delegated
// listener per window, coalesced to one write per animation frame, and only
// while the pointer is over an element that opted in (.fx-spotlight,
// .fx-magnetic, .fx-tilt). Idle pointer → no work at all.

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");

interface Pending {
  x: number;
  y: number;
  target: Element | null;
}

let pending: Pending | null = null;
let frame: number | null = null;
let lit: HTMLElement | null = null;
let pulled: HTMLElement | null = null;
let tilted: HTMLElement | null = null;

function apply() {
  frame = null;
  const p = pending;
  pending = null;
  if (!p) return;

  const spot = p.target?.closest<HTMLElement>(".fx-spotlight") ?? null;
  if (spot !== lit) {
    lit?.classList.remove("lit");
    lit = spot;
    lit?.classList.add("lit");
  }
  if (spot) {
    const r = spot.getBoundingClientRect();
    spot.style.setProperty("--mx", `${(p.x - r.left).toFixed(1)}px`);
    spot.style.setProperty("--my", `${(p.y - r.top).toFixed(1)}px`);
  }

  if (REDUCED.matches) return;

  const mag = p.target?.closest<HTMLElement>(".fx-magnetic") ?? null;
  if (mag !== pulled) release(pulled);
  pulled = mag;
  if (mag && !(mag as HTMLButtonElement).disabled) {
    const r = mag.getBoundingClientRect();
    const strength = Number(mag.dataset.pull ?? 0.22);
    const max = 5;
    const dx = Math.max(-max, Math.min(max, (p.x - (r.left + r.width / 2)) * strength));
    const dy = Math.max(-max, Math.min(max, (p.y - (r.top + r.height / 2)) * strength));
    mag.classList.add("pulling");
    mag.style.setProperty("--mg-x", `${dx.toFixed(2)}px`);
    mag.style.setProperty("--mg-y", `${dy.toFixed(2)}px`);
  }

  const tilt = p.target?.closest<HTMLElement>(".fx-tilt") ?? null;
  if (tilt !== tilted) resetTilt(tilted);
  tilted = tilt;
  if (tilt) {
    const r = tilt.getBoundingClientRect();
    const max = Number(tilt.dataset.tilt ?? 4);
    const nx = (p.x - r.left) / r.width - 0.5;
    const ny = (p.y - r.top) / r.height - 0.5;
    tilt.style.setProperty("--tilt-x", `${(-ny * max).toFixed(2)}deg`);
    tilt.style.setProperty("--tilt-y", `${(nx * max).toFixed(2)}deg`);
  }
}

function release(el: HTMLElement | null) {
  if (!el) return;
  el.classList.remove("pulling");
  el.style.setProperty("--mg-x", "0px");
  el.style.setProperty("--mg-y", "0px");
}

function resetTilt(el: HTMLElement | null) {
  el?.style.setProperty("--tilt-x", "0deg");
  el?.style.setProperty("--tilt-y", "0deg");
}

function schedule(x: number, y: number, target: Element | null) {
  pending = { x, y, target };
  if (frame == null) frame = requestAnimationFrame(apply);
}

let installed = false;

/** Call once per window. */
export function installPointerFx(root: Document = document) {
  if (installed) return;
  installed = true;
  root.addEventListener("pointermove", (e) => schedule(e.clientX, e.clientY, e.target as Element), { passive: true });
  root.addEventListener("pointerleave", () => schedule(-9999, -9999, null), { passive: true });
  root.documentElement.addEventListener("mouseleave", () => schedule(-9999, -9999, null), { passive: true });
}
