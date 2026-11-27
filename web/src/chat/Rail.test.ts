import { describe, expect, it } from 'vitest';
import type { Layout } from '../../../shared/types.ts';
import { session } from '../testSession.ts';
import { railGroups } from './Rail.tsx';

const layout: Layout = {
  version: 1,
  zones: [
    { id: 'folder:a', name: 'a', kind: 'folder', folder: 'a', x: 0, y: 0, hueIndex: 0 },
    { id: 'folder:b', name: 'b', kind: 'folder', folder: 'b', x: 0, y: 0, hueIndex: 1 },
  ],
  assignments: {},
};

const sessions = [
  session({ id: 'w', state: 'working', folder: 'a' }),
  session({ id: 'n', state: 'needs_you', need: 'permission', folder: 'b' }),
  session({ id: 'd', state: 'needs_you', need: 'reply', folder: 'b' }),
  session({ id: 'i', state: 'idle', folder: 'a' }),
  session({ id: 'u', state: 'unknown', folder: 'b' }),
];

describe('railGroups', () => {
  it('groups sessions Needs you, Done, Working, Idle (a finished reply is Done; unknown counts as idle)', () => {
    const groups = railGroups(sessions, layout, null);
    expect(groups.map((g) => [g.label, g.sessions.map((s) => s.id)])).toEqual([
      ['Needs you', ['n']], ['Done', ['d']], ['Working', ['w']], ['Idle', ['i', 'u']],
    ]);
  });

  it('keeps only the chosen zone\'s sessions and leaves empty groups out', () => {
    const groups = railGroups(sessions, layout, 'folder:a');
    expect(groups.map((g) => [g.label, g.sessions.map((s) => s.id)])).toEqual([['Working', ['w']], ['Idle', ['i']]]);
  });
});
