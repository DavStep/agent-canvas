import { describe, expect, it } from 'vitest';
import { remember, switchCommand, type SessionPage } from './sessionPages.ts';

const pages = (entries: [string, SessionPage][]) => new Map(entries);

describe('switchCommand', () => {
  it("opens the next session's remembered page with the flag it was opened with, fresh (no history from the last)", () => {
    const m = pages([
      ['a', { url: 'http://localhost:5173/', typed: false, autoLoaded: 'http://localhost:5173/' }],
      ['b', { url: 'https://example.com/docs', typed: true, autoLoaded: null }],
    ]);
    expect(switchCommand(m, 'a', 'b')).toEqual({ kind: 'navigate', url: 'https://example.com/docs', typed: true, fresh: true });
    expect(switchCommand(m, 'b', 'a')).toEqual({ kind: 'navigate', url: 'http://localhost:5173/', typed: false, fresh: true });
  });

  it('clears the view for a session with nothing remembered', () => {
    const m = pages([['a', { url: 'http://localhost:5173/', typed: false, autoLoaded: null }]]);
    expect(switchCommand(m, 'a', 'c')).toEqual({ kind: 'clear' });
    expect(switchCommand(pages([['c', { url: null, typed: true, autoLoaded: null }]]), 'a', 'c')).toEqual({ kind: 'clear' });
    // The first chat opened since the app started: the view may hold nothing, or a page from before a reload.
    expect(switchCommand(m, null, 'c')).toEqual({ kind: 'clear' });
  });

  it('does nothing when the view already holds this session\'s page', () => {
    const m = pages([['a', { url: 'http://localhost:5173/', typed: false, autoLoaded: null }]]);
    expect(switchCommand(m, 'a', 'a')).toBeNull();
  });
});

describe('remember', () => {
  it("keeps a session's page and whether the owner typed it", () => {
    const m = new Map<string, SessionPage>();
    remember(m, 'a', { url: 'http://localhost:5173/', typed: false });
    expect(m.get('a')).toEqual({ url: 'http://localhost:5173/', typed: false, autoLoaded: null });
    remember(m, 'a', { url: 'https://example.com/', typed: true });
    expect(m.get('a')).toMatchObject({ url: 'https://example.com/', typed: true });
    // A cleared view (no page) forgets nothing the owner typed.
    remember(m, 'a', { url: null });
    expect(m.get('a')).toMatchObject({ url: null, typed: true });
  });
});
