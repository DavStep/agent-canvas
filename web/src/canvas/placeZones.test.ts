import { describe, expect, it } from 'vitest';
import type { ZoneLayout } from '../../../shared/types.ts';
import { fitTransform } from './usePanZoom.ts';
import { placeZones, rowWidthFor } from './placeZones.ts';

const zone = (id: string, x: number | null = null, y: number | null = null): ZoneLayout =>
  ({ id, name: id, kind: 'folder', folder: id, x, y, hueIndex: 0 });

interface Rect { x: number; y: number; w: number; h: number }
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('placeZones', () => {
  it('places twelve zones of mixed size without overlap, in rows at most 1400 px wide', () => {
    const zones = Array.from({ length: 12 }, (_, i) => zone(`z${i}`));
    const sizes = new Map(zones.map((z, i) => [z.id, { w: 264 + (i % 4) * 244, h: 120 + ((i * 7) % 5) * 90 }]));
    const placed = placeZones(zones, sizes);
    expect(placed.size).toBe(12);
    const rects = zones.map((z) => ({ ...placed.get(z.id)!, ...sizes.get(z.id)! }));
    for (const r of rects) expect(r.x + r.w).toBeLessThanOrEqual(1400);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        // Grow one rect by the 32 px gap: they must still not touch.
        expect(overlaps({ x: a.x - 32, y: a.y - 32, w: a.w + 64, h: a.h + 64 }, b)).toBe(false);
      }
    }
  });

  it('leaves placed zones alone and never overlaps them', () => {
    const zones = [zone('a', 0, 0), zone('b'), zone('c', 900, 300), zone('d')];
    const sizes = new Map([
      ['a', { w: 752, h: 340 }], ['b', { w: 508, h: 330 }], ['c', { w: 264, h: 140 }], ['d', { w: 1600, h: 200 }],
    ]);
    const placed = placeZones(zones, sizes);
    expect([...placed.keys()].sort()).toEqual(['b', 'd']);
    const all = zones.map((z) => ({ ...(placed.get(z.id) ?? { x: z.x!, y: z.y! }), ...sizes.get(z.id)! }));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i]!, all[j]!)).toBe(false);
    }
  });

  it('skips unplaced zones that have not been measured yet', () => {
    const placed = placeZones([zone('a'), zone('b')], new Map([['a', { w: 100, h: 100 }]]));
    expect([...placed.keys()]).toEqual(['a']);
    expect(placed.get('a')).toEqual({ x: 0, y: 0 });
  });
});

describe('placeZones, forty sessions in one zone among twelve', () => {
  it('places a zone of forty cards and eleven others without overlap', () => {
    const zones = Array.from({ length: 12 }, (_, i) => zone(`z${i}`));
    // Forty cards: five 232 px columns of eight cards (1240 x ~1200), the rest one to four cards.
    const sizes = new Map(zones.map((z, i) => [z.id, i === 0 ? { w: 1240, h: 1196 } : { w: 264 + (i % 3) * 244, h: 138 + (i % 4) * 94 }]));
    const placed = placeZones(zones, sizes);
    const rects = zones.map((z) => ({ ...placed.get(z.id)!, ...sizes.get(z.id)! }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
    }
  });
});

describe('rowWidthFor', () => {
  // The twelve zones of the large demo as the browser measured them.
  const measured: [number, number][] = [
    [752, 516], [752, 395], [752, 326], [508, 310], [508, 311], [508, 232],
    [508, 232], [508, 216], [508, 139], [508, 301], [264, 138], [264, 216],
  ];
  const zones = measured.map((_, i) => zone(`z${i}`));
  const sizes = new Map(zones.map((z, i) => [z.id, { w: measured[i]![0], h: measured[i]![1] }]));

  it('packs twelve zones to the shape of the canvas, so Fit shows them all without dropping below 30%', () => {
    // The workspace of a 1280 x 800 window with no panel.
    const viewport = { width: 1262, height: 676 };
    const placed = placeZones(zones, sizes, rowWidthFor(zones, sizes, viewport.width / viewport.height));
    const rects = zones.map((z) => ({ ...placed.get(z.id)!, width: sizes.get(z.id)!.w, height: sizes.get(z.id)!.h }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!; const b = rects[j]!;
        expect(overlaps({ x: a.x, y: a.y, w: a.width, h: a.height }, { x: b.x, y: b.y, w: b.width, h: b.height })).toBe(false);
      }
    }
    // Unclamped: the fit's own zoom is above the 0.3 floor, so the 48 px margin holds.
    const t = fitTransform(rects, viewport)!;
    const bottom = Math.max(...rects.map((r) => r.y + r.height)) * t.k + t.y;
    const right = Math.max(...rects.map((r) => r.x + r.width)) * t.k + t.x;
    expect(t.k).toBeGreaterThan(0.3);
    expect(bottom).toBeLessThanOrEqual(viewport.height - 48 + 1e-9);
    expect(right).toBeLessThanOrEqual(viewport.width - 48 + 1e-9);
  });

  it('never goes below the 1400 px rows or the widest zone', () => {
    expect(rowWidthFor([zone('a')], new Map([['a', { w: 300, h: 200 }]]), 2)).toBe(1400);
    expect(rowWidthFor([zone('a')], new Map([['a', { w: 1800, h: 200 }]]), 0.5)).toBe(1800);
    expect(rowWidthFor([zone('a', 0, 0)], new Map([['a', { w: 9000, h: 9000 }]]), 2)).toBe(1400);
  });
});
