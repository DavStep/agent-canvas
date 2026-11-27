import { describe, expect, it } from 'vitest';
import { CARD_GAP } from '../canvas/stackCards.ts';
import { COLUMN_STEP, flowCards, type FlowEntry } from '../canvas/zoneFlow.ts';
import { flowTiles, flowZone, type ItemTile } from './flowItems.ts';

const cards = (...h: number[]) => h.map((cardH, i) => ({ id: `c${i}`, cardH }));

/** Each card's top in its column, as the columns would stack them (CSS gap between entries). */
function tops(columns: FlowEntry[][]): Map<string, { col: number; y: number }> {
  const out = new Map<string, { col: number; y: number }>();
  columns.forEach((column, col) => {
    let y = 0;
    for (const e of column) {
      if ('id' in e) out.set(e.id, { col, y });
      y += ('gap' in e ? e.gap : HEIGHTS.get(e.id) ?? 0) + CARD_GAP;
    }
  });
  return out;
}
let HEIGHTS = new Map<string, number>();
const withHeights = (items: { id: string; cardH: number }[]) => { HEIGHTS = new Map(items.map((i) => [i.id, i.cardH])); return items; };

describe('flowZone', () => {
  it('with no images is flowCards itself', () => {
    const items = cards(100, 80, 120, 90);
    const tile = { col: 1, top: 0, width: 300, height: 200 };
    expect(flowZone(items, tile, [])).toEqual({ ...flowCards(items, tile), items: new Map() });
    expect(flowZone(items, null, [])).toEqual({ ...flowCards(items, null), items: new Map() });
  });

  it('an image takes its slot; cards that would overlap it go below it', () => {
    const items = withHeights(cards(100, 100, 100, 100));
    const image: ItemTile = { id: 'img', col: 0, top: 0, width: 232, height: 150 };
    const flow = flowZone(items, null, [image]);
    expect(flow.items.get('img')).toEqual({ col: 0, top: 0, span: 1 });
    for (const [, at] of tops(flow.columns)) {
      if (at.col === 0) expect(at.y).toBeGreaterThanOrEqual(150 + CARD_GAP);
    }
  });

  it('pulls an image up to the cards above it, and keeps the preview tile and images apart', () => {
    const items = withHeights(cards(100, 100));
    const flow = flowZone(items, { col: 0, top: 0, width: 232, height: 200 }, [{ id: 'img', col: 0, top: 50, width: 232, height: 120 }]);
    expect(flow.tile).toEqual({ col: 0, top: 0, span: 1 });
    // The image would overlap the preview: it goes below it.
    expect(flow.items.get('img')!.top).toBe(200 + CARD_GAP);
    const far = flowZone(items, null, [{ id: 'img', col: 0, top: 20_000, width: 232, height: 120 }]);
    // Below the card in its column, and no further.
    expect(far.items.get('img')!.top).toBe(100 + CARD_GAP);
  });
});

describe('flowTiles', () => {
  it('keeps each stack of questions level with its source when an earlier thread pushes that source down', () => {
    const items = withHeights(cards(100, 125).map((c, col) => ({ ...c, col })));
    const note = (id: string, beside: string) => ({ id, beside, col: 0, top: 0, width: 232, height: 150 });
    const flow = flowTiles(items, [note('a', 'c0'), note('b', 'c0'), note('c', 'c1')]);
    const positions = tops(flow.columns);
    expect(flow.tiles.get('a')).toEqual({ col: 1, top: positions.get('c0')!.y, span: 1 });
    expect(flow.tiles.get('b')!.top).toBe(150 + CARD_GAP);
    expect(positions.get('c1')!.y).toBe(2 * (150 + CARD_GAP));
    expect(flow.tiles.get('c')).toEqual({ col: 2, top: positions.get('c1')!.y, span: 1 });
  });

  it('two images in one slot stack; side by side in an empty zone, one past the other', () => {
    const stacked = flowTiles([], [{ id: 'a', col: 0, top: 0, width: 232, height: 100 }, { id: 'b', col: 0, top: 0, width: 232, height: 80 }]);
    expect(stacked.tiles.get('a')).toEqual({ col: 0, top: 0, span: 1 });
    expect(stacked.tiles.get('b')).toEqual({ col: 0, top: 100 + CARD_GAP, span: 1 });
    // The column holds room for both, so the zone is as tall as they are.
    expect(stacked.columns[0]).toEqual([{ gap: 100 + CARD_GAP + 80 }]);

    const beside = flowTiles([], [{ id: 'a', col: 0, top: 0, width: 232, height: 100 }, { id: 'b', col: 1, top: 0, width: 232, height: 80 }]);
    expect(beside.tiles.get('b')).toEqual({ col: 1, top: 0, span: 1 });
    // Far beyond the last column used, a tile comes back beside the others.
    const far = flowTiles([], [{ id: 'a', col: 9, top: 0, width: 232, height: 100 }]);
    expect(far.tiles.get('a')!.col).toBe(0);
  });

  it('a wide image spans the columns its width needs', () => {
    const items = withHeights(cards(100, 100, 100, 100));
    const flow = flowTiles(items, [{ id: 'w', col: 0, top: 0, width: COLUMN_STEP + 100, height: 90 }]);
    expect(flow.tiles.get('w')!.span).toBe(2);
    for (const [, at] of tops(flow.columns)) if (at.col < 2) expect(at.y).toBeGreaterThanOrEqual(90 + CARD_GAP);
  });
});
