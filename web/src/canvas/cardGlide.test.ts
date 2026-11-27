import { describe, expect, it } from 'vitest';
import { CARD_GLIDE_MS, glideFrom, glideLeft } from './cardGlide.ts';

describe('glideFrom', () => {
  const zone = { zone: 'a', zx: 100, zy: 200 };
  it('inside one zone counts only the place within the zone, so a zone that moved carries its cards', () => {
    expect(glideFrom({ ...zone, ox: 16, oy: 40 }, { zone: 'a', zx: 900, zy: -50, ox: 260, oy: 40 })).toEqual({ x: -244, y: 0 });
  });
  it('across zones counts where each zone sits on the board', () => {
    expect(glideFrom({ ...zone, ox: 16, oy: 40 }, { zone: 'b', zx: 500, zy: 200, ox: 16, oy: 140 })).toEqual({ x: -400, y: -100 });
  });
});

describe('glideLeft', () => {
  it('starts the whole way off, ends on the spot, and only ever closes in', () => {
    const from = { x: 120, y: -40 };
    expect(glideLeft(from, 1000, 1000)).toEqual(from);
    expect(glideLeft(from, 1000, 1000 + CARD_GLIDE_MS)).toEqual({ x: 0, y: 0 });
    expect(glideLeft(from, 1000, 99999)).toEqual({ x: 0, y: 0 });
    const mid = glideLeft(from, 1000, 1000 + CARD_GLIDE_MS / 2);
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(60);
    expect(mid.y).toBeLessThan(0);
  });
});
