import { describe, expect, it } from 'vitest';
import { CARD_GAP, stackCards } from './stackCards.ts';
import { COLUMN_STEP, columnAt, flowCards, tileSpan, type FlowEntry } from './zoneFlow.ts';

const items = (heights: Record<string, number>) => Object.entries(heights).map(([id, cardH]) => ({ id, cardH }));

/** Where each card's top sits, as the flex columns draw it (entries one gap apart). */
function positions(columns: FlowEntry[][], heights: Record<string, number>) {
  const at: Record<string, { col: number; y: number }> = {};
  columns.forEach((column, col) => {
    let y = 0;
    for (const e of column) {
      if ('id' in e) { at[e.id] = { col, y }; y += heights[e.id]! + CARD_GAP; } else y += e.gap + CARD_GAP;
    }
  });
  return at;
}

/** Whether any card overlaps the tile's box (with the gap kept around it). */
function overlaps(columns: FlowEntry[][], heights: Record<string, number>, tile: { col: number; top: number; span: number }, height: number) {
  return Object.entries(positions(columns, heights)).some(([id, p]) =>
    p.col >= tile.col && p.col < tile.col + tile.span && p.y < tile.top + height + CARD_GAP && p.y + heights[id]! + CARD_GAP > tile.top);
}

describe('tileSpan and columnAt', () => {
  it('covers as many 232 px columns as the width needs, with a gap before the next', () => {
    expect(tileSpan(232)).toBe(1);
    expect(tileSpan(248)).toBe(2);
    expect(tileSpan(2 * COLUMN_STEP - CARD_GAP)).toBe(2);
    expect(tileSpan(2 * COLUMN_STEP - CARD_GAP + 1)).toBe(3);
    expect(tileSpan(1600)).toBe(7);
  });

  it('rounds to the nearest column, at most one past the cards', () => {
    expect(columnAt(-80, 4)).toBe(0);
    expect(columnAt(COLUMN_STEP * 0.6, 4)).toBe(1);
    expect(columnAt(COLUMN_STEP * 9, 4)).toBe(2);
    expect(columnAt(400, 0)).toBe(0);
  });
});

describe('flowCards', () => {
  const heights = { a: 120, b: 120, c: 120, d: 82, e: 82 };

  it('without a tile is stackCards', () => {
    expect(flowCards(items(heights), null)).toEqual({ columns: stackCards(items(heights)).map((c) => c.map((id) => ({ id }))), tile: null });
  });

  it('a tile in the first slot (the old place) puts the cards it covers below it', () => {
    const flow = flowCards(items(heights), { col: 0, top: 0, width: 380, height: 300 });
    expect(flow.tile).toEqual({ col: 0, top: 0, span: 2 });
    const at = positions(flow.columns, heights);
    // The third column is free beside it; the covered columns continue under it.
    expect(at.a).toEqual({ col: 2, y: 0 });
    expect(at.b).toEqual({ col: 2, y: 132 });
    expect(at.d).toEqual({ col: 0, y: 300 + CARD_GAP });
    expect(overlaps(flow.columns, heights, flow.tile!, 300)).toBe(false);
  });

  it('snaps the top up to the cards above it, and keeps every card off the tile', () => {
    for (let top = 0; top < 500; top += 37) {
      for (let col = 0; col <= 3; col++) {
        const flow = flowCards(items(heights), { col, top, width: 300, height: 220 });
        expect(overlaps(flow.columns, heights, flow.tile!, 220)).toBe(false);
        expect(flow.tile!.top).toBeLessThanOrEqual(top);
        const at = positions(flow.columns, heights);
        const covered = Object.entries(at).filter(([, p]) => p.col >= flow.tile!.col && p.col < flow.tile!.col + flow.tile!.span);
        const above = covered.filter(([, p]) => p.y < flow.tile!.top).map(([id, p]) => p.y + heights[id as keyof typeof heights] + CARD_GAP);
        expect(flow.tile!.top).toBe(above.length ? Math.max(...above) : 0);
      }
    }
  });

  it('a tile dropped low in a column sits under that column\'s first card, the rest flow on', () => {
    const flow = flowCards(items(heights), { col: 1, top: 200, width: 232, height: 260 });
    expect(flow.tile).toEqual({ col: 1, top: 120 + CARD_GAP, span: 1 });
    const at = positions(flow.columns, heights);
    expect(at.b).toEqual({ col: 1, y: 0 });
    expect(Object.values(at).filter((p) => p.col === 1 && p.y > 0).every((p) => p.y >= 132 + 260 + CARD_GAP)).toBe(true);
  });

  it('beside the cards, the tile takes its own columns and no card moves', () => {
    const flow = flowCards(items(heights), { col: 7, top: 50, width: 500, height: 300 });
    expect(flow.tile).toEqual({ col: 3, top: 0, span: 3 });
    expect(flow.columns.slice(0, 3)).toEqual(stackCards(items(heights)).map((c) => c.map((id) => ({ id }))));
    expect(flow.columns.slice(3)).toEqual([[{ gap: 300 }], [{ gap: 300 }], [{ gap: 300 }]]);
  });

  it('an empty zone holds just the tile', () => {
    expect(flowCards([], { col: 2, top: 90, width: 248, height: 200 })).toEqual({ columns: [[{ gap: 200 }], [{ gap: 200 }]], tile: { col: 0, top: 0, span: 2 } });
  });
});
