import { describe, expect, it } from 'vitest';
import { demoSnapshot } from '../../../server/demo.ts';
import { session } from '../testSession.ts';
import type { ZoneLayout } from '../../../shared/types.ts';
import { filterSessions, searchCanvas } from './JumpBox.tsx';
import { searchClass } from './Zone.tsx';

const demo = demoSnapshot(Date.UTC(2026, 10, 19, 18, 0)).sessions;

describe('filterSessions', () => {
  it('matches "hostly" against the demo data', () => {
    expect(filterSessions(demo, 'hostly').map((s) => s.id)).toEqual(['demo-hostly']);
    expect(filterSessions(demo, 'Hostly').map((s) => s.id)).toEqual(['demo-hostly']);
  });

  it('matches nothing for "zzz"', () => {
    expect(filterSessions(demo, 'zzz')).toEqual([]);
  });

  it('matches the folder name too, and an empty query keeps every session in order', () => {
    const hits = filterSessions(demo, 'sailcloth').map((s) => s.id);
    expect(hits).toEqual(['demo-deploy']);
    expect(filterSessions(demo, '  ')).toEqual(demo);
  });

  it('finds an unnamed session by the title the card shows', () => {
    const list = [session({ id: 'x', name: '' }), session({ id: 'y', name: 'Other' })];
    expect(filterSessions(list, 'untitled').map((s) => s.id)).toEqual(['x']);
  });

  it('uses a leading provider name to distinguish chats in the same folder', () => {
    const list = [
      session({ id: 'claude', name: 'Discuss Codex', folder: 'garden-sim' }),
      session({ id: 'codex:1', provider: 'codex', name: 'Fix a bug', folder: 'garden-sim' }),
    ];
    expect(filterSessions(list, 'codex garden-sim').map((s) => s.id)).toEqual(['codex:1']);
    expect(filterSessions(list, 'claude code garden-sim').map((s) => s.id)).toEqual(['claude']);
  });
});

describe('searchCanvas', () => {
  const zone = (id: string, name: string): ZoneLayout => ({ id, name, kind: 'custom', folder: null, x: 0, y: 0, hueIndex: 0 });
  const groups = [
    { zone: zone('z1', 'Backend work'), cards: [session({ id: 'a', name: 'Fix login', folder: 'api' }), session({ id: 'b', name: 'Add cache', folder: 'api' })] },
    { zone: zone('z2', 'Design'), cards: [session({ id: 'c', name: 'Backend copy', folder: 'site' })] },
  ];

  it('finds zones by name and sessions by the zone they sit in', () => {
    const found = searchCanvas(groups, 'backend');
    expect(found.zones.map((g) => g.zone.id)).toEqual(['z1']);
    expect(found.sessions.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('narrows with more words across title and zone', () => {
    expect(searchCanvas(groups, 'backend cache').sessions.map((s) => s.id)).toEqual(['b']);
    expect(searchCanvas(groups, 'backend cache').zones).toEqual([]);
  });

  it('finds no zones for an empty query or a provider-only search', () => {
    expect(searchCanvas(groups, ' ').zones).toEqual([]);
    expect(searchCanvas(groups, 'claude design').zones).toEqual([]);
    expect(searchCanvas(groups, 'claude design').sessions.map((s) => s.id)).toEqual(['c']);
  });
});

describe('searchClass', () => {
  const hits = { cards: new Set(['a']), zones: new Set(['z1']), active: 'a' };
  it('marks hits, and the active one, only while a search is on', () => {
    expect(searchClass(hits, 'a', hits.cards)).toBe(' is-hit is-hit-active');
    expect(searchClass(hits, 'z1', hits.zones)).toBe(' is-hit');
    expect(searchClass(hits, 'b', hits.cards)).toBe('');
    expect(searchClass(null, 'a', undefined)).toBe('');
  });
});
