import { describe, expect, it } from 'vitest';
import type { RunView } from '../../../shared/runs.ts';
import { zonesWithCards } from '../components/Canvas.tsx';
import { projectDraftId } from '../agent/agent.ts';
import { cardWaits, curve, linesOf, plannedCards, plannedName } from './links.ts';

const NOW = 1_800_000_000_000;

function view(patch: Partial<RunView> = {}): RunView {
  return {
    id: 'r1', target: { kind: 'session', id: 'b' }, node: 'b', folder: '/w', edges: [{ from: 'a', state: 'working' }], mode: 'all',
    prompt: 'Install the app', handOff: false, by: 'owner', createdAt: NOW, status: 'waiting', reason: 'Waiting for A', ...patch,
  };
}
const planned = (patch: Partial<RunView> = {}) => view({
  id: 'r2', node: 'plan:r2', target: { kind: 'new', cwd: '/w', provider: 'codex', model: 'gpt', effort: null, mode: null, title: 'Release notes' }, ...patch,
});

describe('cardWaits', () => {
  it('keys each waiting run by its card, and leaves sent ones out', () => {
    const waits = cardWaits([view(), view({ id: 'r3', node: 'c', status: 'started' }), view({ id: 'r4', node: 'd', status: 'blocked', reason: 'Blocked: A was interrupted' })]);
    expect([...waits.keys()]).toEqual(['b', 'd']);
    expect(waits.get('b')).toEqual({ runId: 'r1', status: 'waiting', reason: 'Waiting for A', prompt: 'Install the app', blocked: false });
    expect(waits.get('d')!.blocked).toBe(true);
    expect(cardWaits(undefined).size).toBe(0);
  });
});

describe('planned cards', () => {
  it('draws a planned session as an idle card named by its title or its prompt', () => {
    const [card] = plannedCards([planned(), view()]);
    expect(card).toMatchObject({ id: 'plan:r2', provider: 'codex', name: 'Release notes', cwd: '/w', folder: '/w', state: 'idle', rawStatus: 'planned' });
    expect(plannedCards([planned({ status: 'started' })])).toEqual([]);
    expect(plannedName(planned({ target: { kind: 'new', cwd: '/w', provider: 'claude', model: null, effort: null, mode: null, title: null }, prompt: 'Write the notes\nmore' }))).toBe('Write the notes');
  });

  it('adds planned cards to their folder zone only', () => {
    const groups = zonesWithCards(plannedCards([planned()]), { version: 1, zones: [], assignments: {} });
    expect(groups.map(g => [g.zone.folder, g.cards.map(c => c.id)])).toEqual([['/w', ['plan:r2']]]);
  });
});

describe('linesOf', () => {
  it('styles each line by its upstream and its run', () => {
    expect(linesOf([view({ edges: [{ from: 'a', state: 'working' }, { from: 'c', state: 'done' }] })]).map((l) => [l.from, l.to, l.state]))
      .toEqual([['a', 'b', 'working'], ['c', 'b', 'done']]);
    expect(linesOf([view({ status: 'started' })])[0]!.state).toBe('started');
    // An interrupted upstream: that line is red, the others keep their state.
    expect(linesOf([view({ status: 'blocked', edges: [{ from: 'a', state: 'interrupted' }, { from: 'c', state: 'done' }] })]).map((l) => l.state)).toEqual(['blocked', 'done']);
    // A failed run (no interrupted upstream): every line is red.
    expect(linesOf([view({ status: 'blocked', error: 'no', edges: [{ from: 'a', state: 'done' }] })])[0]!.state).toBe('blocked');
  });

  it('ends a handoff with no orchestrator yet on its zone’s placeholder', () => {
    const [line] = linesOf([view({ node: null, target: { kind: 'handoff', cwd: '/w', provider: null, model: null, mode: null } })]);
    expect(line!.to).toBe(projectDraftId('folder:/w'));
  });
});

describe('curve', () => {
  const a = { x: 0, y: 0, width: 200, height: 100 };
  it('leaves the right edge for a card to the right, with the arrow tip on its left edge', () => {
    const c = curve(a, { x: 400, y: 20, width: 200, height: 100 });
    expect(c.start).toEqual({ x: 200, y: 50 });
    expect(c.end).toEqual({ x: 400, y: 70 });
    expect(c.arrow.startsWith('M400 70')).toBe(true);
    expect(c.d.startsWith('M200 50C')).toBe(true);
  });

  it('goes down from the bottom edge for a card below', () => {
    const c = curve(a, { x: 0, y: 300, width: 200, height: 100 });
    expect(c.start).toEqual({ x: 100, y: 100 });
    expect(c.end).toEqual({ x: 100, y: 300 });
    expect(c.c1.y).toBeGreaterThan(c.start.y);
    expect(c.c2.y).toBeLessThan(c.end.y);
  });

  it('goes left for a card to the left', () => {
    const c = curve({ x: 500, y: 0, width: 200, height: 100 }, a);
    expect(c.start.x).toBe(500);
    expect(c.end.x).toBe(200);
  });
});
