import { describe, expect, it } from 'vitest';
import type { Layout } from '../../../shared/types.ts';
import { readingOrder, tidyMoves, tidyOps, undoOps } from './tidyZones.ts';

const box = (id: string, x: number, y: number, w = 300, h = 200) => ({ id, x, y, w, h });
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const layoutWith = (zones: { id: string; x: number | null; y: number | null }[]): Layout => ({
  version: 1, assignments: {},
  zones: zones.map((z) => ({ ...z, name: z.id, kind: 'custom', folder: null, hueIndex: 0 })),
});

describe('readingOrder', () => {
  it('reads rows top to bottom and left to right, with tops that differ a little in one row', () => {
    const order = readingOrder([box('c', 0, 400), box('b', 700, 40), box('a', 100, 0), box('d', 500, 380)]);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('tidyMoves', () => {
  it('packs scattered and overlapping zones from the origin without overlap, in reading order', () => {
    const boxes = [box('a', 900, 50), box('b', 5000, 3000, 500, 400), box('c', 950, 120), box('d', -800, 2000, 264, 96)];
    const moves = tidyMoves(boxes, new Map(), 16 / 9);
    expect(moves).toHaveLength(4);
    const to = new Map(moves.map((m) => [m.id, m.to]));
    expect(to.get('a')).toEqual({ x: 0, y: 0 });
    const rects = boxes.map((b) => ({ ...b, ...to.get(b.id)! }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
    }
    // a, then c (same row, further right), then d, then b.
    expect(to.get('c')!.x).toBeGreaterThan(0);
  });

  it('remembers saved positions to go back to, or the drawn one when none was saved', () => {
    const moves = tidyMoves([box('a', 400, 400), box('b', 900, 900)], new Map([['a', { x: 400, y: 300 }], ['b', null]]), 16 / 9);
    expect(moves.find((m) => m.id === 'a')!.from).toEqual({ x: 400, y: 300 });
    expect(moves.find((m) => m.id === 'b')!.from).toEqual({ x: 900, y: 900 });
  });

  it('leaves out zones already in place, so a tidy canvas has nothing to move', () => {
    const first = tidyMoves([box('a', 50, 50), box('b', 600, 50)], new Map(), 16 / 9);
    const tidied = first.map((m) => box(m.id, m.to.x, m.to.y));
    const saved = new Map(first.map((m) => [m.id, m.to]));
    expect(tidyMoves(tidied, saved, 16 / 9)).toEqual([]);
  });
});

describe('undoOps', () => {
  it('puts tidied zones back, but keeps a zone the owner moved since', () => {
    const moves = [
      { id: 'a', from: { x: 400, y: 300 }, to: { x: 0, y: 0 } },
      { id: 'b', from: { x: 900, y: 900 }, to: { x: 332, y: 0 } },
      { id: 'gone', from: { x: 1, y: 1 }, to: { x: 2, y: 2 } },
    ];
    expect(tidyOps(moves.slice(0, 1))).toEqual([{ type: 'moveZone', id: 'a', x: 0, y: 0 }]);
    const layout = layoutWith([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1200, y: 40 }]);
    expect(undoOps(moves, layout)).toEqual([{ type: 'moveZone', id: 'a', x: 400, y: 300 }]);
  });
});
