import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Layout } from '../shared/types.ts';
import { applyLayoutOp } from './layoutOps.ts';
import { createDebouncedSave, isLayout, isReplyState, loadJson, saveJsonAtomic } from './persist.ts';

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-persist-'));
  tempDirs.push(dir);
  return dir;
}

const isNumberBox = (v: unknown): v is { n: number } =>
  typeof v === 'object' && v !== null && typeof (v as { n?: unknown }).n === 'number';

const layout: Layout = {
  version: 1,
  zones: [
    { id: 'z1', name: 'alpha', kind: 'folder', folder: 'alpha', x: 10, y: -20, hueIndex: 0 },
    { id: 'z2', name: 'Inbox', kind: 'custom', folder: null, x: null, y: null, hueIndex: 6 },
  ],
  assignments: { 'session-1': 'z2' },
};

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('saveJsonAtomic and loadJson', () => {
  it('round-trips a value', async () => {
    const file = path.join(await tempDir(), 'layout.json');
    await saveJsonAtomic(file, layout);
    expect(await loadJson(file, { version: 1, zones: [], assignments: {} } as Layout, isLayout)).toEqual(layout);
  });

  it.each(['z1', 'z2'])('round-trips appearance edits for %s in an older layout', async (id) => {
    const file = path.join(await tempDir(), 'layout.json');
    const original = layout.zones.find((zone) => zone.id === id)!;
    const edited = applyLayoutOp(layout, { type: 'editZone', id, name: '  Tools  ', color: '#aa55ff', icon: 'code' });
    await saveJsonAtomic(file, edited);
    const loaded = await loadJson(file, layout, isLayout);
    expect(loaded.zones.find((zone) => zone.id === id)).toEqual({ ...original, name: 'Tools', color: '#aa55ff', icon: 'code' });
    expect(loaded.assignments).toEqual(layout.assignments);
  });

  it('returns the fallback for a missing file and creates nothing', async () => {
    const dir = await tempDir();
    const fallback = { n: 7 };
    expect(await loadJson(path.join(dir, 'missing.json'), fallback, isNumberBox)).toBe(fallback);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('moves an unparsable file aside to <file>.bad-<epoch> and returns the fallback', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'state.json');
    await fs.writeFile(file, '{"n": 1,,');
    const before = Date.now();
    expect(await loadJson(file, { n: 0 }, isNumberBox)).toEqual({ n: 0 });
    const names = await fs.readdir(dir);
    expect(names).toHaveLength(1);
    const bad = names[0] ?? '';
    const match = /^state\.json\.bad-(\d+)$/.exec(bad);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(before);
    expect(await fs.readFile(path.join(dir, bad), 'utf8')).toBe('{"n": 1,,');
  });

  it('moves a parsable but invalid file aside too', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'state.json');
    await fs.writeFile(file, '{"n": "one"}');
    expect(await loadJson(file, { n: 0 }, isNumberBox)).toEqual({ n: 0 });
    const names = await fs.readdir(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^state\.json\.bad-\d+$/);
  });

  it('leaves the previous file intact when the process dies between write and rename', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'layout.json');
    await saveJsonAtomic(file, layout);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated crash'));
    await expect(saveJsonAtomic(file, { ...layout, zones: [] })).rejects.toThrow('simulated crash');
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(layout);
    expect(await loadJson(file, { version: 1, zones: [], assignments: {} } as Layout, isLayout)).toEqual(layout);
  });

  it('writes files with mode 0600 into a new folder with mode 0700', async () => {
    const home = path.join(await tempDir(), 'home', 'nested');
    const file = path.join(home, 'state.json');
    await saveJsonAtomic(file, { version: 1, pendingReply: {} });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(home)).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(home)).toEqual(['state.json']);
  });
});

