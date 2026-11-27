import { describe, expect, it } from 'vitest';
import { CARD_GAP, stackCards } from './stackCards.ts';

/** Where each card's top sits inside the zone's cards area: its column and its y. */
function positions(columns: string[][], heights: Record<string, number>) {
  const at: Record<string, { col: number; y: number }> = {};
  columns.forEach((column, col) => {
    let y = 0;
    for (const id of column) {
      at[id] = { col, y };
      y += heights[id]! + CARD_GAP;
    }
  });
  return at;
}

const items = (heights: Record<string, number>) => Object.entries(heights).map(([id, cardH]) => ({ id, cardH }));

describe('stackCards', () => {
  it('lays out the mockup garden-sim zone: three cards in a row, idle cards under them, no room kept for bubbles', () => {
    const heights = { hostly: 120, purchases: 120, reconnect: 120, preview: 82, codex: 82 };
    const columns = stackCards(items(heights));
    expect(columns).toEqual([['hostly', 'preview'], ['purchases', 'codex'], ['reconnect']]);
    // Every first-row card starts at the top, and the next card sits one gap below: no lead.
    expect(positions(columns, heights)).toEqual({
      hostly: { col: 0, y: 0 }, purchases: { col: 1, y: 0 }, reconnect: { col: 2, y: 0 },
      preview: { col: 0, y: 132 }, codex: { col: 1, y: 132 },
    });
  });

  it('lays out the mockup dashboard zone: the tall card alone, idle cards stacked beside it', () => {
    const heights = { dbviz: 204, mcp: 82, '3d': 82, progression: 82 };
    const columns = stackCards(items(heights));
    expect(columns).toEqual([['dbviz'], ['mcp', '3d', 'progression']]);
    expect(positions(columns, heights).progression).toEqual({ col: 1, y: 188 });
  });

  it('drops each later card into the shortest column', () => {
    const heights = { a: 120, b: 82, c: 120, d: 82 };
    expect(stackCards(items(heights))).toEqual([['a', 'd'], ['b', 'c']]);
  });

  it('caps the zone at five columns and handles an empty zone', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, cardH: 82 }));
    expect(stackCards(many)).toHaveLength(5);
    expect(stackCards([])).toEqual([]);
  });
});
