// Island UI primitives built on the design tokens. Views compose these instead
// of styling elements one by one, so every button, chip and card in the island
// moves and lights up the same way.

import { h, svg } from "./dom";
import { washRGBA, type Wash } from "../core/layout";

export type ButtonKind = "primary" | "secondary" | "ghost" | "allow" | "danger";

export interface ButtonOptions {
  icon?: string;
  /** Icon drawn as a filled path instead of a line. */
  iconFilled?: boolean;
  title?: string;
  /** Stretches to fill a row (used by split action rows). */
  grow?: boolean;
}

/** Pill button with the press-scale, hover-lift and focus ring of the design system. */
export function button(
  label: string,
  kind: ButtonKind,
  onClick: () => void,
  opts: ButtonOptions = {},
): HTMLButtonElement {
  const el = h("button", {
    class: `btn btn-${kind}${opts.grow ? " grow" : ""}`,
    type: "button",
    title: opts.title,
  }) as HTMLButtonElement;
  if (opts.icon) el.append(icon(opts.icon, 12, opts.iconFilled ? 0 : 2.1));
  el.append(h("span", { class: "btn-label", text: label }));
  el.addEventListener("click", (e) => {
    if (el.disabled) return;
    ripple(el, e as MouseEvent);
    onClick();
  });
  return el;
}

/** Small round icon-only button (header, card corners). */
export function iconButton(path: string, title: string, onClick: () => void, size = 13, stroke = 2): HTMLButtonElement {
  const el = h("button", { class: "icon-btn", type: "button", title, "aria-label": title }) as HTMLButtonElement;
  el.append(icon(path, size, stroke));
  el.addEventListener("click", () => onClick());
  return el;
}

/** Line icon (stroke > 0) or filled glyph (stroke 0). */
export function icon(path: string, size = 12, stroke = 2): SVGSVGElement {
  const el = svg(path, size, stroke > 0 ? { stroke } : {});
  el.classList.add("ico");
  return el;
}

/** Swaps the path of an icon in place — no new node, so CSS animations keep running. */
export function setIcon(el: SVGSVGElement, path: string) {
  const p = el.querySelector("path");
  if (p && p.getAttribute("d") !== path) p.setAttribute("d", path);
}

/** The press flash: a radial light that blooms from the click point. */
function ripple(el: HTMLElement, e: MouseEvent) {
  const rect = el.getBoundingClientRect();
  const dot = h("i", { class: "ripple" });
  const size = Math.max(rect.width, rect.height) * 2;
  dot.style.width = dot.style.height = `${size}px`;
  dot.style.left = `${(e.clientX || rect.left + rect.width / 2) - rect.left - size / 2}px`;
  dot.style.top = `${(e.clientY || rect.top + rect.height / 2) - rect.top - size / 2}px`;
  el.append(dot);
  dot.addEventListener("animationend", () => dot.remove(), { once: true });
  window.setTimeout(() => dot.remove(), 700);
}

/** Card shell with an optional coloured wash rising from the bottom edge. */
export function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card fx-glass wash" : "card fx-glass" }, ...children);
  if (wash) {
    el.style.setProperty("--wash", washRGBA(wash));
    el.dataset.wash = wash;
  }
  return el;
}

/** Gives each child an index so CSS can stagger their entrance. */
export function stagger(el: HTMLElement, start = 0): HTMLElement {
  Array.from(el.children).forEach((c, i) => (c as HTMLElement).style.setProperty("--i", String(start + i)));
  return el;
}

/** Status chip: tinted dot + label, e.g. "● Connected". */
export function statusChip(color: string, label: string, pulse = false): HTMLElement {
  return h(
    "span",
    { class: pulse ? "chip-status pulse" : "chip-status", style: `--chip:${color}` },
    h("i"),
    h("span", { text: label }),
  );
}

/**
 * Text that never just snaps: the old line slides up and dissolves while the
 * new one rises into place. Used wherever a status changes under the user's eye.
 */
export class TextSwap {
  readonly el: HTMLElement;
  private current: HTMLElement | null = null;
  private text: string | null = null;

  constructor(cls = "") {
    this.el = h("span", { class: `swap ${cls}`.trim() });
  }

  set(text: string, instant = false) {
    if (text === this.text) return;
    this.text = text;
    const next = h("span", { class: "swap-line", text });
    const prev = this.current;
    this.current = next;
    if (prev) {
      if (instant) prev.remove();
      else {
        prev.classList.add("leave");
        const drop = () => prev.remove();
        prev.addEventListener("animationend", drop, { once: true });
        window.setTimeout(drop, 450);
      }
    }
    if (!instant && prev) next.classList.add("enter");
    this.el.append(next);
  }

  get value(): string | null {
    return this.text;
  }
}

/**
 * Hex colour → the alpha-suffixed variants the components use for tints, so
 * per-pill colours ride on CSS custom properties instead of inline hover code.
 */
export function tintVars(hex: string): string {
  const c = hex.length === 7 ? hex : "#9AA3B2";
  return `--tint:${c};--tint-08:${c}14;--tint-14:${c}24;--tint-18:${c}2e;--tint-35:${c}59;--tint-55:${c}8c;--tint-text:${lighten(c, 0.3)}`;
}

export function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** "1:42" — remaining time on a countdown. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
