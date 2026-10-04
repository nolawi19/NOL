// Styles: 253 researched palettes, combined with seven visual axes, give
// 2,950,992 distinct looks. One million of them are numbered #000000–#999999
// so they can be browsed, shared and picked at random; any combination can
// also be built by hand.
//
// Every axis changes something real and visible:
//   theme       surfaces, text and the status colours (base16 palette)
//   accent      selection, focus, highlights and the accent edge
//   depth       the island body: true black, a deep tint, or the palette's own
//   font        sans, mono or serif — fonts already on the system, nothing downloaded
//   pattern     a static texture inside the island (no animation, no cost)
//   edge        the island's outline: none, hairline, or accent light
//   saturation  muted, as designed, or vivid
//   contrast    soft, normal or high text contrast
//
// Status colours are adjusted until they read on the cards (≥ 3:1), so no
// combination makes "Permission needed" or an error unreadable. With no style
// chosen nothing here touches the page: Coucou keeps its own look.

import { THEMES } from "../design/themes.generated";

export interface StyleSpec {
  theme: number;
  accent: number;
  depth: number;
  font: number;
  pattern: number;
  edge: number;
  saturation: number;
  contrast: number;
}

type AxisId = keyof StyleSpec;

export const AXES: { id: AxisId; title: string; options: string[] }[] = [
  { id: "theme", title: "Palette", options: THEMES.map((t) => t[1]) },
  { id: "accent", title: "Accent", options: ["Red", "Orange", "Yellow", "Green", "Cyan", "Blue", "Purple", "Brown"] },
  { id: "depth", title: "Island body", options: ["True black", "Deep tint", "Palette background"] },
  { id: "font", title: "Font", options: ["Sans", "Mono", "Serif"] },
  { id: "pattern", title: "Texture", options: ["None", "Scan lines", "Grid", "Dots", "Diagonal", "Mesh"] },
  { id: "edge", title: "Outline", options: ["None", "Hairline", "Accent light"] },
  { id: "saturation", title: "Colour", options: ["Muted", "As designed", "Vivid"] },
  { id: "contrast", title: "Text contrast", options: ["Soft", "Normal", "High"] },
];

/** Every combination of every axis. */
export const STYLE_SPACE = AXES.reduce((n, a) => n * a.options.length, 1);
/** The numbered catalogue: #000000 … #999999. */
export const STYLE_COUNT = 1_000_000;

// Catalogue number → combination: n·P + OFFSET mod STYLE_SPACE. P is a prime
// that doesn't divide the space, so the map is one-to-one and neighbouring
// numbers land on unrelated palettes.
const P = 999_983n;
const OFFSET = 7_919n;
const SPACE = BigInt(STYLE_SPACE);

function modInverse(a: bigint, m: bigint): bigint {
  let [r0, r1] = [a % m, m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return ((s0 % m) + m) % m;
}
const P_INV = modInverse(P, SPACE);

/** Position of a combination in the full space (mixed radix, theme first). */
export function specIndex(spec: StyleSpec): number {
  let idx = 0;
  for (const a of AXES) idx = idx * a.options.length + spec[a.id];
  return idx;
}

export function specFromIndex(index: number): StyleSpec {
  const spec = {} as StyleSpec;
  let rest = ((index % STYLE_SPACE) + STYLE_SPACE) % STYLE_SPACE;
  for (let i = AXES.length - 1; i >= 0; i--) {
    const n = AXES[i].options.length;
    spec[AXES[i].id] = rest % n;
    rest = Math.floor(rest / n);
  }
  return spec;
}

/** Style #n (0 ≤ n < 1,000,000). */
export function styleFromNumber(n: number): StyleSpec {
  const k = BigInt(Math.max(0, Math.min(STYLE_COUNT - 1, Math.floor(n))));
  return specFromIndex(Number((k * P + OFFSET) % SPACE));
}

/** The catalogue number of a combination, or null when it is outside the first million. */
export function numberOfStyle(spec: StyleSpec): number | null {
  const idx = BigInt(specIndex(spec));
  const n = (((idx - OFFSET) % SPACE + SPACE) % SPACE) * P_INV % SPACE;
  return n < BigInt(STYLE_COUNT) ? Number(n) : null;
}

export function formatStyleNumber(n: number): string {
  return `#${String(n).padStart(6, "0")}`;
}

export function randomStyleNumber(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % STYLE_COUNT;
}

export function validSpec(v: unknown): StyleSpec | null {
  if (typeof v !== "object" || v == null) return null;
  const o = v as Record<string, unknown>;
  const spec = {} as StyleSpec;
  for (const a of AXES) {
    const x = o[a.id];
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x >= a.options.length) return null;
    spec[a.id] = x;
  }
  return spec;
}

