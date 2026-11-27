import { describe, expect, it } from 'vitest';
import { GRID, snapToGrid } from './snap.ts';

describe('snapToGrid', () => {
  it('rounds to the nearest grid step, between four dots', () => {
    expect(GRID).toBe(20);
    expect(snapToGrid(0)).toBe(0);
    expect(snapToGrid(9)).toBe(0);
    expect(snapToGrid(10)).toBe(20);
    expect(snapToGrid(31)).toBe(40);
    expect(snapToGrid(-9)).toBe(-0);
    expect(snapToGrid(-11)).toBe(-20);
  });
});
