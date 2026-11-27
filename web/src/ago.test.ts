import { describe, expect, it } from 'vitest';
import { ago } from './ago.ts';

const now = Date.UTC(2026, 10, 19, 18, 0);
const S = 1000;
const M = 60 * S;
const H = 60 * M;

describe('ago', () => {
  it('formats the five examples', () => {
    expect(ago(now - 45 * S, now)).toBe('45s');
    expect(ago(now - 6 * M, now)).toBe('6m');
    expect(ago(now - 3 * H, now)).toBe('3h');
    expect(ago(now - 27 * H, now)).toBe('yesterday');
    expect(ago(now - 50 * H, now)).toBe('2d');
  });

  it('rounds down at the unit edges and never goes negative', () => {
    expect(ago(now - 59 * S, now)).toBe('59s');
    expect(ago(now - 60 * S, now)).toBe('1m');
    expect(ago(now - (24 * H - 1), now)).toBe('23h');
    expect(ago(now - 48 * H, now)).toBe('2d');
    expect(ago(now + 5 * S, now)).toBe('0s');
  });
});