export function describeStyle(spec: StyleSpec): string {
  return AXES.map((a) => a.options[spec[a.id]]).join(" · ");
}

export function themeInfo(i: number) {
  const t = THEMES[i];
  // Authors often carry a link or an e-mail address in brackets: show the name.
  const author = t[2].replace(/\s*[(<][^)>]*[)>]/g, "").trim();
  return { slug: t[0], name: t[1], author, colors: paletteOf(i) };
}

export function paletteOf(i: number): string[] {
  const c = THEMES[i][3];
  return Array.from({ length: 16 }, (_, k) => `#${c.slice(k * 6, k * 6 + 6)}`);
}

export function searchThemes(q: string): number[] {
  const s = q.trim().toLowerCase();
  const all = THEMES.map((_, i) => i);
  if (!s) return all;
  return all.filter((i) => `${THEMES[i][1]} ${THEMES[i][2]} ${THEMES[i][0]}`.toLowerCase().includes(s));
}

// ── Colour maths ─────────────────────────────────────────────────────────────

type RGB = [number, number, number];

function hex(h: string): RGB {
  const v = h.replace("#", "");
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function toHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("")}`;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: RGB, b: RGB): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function saturate(c: RGB, k: number): RGB {
  const grey = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const ch = (x: number) => Math.max(0, Math.min(255, grey + (x - grey) * k));
  return [ch(c[0]), ch(c[1]), ch(c[2])];
}

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

/** Moves a colour away from `bg` (lighter on dark, darker on light) until it reaches `min` contrast. */
function readable(c: RGB, bg: RGB, min: number): RGB {
  const toward = luminance(bg) < 0.18 ? WHITE : BLACK;
  let out = c;
  for (let i = 0; i < 24 && contrast(out, bg) < min; i++) out = mix(out, toward, 0.12);
  return out;
}

/** Keeps a surface dark enough for the island (some palettes have bright base01/02). */
function darkSurface(c: RGB, max = 0.06): RGB {
  let out = c;
  for (let i = 0; i < 20 && luminance(out) > max; i++) out = mix(out, BLACK, 0.15);
  return out;
}

const rgba = (c: RGB, a: number) => `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${a})`;

const FONTS = [
  null,
  { font: '"Cascadia Code", "JetBrains Mono", "Fira Code", "DejaVu Sans Mono", ui-monospace, monospace', display: null },
  { font: 'Georgia, Cambria, "Times New Roman", "DejaVu Serif", "Liberation Serif", serif', display: null },
] as const;

/** CSS custom properties for a style. */
export function styleVars(spec: StyleSpec): Record<string, string> {
  const pal = paletteOf(spec.theme).map(hex);
  const sat = [0.62, 1, 1.3][spec.saturation];
  const tone = (c: RGB) => saturate(c, sat);

  const base00 = darkSurface(pal[0], 0.05);
  const base01 = darkSurface(pal[1], 0.07);
  const base02 = darkSurface(pal[2], 0.1);
  const body = spec.depth === 0 ? BLACK : spec.depth === 1 ? mix(base00, BLACK, 0.55) : base00;
  const card = mix(body, base01, 0.7);

  // Text: the lightest of base05/06/07 drives the top of the ink scale.
  const light = [pal[5], pal[6], pal[7]].sort((a, b) => luminance(b) - luminance(a))[0];
  const ink1 = spec.contrast === 0 ? pal[5] : spec.contrast === 1 ? mix(light, WHITE, 0.15) : mix(light, WHITE, 0.55);
  const ink = [
    readable(ink1, card, 7),
    readable(pal[5], card, 5.5),
    readable(pal[4], card, 3.6),
    readable(mix(pal[3], pal[4], 0.5), card, 2.4),
    readable(pal[3], card, 1.6),
  ];

  const status = (c: RGB) => readable(tone(c), card, 3.15);
  const accent = status(pal[8 + spec.accent]);
  const vars: Record<string, string> = {
    "--bg-0": toHex(body),
    "--bg-1": toHex(mix(body, base00, 0.5)),
    "--bg-2": toHex(mix(body, base01, 0.35)),
    "--bg-3": toHex(card),
    "--bg-4": toHex(mix(base01, base02, 0.5)),
    "--ink-1": toHex(ink[0]),
    "--ink-2": toHex(ink[1]),
    "--ink-3": toHex(ink[2]),
    "--ink-4": toHex(ink[3]),
    "--ink-5": toHex(ink[4]),
    "--ink-inverse": toHex(body),
    "--glass-1": rgba(ink[0], 0.03),
    "--glass-2": rgba(ink[0], 0.055),
    "--glass-3": rgba(ink[0], 0.085),
    "--glass-4": rgba(ink[0], 0.13),
    "--glass-5": rgba(ink[0], 0.19),
    "--line-1": rgba(ink[0], 0.05),
    "--line-2": rgba(ink[0], 0.085),
    "--line-3": rgba(ink[0], 0.13),
    "--line-4": rgba(ink[0], 0.24),
    "--c-error": toHex(status(pal[8])),
    "--c-rate": toHex(status(pal[9])),
    "--c-approval": toHex(status(pal[10])),
    "--c-success": toHex(status(pal[11])),
    "--c-success-strong": toHex(status(pal[11])),
    "--c-question": toHex(status(pal[12])),
    "--c-work": toHex(status(pal[13])),
    "--c-think": toHex(status(pal[14])),
    "--c-search": toHex(status(mix(pal[13], pal[14], 0.5))),
    "--c-pink": toHex(status(pal[15])),
    "--c-idle": toHex(ink[2]),
    "--c-error-text": toHex(readable(tone(pal[8]), card, 4.5)),
    "--c-success-text": toHex(readable(tone(pal[11]), card, 4.5)),
    "--c-warn-text": toHex(readable(tone(pal[10]), card, 4.5)),
    "--c-info-text": toHex(readable(tone(pal[13]), card, 4.5)),
    "--accent-ui": toHex(accent),
  };
  const f = FONTS[spec.font];
  if (f) {
    vars["--font"] = f.font;
    vars["--font-display"] = f.font;
  }
  return vars;
}

const PATTERNS = ["none", "scanlines", "grid", "dots", "diagonal", "mesh"] as const;
const EDGES = ["none", "hairline", "accent"] as const;
let applied: string[] = [];

/**
 * Puts a style on a document, or takes it off (null) so Coucou's own look
 * comes back exactly. Variables and two data attributes only.
 */
export function applyStyle(spec: StyleSpec | null, doc: Document = document) {
  const root = doc.documentElement;
  for (const k of applied) root.style.removeProperty(k);
  applied = [];
  if (!spec) {
    delete root.dataset.pattern;
    delete root.dataset.edge;
    delete root.dataset.styled;
    return;
  }
  const vars = styleVars(spec);
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
    applied.push(k);
  }
  root.dataset.styled = "";
  root.dataset.pattern = PATTERNS[spec.pattern];
  root.dataset.edge = EDGES[spec.edge];
}
