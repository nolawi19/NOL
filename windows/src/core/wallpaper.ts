// "Match my wallpaper": reads the desktop wallpaper (on a click), finds its
// darkness and its strongest colour, and picks the palette and accent that
// sit closest. The image never leaves this computer.

import { Bridge } from "./bridge";
import { THEMES } from "../design/themes.generated";
import type { StyleSpec } from "./styles";

type RGB = [number, number, number];

const hex = (h: string): RGB => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
const dist = (a: RGB, b: RGB) => Math.sqrt(2 * (a[0] - b[0]) ** 2 + 4 * (a[1] - b[1]) ** 2 + 3 * (a[2] - b[2]) ** 2);

/** Average colour and the most saturated well-represented colour of an image. */
export async function sampleImage(bytes: ArrayBuffer): Promise<{ average: RGB; vivid: RGB }> {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = document.createElement("canvas");
  c.width = 48;
  c.height = 27;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const avg = [0, 0, 0];
  // Hue buckets weighted by saturation: the colour the eye notices.
  const buckets = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    avg[0] += r; avg[1] += g; avg[2] += b;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat < 0.25 || max < 40) continue;
    let hue = 0;
    if (max === r) hue = ((g - b) / (max - min)) % 6;
    else if (max === g) hue = (b - r) / (max - min) + 2;
    else hue = (r - g) / (max - min) + 4;
    const k = Math.floor((((hue * 60) + 360) % 360) / 30);
    const w = sat * (max / 255);
    buckets[k].w += w; buckets[k].r += r * w; buckets[k].g += g * w; buckets[k].b += b * w;
  }
  const average: RGB = [avg[0] / n, avg[1] / n, avg[2] / n];
  const best = buckets.sort((a, b) => b.w - a.w)[0];
  const vivid: RGB = best.w > 0 ? [best.r / best.w, best.g / best.w, best.b / best.w] : average;
  return { average, vivid };
}

export function nearestStyle(average: RGB, vivid: RGB): StyleSpec {
  let best = { score: Infinity, theme: 0, accent: 5 };
  const darkened: RGB = [average[0] * 0.35, average[1] * 0.35, average[2] * 0.35];
  THEMES.forEach((t, i) => {
    const cols = Array.from({ length: 16 }, (_, k) => hex(t[3].slice(k * 6, k * 6 + 6)));
    let slot = 0;
    let slotD = Infinity;
    for (let k = 8; k < 16; k++) {
      const d = dist(cols[k], vivid);
      if (d < slotD) [slotD, slot] = [d, k - 8];
    }
    const score = slotD + 0.6 * dist(cols[0], darkened);
    if (score < best.score) best = { score, theme: i, accent: slot };
  });
  return { theme: best.theme, accent: best.accent, depth: 1, font: 0, pattern: 0, edge: 2, saturation: 1, contrast: 1 };
}

export async function styleFromWallpaper(): Promise<StyleSpec> {
  const bytes = await Bridge.wallpaperImage();
  const { average, vivid } = await sampleImage(bytes);
  return nearestStyle(average, vivid);
}
