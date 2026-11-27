import { describe, expect, it } from 'vitest';
import type { Layout, SessionView } from '../shared/types.ts';
import { applyLayoutOp, ensureFolderZones, zoneIdFor } from './layoutOps.ts';

const empty = (): Layout => ({ version: 1, zones: [], assignments: {} });

function session(id: string, folder: string): SessionView {
  return {
    id, provider: 'claude', hostId: null, name: id, cwd: `/work/${folder}`, folder,
    state: 'idle', need: null, activity: null, rawStatus: 'idle',
    stateSince: 0, startedAt: 0, branch: null, model: null,
    lastPrompt: null, lastAnswer: null, subagents: [], owner: 'nobody', ownerNote: null, host: null,
  };
}

function createCustom(layout: Layout, name: string): { layout: Layout; id: string } {
  const next = applyLayoutOp(layout, { type: 'createZone', name });
  const added = next.zones.find((z) => !layout.zones.some((old) => old.id === z.id));
  if (!added) throw new Error('createZone added nothing');
  return { layout: next, id: added.id };
}

describe('ensureFolderZones', () => {
  it('gives hues 0-6 in creation order and caps at 6', () => {
    const folders = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const layout = ensureFolderZones(empty(), folders);
    expect(layout.zones.map((z) => z.hueIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 6]);
    expect(layout.zones[0]).toEqual({
      id: 'folder:a', name: 'a', kind: 'folder', folder: 'a', x: null, y: null, hueIndex: 0,
    });
  });

  it('names the empty folder "No folder"', () => {
    const layout = ensureFolderZones(empty(), ['']);
    expect(layout.zones[0]?.id).toBe('folder:');
    expect(layout.zones[0]?.name).toBe('No folder');
    expect(layout.zones[0]?.folder).toBe('');
  });

  it('is idempotent', () => {
    const once = ensureFolderZones(empty(), ['a', 'b', '']);
    const twice = ensureFolderZones(once, ['a', 'b', '']);
    expect(twice).toEqual(once);
  });

  it('never removes or recolours existing zones', () => {
    const first = ensureFolderZones(empty(), ['a', 'b']);
    const second = ensureFolderZones(first, ['c']);
    expect(second.zones.map((z) => [z.id, z.hueIndex])).toEqual([
      ['folder:a', 0], ['folder:b', 1], ['folder:c', 2],
    ]);
  });
});

describe('applyLayoutOp', () => {
  it('createZone adds a custom zone with a custom:<8 hex> id and the next hue', () => {
    const base = ensureFolderZones(empty(), ['a']);
    const { layout, id } = createCustom(base, '  Waiting on review  ');
    expect(id).toMatch(/^custom:[0-9a-f]{8}$/);
    const zone = layout.zones.find((z) => z.id === id);
    expect(zone).toEqual({
      id, name: 'Waiting on review', kind: 'custom', folder: null, x: null, y: null, hueIndex: 1,
    });
  });

  it('createZone limits names to 60 characters and rejects empty names', () => {
    const { layout, id } = createCustom(empty(), 'x'.repeat(100));
    expect(layout.zones.find((z) => z.id === id)?.name).toBe('x'.repeat(60));
    const base = empty();
    expect(applyLayoutOp(base, { type: 'createZone', name: '   ' })).toBe(base);
  });

  it('does not mutate its input', () => {
    const base = ensureFolderZones(empty(), ['a']);
    const copy = structuredClone(base);
    applyLayoutOp(base, { type: 'moveZone', id: 'folder:a', x: 10, y: 20 });
    applyLayoutOp(base, { type: 'assign', sessionId: 's1', zoneId: 'folder:a' });
    expect(base).toEqual(copy);
  });

  it('moveZone sets coordinates; unknown ids leave the layout unchanged', () => {
    const base = ensureFolderZones(empty(), ['a']);
    const moved = applyLayoutOp(base, { type: 'moveZone', id: 'folder:a', x: 10, y: 20 });
    expect(moved.zones[0]).toMatchObject({ x: 10, y: 20 });
    expect(applyLayoutOp(base, { type: 'moveZone', id: 'folder:zzz', x: 1, y: 1 })).toBe(base);
  });

  it('renameZone trims and renames; whitespace-only names are a no-op', () => {
    const base = ensureFolderZones(empty(), ['a']);
    const renamed = applyLayoutOp(base, { type: 'renameZone', id: 'folder:a', name: ' Main ' });
    expect(renamed.zones[0]?.name).toBe('Main');
    expect(applyLayoutOp(base, { type: 'renameZone', id: 'folder:a', name: '   ' })).toBe(base);
    expect(applyLayoutOp(base, { type: 'renameZone', id: 'nope', name: 'x' })).toBe(base);
  });

  it('deleteZone on a folder zone is a no-op', () => {
    const base = ensureFolderZones(empty(), ['a']);
    expect(applyLayoutOp(base, { type: 'deleteZone', id: 'folder:a' })).toBe(base);
  });

  it('hideZone takes a folder zone off the canvas and brings it back; custom and unknown zones are a no-op', () => {
    const base = ensureFolderZones(empty(), ['a']);
    const hidden = applyLayoutOp(base, { type: 'hideZone', id: 'folder:a', at: 1000 });
    expect(hidden.zones[0]).toMatchObject({ id: 'folder:a', hiddenAt: 1000 });
    const shown = applyLayoutOp(hidden, { type: 'hideZone', id: 'folder:a', at: null });
    expect(shown.zones[0]).not.toHaveProperty('hiddenAt');
    expect(applyLayoutOp(base, { type: 'hideZone', id: 'folder:a', at: null })).toBe(base);
    expect(applyLayoutOp(base, { type: 'hideZone', id: 'folder:zz', at: 1 })).toBe(base);
    expect(applyLayoutOp(base, { type: 'hideZone', id: 'folder:a', at: Number.NaN })).toBe(base);
    const { layout, id } = createCustom(base, 'Later');
    expect(applyLayoutOp(layout, { type: 'hideZone', id, at: 1 })).toBe(layout);
    // A removed zone stays removed: the reader does not make it again.
    expect(ensureFolderZones(hidden, ['a'])).toBe(hidden);
  });

  it('deleteZone on a custom zone removes the zone and its assignments', () => {
    let { layout, id } = createCustom(ensureFolderZones(empty(), ['a']), 'Later');
    layout = applyLayoutOp(layout, { type: 'assign', sessionId: 's1', zoneId: id });
    layout = applyLayoutOp(layout, { type: 'assign', sessionId: 's2', zoneId: 'folder:a' });
    const deleted = applyLayoutOp(layout, { type: 'deleteZone', id });
    expect(deleted.zones.map((z) => z.id)).toEqual(['folder:a']);
    expect(deleted.assignments).toEqual({ s2: 'folder:a' });
  });

  it('assign sets and, with null, removes an assignment; unknown zones are a no-op', () => {
    const base = ensureFolderZones(empty(), ['a']);
    const assigned = applyLayoutOp(base, { type: 'assign', sessionId: 's1', zoneId: 'folder:a' });
    expect(assigned.assignments).toEqual({ s1: 'folder:a' });
    const cleared = applyLayoutOp(assigned, { type: 'assign', sessionId: 's1', zoneId: null });
    expect(cleared.assignments).toEqual({});
    expect(applyLayoutOp(base, { type: 'assign', sessionId: 's1', zoneId: 'custom:00000000' })).toBe(base);
  });
});