describe('isLayout', () => {
  it('accepts a well-formed layout', () => {
    expect(isLayout(layout)).toBe(true);
    expect(isLayout({ version: 1, zones: [], assignments: {} })).toBe(true);
    expect(isLayout({ ...layout, zones: [{ ...layout.zones[0], hiddenAt: 1_700_000_000_000 }] })).toBe(true);
  });

  it("a folder zone's path is optional (older files have none) and must be a string", () => {
    expect(isLayout({ ...layout, zones: [{ ...layout.zones[0], path: '/Users/me/code/gamma' }] })).toBe(true);
    expect(isLayout({ ...layout, zones: [{ ...layout.zones[0], path: 42 }] })).toBe(false);
    expect(isLayout({ ...layout, zones: [{ ...layout.zones[0], path: null }] })).toBe(false);
  });

  it('a layout with an added folder zone survives a save and a load', async () => {
    const file = path.join(await tempDir(), 'layout.json');
    const withPath = applyLayoutOp(layout, { type: 'addFolderZone', path: '/Users/me/code/gamma' });
    expect(withPath.zones.at(-1)).toMatchObject({ id: 'folder:gamma', path: '/Users/me/code/gamma' });
    await saveJsonAtomic(file, withPath);
    expect(await loadJson(file, { version: 1, zones: [], assignments: {} } as Layout, isLayout)).toEqual(withPath);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['version 2', { ...layout, version: 2 }],
    ['zones not an array', { ...layout, zones: {} }],
    ['assignments not an object', { ...layout, assignments: [] }],
    ['an assignment that is not a string', { ...layout, assignments: { s: 3 } }],
    ['a zone missing id', { ...layout, zones: [{ ...layout.zones[0], id: undefined }] }],
    ['a zone missing hueIndex', { ...layout, zones: [{ ...layout.zones[0], hueIndex: undefined }] }],
    ['a hueIndex out of range', { ...layout, zones: [{ ...layout.zones[0], hueIndex: 7 }] }],
    ['a fractional hueIndex', { ...layout, zones: [{ ...layout.zones[0], hueIndex: 1.5 }] }],
    ['an unknown kind', { ...layout, zones: [{ ...layout.zones[0], kind: 'other' }] }],
    ['a non-numeric x', { ...layout, zones: [{ ...layout.zones[0], x: '10' }] }],
    ['a non-finite y', { ...layout, zones: [{ ...layout.zones[0], y: Number.NaN }] }],
    ['a folder that is neither string nor null', { ...layout, zones: [{ ...layout.zones[0], folder: 1 }] }],
    ['a zone name that is not a string', { ...layout, zones: [{ ...layout.zones[0], name: null }] }],
    ['a hiddenAt that is not a number', { ...layout, zones: [{ ...layout.zones[0], hiddenAt: 'today' }] }],
  ])('rejects %s', (_label, value) => {
    expect(isLayout(value)).toBe(false);
  });
});

describe('isReplyState', () => {
  it('accepts a well-formed state', () => {
    expect(isReplyState({ version: 1, pendingReply: { a: 1700000000000 } })).toBe(true);
    expect(isReplyState({ version: 1, pendingReply: {} })).toBe(true);
  });

  it.each([
    ['null', null],
    ['version 2', { version: 2, pendingReply: {} }],
    ['pendingReply missing', { version: 1 }],
    ['pendingReply an array', { version: 1, pendingReply: [] }],
    ['a pending time that is not a number', { version: 1, pendingReply: { a: '1' } }],
    ['a non-finite pending time', { version: 1, pendingReply: { a: Number.POSITIVE_INFINITY } }],
  ])('rejects %s', (_label, value) => {
    expect(isReplyState(value)).toBe(false);
  });
});

describe('createDebouncedSave', () => {
  it('runs once 300 ms after the last of several requests', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const save = createDebouncedSave(run, 300);
    save.schedule();
    await vi.advanceTimersByTimeAsync(200);
    save.schedule();
    await vi.advanceTimersByTimeAsync(299);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('flush runs a pending save at once and waits for it', async () => {
    vi.useFakeTimers();
    let done = false;
    const save = createDebouncedSave(async () => { done = true; }, 300);
    save.schedule();
    await save.flush();
    expect(done).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(true);
  });

  it('flush with nothing pending resolves without running', async () => {
    const run = vi.fn(async () => {});
    await createDebouncedSave(run, 300).flush();
    expect(run).not.toHaveBeenCalled();
  });

  it('never runs two saves at once', async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const save = createDebouncedSave(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 500));
      active -= 1;
    }, 300);
    save.schedule();
    await vi.advanceTimersByTimeAsync(300); // first save starts and takes 500 ms
    save.schedule();
    await vi.advanceTimersByTimeAsync(300); // second is due while the first still runs
    await vi.advanceTimersByTimeAsync(1000);
    expect(maxActive).toBe(1);
  });

  it('logs a failed save and keeps going', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const save = createDebouncedSave(run, 300);
    save.schedule();
    await vi.advanceTimersByTimeAsync(300);
    save.schedule();
    await save.flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(process.stderr.write).toHaveBeenCalledWith('agent-canvas: save failed: disk full\n');
  });
});
