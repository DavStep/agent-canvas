import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBoardPreviews, writeBoardPreviews } from './boardPreviews.ts';

const KEY = 'agent-canvas:board-previews';
const base = { session: 's', zone: 'z', title: 'Game', tab: 'browser', address: null, width: 380, height: 416 };

describe('board previews in storage', () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('gives a preview saved before slots existed the first slot, where it always sat', () => {
    store[KEY] = JSON.stringify([base]);
    expect(readBoardPreviews()).toEqual([{ ...base, col: 0, top: 0 }]);
  });

  it('keeps a saved slot and size across a write and a read', () => {
    writeBoardPreviews([{ ...base, tab: 'browser', col: 2, top: 264, width: 520, height: 330 }], 's');
    expect(readBoardPreviews()).toEqual([{ ...base, col: 2, top: 264, width: 520, height: 330, open: true }]);
  });

  it('puts a broken slot back in the first one, and still drops previews of impossible size', () => {
    store[KEY] = JSON.stringify([{ ...base, col: -1, top: 10 }, { ...base, session: 't', col: 1.5, top: 'x' }, { ...base, session: 'u', width: 100 }]);
    expect(readBoardPreviews().map((p) => [p.session, p.col, p.top])).toEqual([['s', 0, 0], ['t', 0, 0]]);
  });
});
