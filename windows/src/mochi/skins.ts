// Mochi's outfits: small SVGs in a 100 × 100 box centred on Mochi (its body
// spans roughly x 0–100, y 20–80). Drawn over the canvas, never into it, so
// the engine and every animation stay exactly as they are.

import type { Skin } from "../core/prefs";

const svg = (body: string) =>
  `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

export const SKIN_SVG: Record<Skin, string> = {
  none: "",
  cap: svg(
    `<path d="M22 22 Q50 -2 78 22 L78 26 L22 26 Z" fill="#3B82F6"/><path d="M70 24 Q92 24 98 30 L72 30 Z" fill="#1D4ED8"/><circle cx="50" cy="8" r="3" fill="#1D4ED8"/>`,
  ),
  glasses: svg(
    `<g fill="none" stroke="#111" stroke-width="4"><circle cx="34" cy="48" r="11"/><circle cx="66" cy="48" r="11"/><path d="M45 47 Q50 43 55 47"/></g><g fill="rgba(147,197,253,0.25)"><circle cx="34" cy="48" r="9"/><circle cx="66" cy="48" r="9"/></g>`,
  ),
  crown: svg(
    `<path d="M26 26 L30 6 L41 18 L50 2 L59 18 L70 6 L74 26 Z" fill="#F5A524" stroke="#B45309" stroke-width="2" stroke-linejoin="round"/><circle cx="50" cy="16" r="3" fill="#F472B6"/><circle cx="36" cy="20" r="2.2" fill="#22D3EE"/><circle cx="64" cy="20" r="2.2" fill="#22D3EE"/>`,
  ),
  headphones: svg(
    `<path d="M14 50 Q14 10 50 10 Q86 10 86 50" fill="none" stroke="#1F2937" stroke-width="6" stroke-linecap="round"/><rect x="4" y="40" width="16" height="24" rx="6" fill="#EF4444"/><rect x="80" y="40" width="16" height="24" rx="6" fill="#EF4444"/>`,
  ),
  party: svg(
    `<path d="M38 24 L50 -6 L62 24 Z" fill="#A78BFA"/><path d="M41 17 L59 17 M44 9 L56 9" stroke="#FDE68A" stroke-width="3"/><circle cx="50" cy="-6" r="4" fill="#F472B6"/>`,
  ),
  santa: svg(
    `<path d="M24 24 Q34 0 62 4 Q80 8 88 20 L76 20 Q70 12 62 12 Q48 12 44 24 Z" fill="#DC2626"/><rect x="22" y="20" width="58" height="8" rx="4" fill="#F9FAFB"/><circle cx="88" cy="22" r="5" fill="#F9FAFB"/>`,
  ),
  bow: svg(
    `<path d="M50 20 L30 8 Q24 20 30 32 Z M50 20 L70 8 Q76 20 70 32 Z" fill="#F472B6"/><circle cx="50" cy="20" r="5" fill="#DB2777"/>`,
  ),
  flower: svg(
    `<g transform="translate(76 22)"><circle r="5" cy="-7" fill="#FDE68A"/><circle r="5" cx="7" fill="#FDE68A"/><circle r="5" cy="7" fill="#FDE68A"/><circle r="5" cx="-7" fill="#FDE68A"/><circle r="4" fill="#F59E0B"/></g>`,
  ),
};