describe('addFolderZone', () => {
  it('creates folder:<name> with its path for a folder no session has run in yet', () => {
    const next = applyLayoutOp(ensureFolderZones(empty(), ['a']), { type: 'addFolderZone', path: '/Users/me/code/gamma/' });
    expect(next.zones.map((z) => z.id)).toEqual(['folder:a', 'folder:gamma']);
    expect(next.zones[1]).toEqual({ id: 'folder:gamma', name: 'gamma', kind: 'folder', folder: 'gamma', x: null, y: null, hueIndex: 1, path: '/Users/me/code/gamma' });
  });

  it('records the path on a zone that exists, keeping its name, place and colour, and brings a removed one back', () => {
    let layout = ensureFolderZones(empty(), ['a', 'gamma']);
    layout = applyLayoutOp(layout, { type: 'renameZone', id: 'folder:gamma', name: 'Gamma API' });
    layout = applyLayoutOp(layout, { type: 'moveZone', id: 'folder:gamma', x: 40, y: 50 });
    layout = applyLayoutOp(layout, { type: 'hideZone', id: 'folder:gamma', at: 123 });
    const next = applyLayoutOp(layout, { type: 'addFolderZone', path: '/Users/me/code/gamma' });
    expect(next.zones[1]).toEqual({ id: 'folder:gamma', name: 'Gamma API', kind: 'folder', folder: 'gamma', x: 40, y: 50, hueIndex: 1, path: '/Users/me/code/gamma' });
    // Asked again, nothing changes: the same layout object, so nothing is saved or pushed.
    expect(applyLayoutOp(next, { type: 'addFolderZone', path: '/Users/me/code/gamma' })).toBe(next);
    // Another folder of the same name takes the zone over (zones are keyed by folder name).
    expect(applyLayoutOp(next, { type: 'addFolderZone', path: '/elsewhere/gamma' }).zones[1]!.path).toBe('/elsewhere/gamma');
  });

  it('a worktree stands for its repository; a relative path, the root and a scratch folder are no-ops', () => {
    const base = empty();
    const wt = applyLayoutOp(base, { type: 'addFolderZone', path: '/work/alpha/.claude/worktrees/fix-1' });
    expect(wt.zones).toEqual([expect.objectContaining({ id: 'folder:alpha', path: '/work/alpha' })]);
    for (const path of ['code/gamma', '', '/', '/tmp/scratch-workspaces/x']) {
      expect(applyLayoutOp(base, { type: 'addFolderZone', path })).toBe(base);
    }
  });
});

describe('zoneIdFor', () => {
  it('uses the assignment when it names an existing zone', () => {
    let { layout, id } = createCustom(ensureFolderZones(empty(), ['a']), 'Later');
    layout = applyLayoutOp(layout, { type: 'assign', sessionId: 's1', zoneId: id });
    expect(zoneIdFor(session('s1', 'a'), layout)).toBe(id);
  });

  it('falls back to folder:<folder> when the assigned zone was deleted', () => {
    const layout: Layout = {
      ...ensureFolderZones(empty(), ['a']),
      assignments: { s1: 'custom:deadbeef' },
    };
    expect(zoneIdFor(session('s1', 'a'), layout)).toBe('folder:a');
    expect(zoneIdFor(session('s2', ''), layout)).toBe('folder:');
  });
});
