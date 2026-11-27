import { describe, expect, it } from 'vitest';
import { historyDepth, historyStep, idFromHash, pageTitle, replyIds } from './App.tsx';
import { session } from './testSession.ts';

describe('idFromHash', () => {
  it('reads the selected card from the hash', () => {
    expect(idFromHash('#abc')).toBe('abc');
    expect(idFromHash('#a%20b')).toBe('a b');
  });

  it('gives no selection for an empty or malformed hash instead of throwing', () => {
    expect(idFromHash('')).toBeNull();
    expect(idFromHash('#')).toBeNull();
    expect(idFromHash('#%E0%A4%A')).toBeNull();
    expect(idFromHash('#%')).toBeNull();
  });
});

describe('pageTitle', () => {
  it('carries the waiting count while connected', () => {
    expect(pageTitle(2, true)).toBe('(2) Agent canvas');
    expect(pageTitle(0, true)).toBe('Agent canvas');
  });

  it('says it is reconnecting, without a count, while disconnected', () => {
    expect(pageTitle(2, false)).toBe('Agent canvas (reconnecting)');
    expect(pageTitle(0, false)).toBe('Agent canvas (reconnecting)');
  });
});

describe('replyIds', () => {
  it('lists only the cards waiting because they finished', () => {
    expect(replyIds([
      session({ id: 'a', state: 'needs_you', need: 'reply' }),
      session({ id: 'b', state: 'needs_you', need: 'question' }),
      session({ id: 'c', state: 'idle' }),
      session({ id: 'd', state: 'needs_you', need: 'reply' }),
    ])).toEqual(['a', 'd']);
  });
});

describe('historyStep', () => {
  it('reads the mouse side buttons as Back and Forward, and nothing else', () => {
    expect(historyStep(3)).toBe(-1);
    expect(historyStep(4)).toBe(1);
    for (const b of [0, 1, 2, 5]) expect(historyStep(b)).toBeNull();
  });
});

describe('historyDepth', () => {
  it('counts the steps this window pushed, and 0 for the entry it opened on or anything malformed', () => {
    expect(historyDepth({ depth: 3 })).toBe(3);
    for (const s of [null, undefined, {}, { depth: 0 }, { depth: -1 }, { depth: 1.5 }, { depth: '2' }, 'x']) expect(historyDepth(s)).toBe(0);
  });
});
