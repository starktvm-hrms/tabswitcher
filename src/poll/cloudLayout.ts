/**
 * Word-cloud layout: places words on an Archimedean spiral from the centre, biggest
 * first, without overlaps. Pure — text measurement is injected — so it's unit tested.
 */

export type LayoutInput = { key: string; text: string; count: number };
export type Placed = LayoutInput & { x: number; y: number; w: number; h: number; size: number; color: number };

export type LayoutOptions = {
  width: number;
  height: number;
  /** Width in px of `text` at `size` px font. */
  measure: (text: string, size: number) => number;
  minSize?: number;
  maxSize?: number;
  maxWords?: number;
  /** Gap around each word, as a fraction of its font size. */
  padding?: number;
  colors?: number;
};

/** Font size for a count: square-root scale between min and max (areas grow ~linearly). */
export function fontSize(count: number, lo: number, hi: number, minSize: number, maxSize: number): number {
  if (hi <= lo) return lo <= 1 ? (minSize + maxSize) / 2.4 : maxSize * 0.8;
  return minSize + (maxSize - minSize) * Math.sqrt((count - lo) / (hi - lo));
}

/** Stable colour index per word, so a word keeps its colour as the cloud changes. */
export function colorIndex(key: string, colors: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return Math.abs(h) % colors;
}

/** The word's own colour unless one of the last few (bigger) words already has it. */
function pickColor(key: string, placed: Placed[], colors: number): number {
  const recent = new Set(placed.slice(-(colors - 1)).map((p) => p.color));
  let c = colorIndex(key, colors);
  for (let i = 0; i < colors && recent.has(c); i++) c = (c + 1) % colors;
  return c;
}

const overlaps = (a: Placed, b: Placed, pad: number) => {
  const g = Math.max(1.5, Math.min(a.size, b.size) * pad);
  return Math.abs(a.x - b.x) * 2 < a.w + b.w + g * 2 && Math.abs(a.y - b.y) * 2 < a.h + b.h + g;
};

export function layoutCloud(words: LayoutInput[], opts: LayoutOptions): Placed[] {
  const { width, height, measure, maxWords = 80, padding = 0.12, colors = 8 } = opts;
  if (width < 40 || height < 40 || words.length === 0) return [];
  const list = words.slice(0, maxWords);
  const counts = list.map((w) => w.count);
  const lo = Math.min(...counts), hi = Math.max(...counts);
  const baseMax = opts.maxSize ?? Math.min(height / 3, width / 5.5, 170);
  const baseMin = opts.minSize ?? Math.max(11, baseMax / 5.5);
  const ratio = width / height;

  // Shrink everything until every word fits; keep the attempt that fit the most.
  let best: Placed[] = [];
  for (let scale = 1; scale > 0.3; scale *= 0.88) {
    const placed: Placed[] = [];
    let dropped = 0;
    for (const word of list) {
      const size = Math.max(10, fontSize(word.count, lo, hi, baseMin, baseMax) * scale);
      const w = measure(word.text, size) + 2;
      const h = size * 1.08;
      if (w > width - 8) { dropped++; continue; }
      const item: Placed = { ...word, size, w, h, x: width / 2, y: height / 2, color: pickColor(word.key, placed, colors) };
      let ok = false;
      let lastHit = -1; // the word that blocked the previous spot usually blocks the next one too
      for (let t = 0; t < 2000; t += 0.1) {
        const r = 2.4 * t;
        item.x = width / 2 + r * Math.cos(t) * Math.max(1, ratio * 0.9);
        item.y = height / 2 + r * Math.sin(t);
        if (item.x - w / 2 < 2 || item.x + w / 2 > width - 2 || item.y - h / 2 < 2 || item.y + h / 2 > height - 2) {
          if (r > Math.max(width, height)) break;
          continue;
        }
        if (lastHit >= 0 && overlaps(placed[lastHit], item, padding)) continue;
        lastHit = placed.findIndex((p) => overlaps(p, item, padding));
        if (lastHit < 0) { ok = true; break; }
      }
      if (ok) placed.push(item); else dropped++;
    }
    if (placed.length > best.length) best = placed;
    if (dropped === 0) return placed;
  }
  return best;
}
