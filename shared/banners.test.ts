import { describe, expect, it } from 'vitest';
import { busyElsewhere } from './banners.ts';

describe('busyElsewhere', () => {
  it('is a turn in progress in another app: working, or waiting on its own approval, question or terminal prompt', () => {
    expect(busyElsewhere({ owner: 'elsewhere', state: 'working', need: null })).toBe(true);
    expect(busyElsewhere({ owner: 'elsewhere', state: 'needs_you', need: 'permission' })).toBe(true);
    expect(busyElsewhere({ owner: 'elsewhere', state: 'needs_you', need: 'terminal' })).toBe(true);
  });

  it('is not a finished reply, an idle session, one run here or no card', () => {
    expect(busyElsewhere({ owner: 'elsewhere', state: 'needs_you', need: 'reply' })).toBe(false);
    expect(busyElsewhere({ owner: 'elsewhere', state: 'idle', need: null })).toBe(false);
    expect(busyElsewhere({ owner: 'here', state: 'working', need: null })).toBe(false);
    expect(busyElsewhere(undefined)).toBe(false);
  });
});
