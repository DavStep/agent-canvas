import { describe, expect, it } from 'vitest';
import type { Layout } from '../../../shared/types.ts';
import { session } from '../testSession.ts';
import { checkMissing, hasTarget, zonesWithCards, type ViewRequest } from './Canvas.tsx';

const layout: Layout = {
  version: 1,
  zones: [{ id: 'z-custom', name: 'Later', kind: 'custom', folder: null, x: 0, y: 0, hueIndex: 0 }],
  assignments: {},
};
const groups = zonesWithCards([session({ id: 'a', folder: 'alpha' })], layout);

describe('hasTarget', () => {
  it('finds drawn zones and cards only', () => {
    expect(hasTarget({ kind: 'zone', id: 'z-custom' }, groups)).toBe(true);
    expect(hasTarget({ kind: 'zone', id: 'folder:alpha' }, groups)).toBe(true);
    expect(hasTarget({ kind: 'zone', id: 'gone' }, groups)).toBe(false);
    expect(hasTarget({ kind: 'card', id: 'a' }, groups)).toBe(true);
    expect(hasTarget({ kind: 'card', id: 'b' }, groups)).toBe(false);
  });
});

describe('zonesWithCards', () => {
  const saved: Layout = {
    version: 1,
    zones: [
      { id: 'folder:alpha', name: 'alpha', kind: 'folder', folder: 'alpha', x: 0, y: 0, hueIndex: 0 },
      { id: 'folder:beta', name: 'beta', kind: 'folder', folder: 'beta', x: 400, y: 0, hueIndex: 1 },
      { id: 'custom:empty', name: 'Later', kind: 'custom', folder: null, x: 800, y: 0, hueIndex: 2 },
    ],
    assignments: {},
  };

  it('draws no folder zone without sessions, and every custom zone, empty or not', () => {
    const drawn = zonesWithCards([session({ id: 'a', folder: 'alpha' })], saved).map((g) => g.zone.id);
    expect(drawn).toEqual(['folder:alpha', 'custom:empty']);
  });

  it('draws a hidden folder zone again, at its saved position and hue, with the next session of its folder', () => {
    const groups = zonesWithCards([session({ id: 'a', folder: 'alpha' }), session({ id: 'b', folder: 'beta' })], saved);
    expect(groups.find((g) => g.zone.id === 'folder:beta')?.zone).toMatchObject({ x: 400, y: 0, hueIndex: 1 });
  });

  it('leaves a removed folder zone off until one of its sessions runs, needs the owner, or changes after the removal', () => {
    const removed: Layout = { ...saved, zones: saved.zones.map((z) => (z.id === 'folder:alpha' ? { ...z, hiddenAt: 5_000 } : z)) };
    const old = session({ id: 'a', folder: 'alpha', state: 'idle', stateSince: 4_000 });
    expect(zonesWithCards([old], removed).map((g) => g.zone.id)).toEqual(['custom:empty']);
    for (const back of [
      session({ id: 'b', folder: 'alpha', state: 'working', stateSince: 1_000 }),
      session({ id: 'c', folder: 'alpha', state: 'needs_you', need: 'reply', stateSince: 1_000 }),
      session({ id: 'd', folder: 'alpha', state: 'idle', stateSince: 6_000 }),
    ]) {
      const alpha = zonesWithCards([old, back], removed).find((g) => g.zone.id === 'folder:alpha');
      expect(alpha?.cards.map((c) => c.id)).toEqual([back.id]);
      expect(alpha?.zone).toMatchObject({ x: 0, y: 0, hueIndex: 0 });
    }
  });

  it('draws a folder zone that knows its folder on disk before any session is in it, unless it was removed', () => {
    const made = { id: 'folder:gamma', name: 'gamma', kind: 'folder' as const, folder: 'gamma', path: '/work/gamma', x: 1200, y: 0, hueIndex: 3 };
    const groups = zonesWithCards([session({ id: 'a', folder: 'alpha' })], { ...saved, zones: [...saved.zones, made] });
    expect(groups.map((g) => g.zone.id)).toEqual(['folder:alpha', 'custom:empty', 'folder:gamma']);
    expect(groups.find((g) => g.zone.id === 'folder:gamma')).toEqual({ zone: made, cards: [] });
    const removed = { ...saved, zones: [...saved.zones, { ...made, hiddenAt: 5_000 }] };
    expect(zonesWithCards([], removed).map((g) => g.zone.id)).toEqual(['custom:empty']);
  });

  it('hides a folder zone whose only session was moved to another zone', () => {
    const moved = { ...saved, assignments: { a: 'custom:empty' } };
    const groups = zonesWithCards([session({ id: 'a', folder: 'alpha' })], moved);
    expect(groups.map((g) => [g.zone.id, g.cards.map((c) => c.id)])).toEqual([['custom:empty', ['a']]]);
  });
});

describe('checkMissing', () => {
  const request: ViewRequest = { kind: 'card', id: 'b' };

  it('keeps a request whose target is missing until the next snapshot', () => {
    const first = checkMissing(request, 100, null);
    expect(first).toEqual({ drop: false, missing: { request, generatedAt: 100 } });
    // Renders of the same snapshot (a clock tick, a measure) keep it waiting.
    expect(checkMissing(request, 100, first.missing)).toEqual({ drop: false, missing: first.missing });
  });

  it('drops it once the next snapshot has rendered without the target', () => {
    const first = checkMissing(request, 100, null);
    expect(checkMissing(request, 200, first.missing)).toEqual({ drop: true, missing: null });
  });

  it('starts over for a new request', () => {
    const first = checkMissing(request, 100, null);
    const other: ViewRequest = { kind: 'zone', id: 'gone' };
    expect(checkMissing(other, 200, first.missing)).toEqual({ drop: false, missing: { request: other, generatedAt: 200 } });
  });
});
