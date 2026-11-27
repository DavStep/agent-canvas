import { describe, expect, it } from 'vitest';
import { session } from '../testSession.ts';
import { filterSessions, searchCanvas } from './JumpBox.tsx';
import { railGroups } from '../chat/Rail.tsx';

const cut = session({ id: 'cut', name: 'Billing split', state: 'needs_you', need: 'interrupted',
  interruption: { kind: 'killed', reason: 'Its process ended mid-turn', at: 1, resetsAt: null } });
const asks = session({ id: 'asks', name: 'Billing export', state: 'needs_you', need: 'permission' });
const idle = session({ id: 'idle', name: 'Notes' });

describe('finding interrupted sessions', () => {
  it('⌘K: a leading "interrupted", "cut off" or "limit" finds only them, other words still narrow', () => {
    expect(filterSessions([cut, asks, idle], 'interrupted').map((s) => s.id)).toEqual(['cut']);
    expect(filterSessions([cut, asks, idle], 'cut off billing').map((s) => s.id)).toEqual(['cut']);
    expect(filterSessions([cut, asks, idle], 'limit notes')).toEqual([]);
    expect(filterSessions([cut, asks, idle], 'billing').map((s) => s.id)).toEqual(['cut', 'asks']);
    const zone = { id: 'folder:a', name: 'interrupted things', kind: 'folder' as const, folder: 'a', x: 0, y: 0, hueIndex: 0 };
    expect(searchCanvas([{ zone, cards: [cut, asks] }], 'interrupted').zones).toEqual([]);
  });

  it('the rail lists them in their own group, ahead of Needs you', () => {
    const groups = railGroups([cut, asks, idle], { version: 1, zones: [], assignments: {} }, null);
    expect(groups.map((g) => [g.key, g.sessions.map((s) => s.id)])).toEqual([['interrupted', ['cut']], ['needs', ['asks']], ['idle', ['idle']]]);
  });
});
