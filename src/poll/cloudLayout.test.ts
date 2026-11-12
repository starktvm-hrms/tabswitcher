import { describe, expect, it } from 'vitest';
import { colorIndex, fontSize, layoutCloud, type Placed } from './cloudLayout';

// Monospace-ish fake: each character is 0.6em wide.
const measure = (text: string, size: number) => text.length * size * 0.6;

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `w${i}`, text: `word${i}`, count: Math.max(1, n - i) }));

const overlap = (a: Placed, b: Placed) => Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;

describe('layoutCloud', () => {
  it('places every word inside the box with no overlaps', () => {
    const W = 1200, H = 600;
    const placed = layoutCloud(words(40), { width: W, height: H, measure });
    expect(placed).toHaveLength(40);
    for (const p of placed) {
      expect(p.x - p.w / 2).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w / 2).toBeLessThanOrEqual(W);
      expect(p.y - p.h / 2).toBeGreaterThanOrEqual(0);
      expect(p.y + p.h / 2).toBeLessThanOrEqual(H);
    }
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i], placed[j])).toBe(false);
  });

  it('puts the most common word in the middle and biggest', () => {
    const placed = layoutCloud(words(10), { width: 800, height: 400, measure });
    expect(placed[0].key).toBe('w0');
    expect(Math.abs(placed[0].x - 400)).toBeLessThan(5);
    expect(Math.abs(placed[0].y - 200)).toBeLessThan(5);
    expect(Math.max(...placed.map((p) => p.size))).toBe(placed[0].size);
  });

  it('shrinks text to fit many words into a small box', () => {
    const placed = layoutCloud(words(60), { width: 420, height: 260, measure });
    expect(placed.length).toBeGreaterThan(40);
  });

  it('handles empty input, tiny boxes and over-long words', () => {
    expect(layoutCloud([], { width: 800, height: 400, measure })).toEqual([]);
    expect(layoutCloud(words(3), { width: 20, height: 20, measure })).toEqual([]);
    const long = layoutCloud([{ key: 'l', text: 'x'.repeat(40), count: 1 }], { width: 300, height: 200, measure });
    expect(long).toHaveLength(1);
    expect(long[0].w).toBeLessThanOrEqual(300);
  });
});

describe('helpers', () => {
  it('scales font size by square root between min and max', () => {
    expect(fontSize(1, 1, 9, 10, 100)).toBe(10);
    expect(fontSize(9, 1, 9, 10, 100)).toBe(100);
    expect(fontSize(3, 1, 9, 10, 100)).toBeCloseTo(10 + 90 * Math.sqrt(0.25));
  });
  it('gives each word a stable colour', () => {
    expect(colorIndex('teamwork', 8)).toBe(colorIndex('teamwork', 8));
    expect(colorIndex('teamwork', 8)).toBeGreaterThanOrEqual(0);
    expect(colorIndex('teamwork', 8)).toBeLessThan(8);
  });
});
