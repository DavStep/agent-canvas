import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_TEXT_BYTES } from '../shared/files.ts';
import { canvasRoots, createProjectFiles, isInside } from './files.ts';

// 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let base: string;
let root: string;
let outside: string;
const files = () => createProjectFiles({ roots: () => [root] });

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-files-')));
  root = path.join(base, 'project');
  outside = path.join(base, 'secret');
  await mkdir(path.join(root, 'src', 'deep'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(path.join(root, 'logs'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'key.txt'), 'top secret');
  await writeFile(path.join(root, '.gitignore'), '# build\n/logs/\n*.tmp\n!keep.tmp\n');
  await writeFile(path.join(root, 'package.json'), '{"name":"x"}');
  await writeFile(path.join(root, 'broken.json'), '{"name":');
  await writeFile(path.join(root, 'README'), 'hello');
  await writeFile(path.join(root, 'pixel.png'), PNG);
  await writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  await writeFile(path.join(root, 'notes.unknownext'), 'plain words');
  await writeFile(path.join(root, 'big.txt'), 'x'.repeat(MAX_TEXT_BYTES + 1));
  await writeFile(path.join(root, 'scratch.tmp'), '');
  await writeFile(path.join(root, 'keep.tmp'), '');
  await writeFile(path.join(root, 'src', 'b10.ts'), '');
  await writeFile(path.join(root, 'src', 'b2.ts'), '');
  await writeFile(path.join(root, 'node_modules', 'left-pad', 'index.js'), '');
  await symlink(outside, path.join(root, 'escape'));
  await symlink(path.join(outside, 'key.txt'), path.join(root, 'key-link.txt'));
  await symlink(path.join(root, 'src'), path.join(root, 'src-link'));
});
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

describe('isInside', () => {
  it('holds the root and what is under it, and nothing beside it', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b/c/d')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a')).toBe(false);
    expect(isInside('/a/b', '/a/b/../c')).toBe(false);
  });
});

describe('canvasRoots', () => {
  it('allows folder zones\' folders and sessions\' folders (a worktree as its repository), nothing else', () => {
    const roots = canvasRoots({
      layout: { version: 1, assignments: {}, zones: [
        { id: 'folder:a', name: 'a', kind: 'folder', folder: 'a', path: '/w/a', x: null, y: null, hueIndex: 0 },
        { id: 'custom:1', name: 'Mine', kind: 'custom', folder: null, x: null, y: null, hueIndex: 1 },
      ] },
      sessions: [{ cwd: '/w/b/.claude/worktrees/fix' }, { cwd: '' }, { cwd: '/w/a' }] as never,
    });
    expect(roots.sort()).toEqual(['/w/a', '/w/b']);
  });
});

describe('project files: confinement', () => {
  it('refuses a root the canvas does not show, the disk root, and non-strings', async () => {
    await expect(files().list(outside, '')).rejects.toThrow('not on the canvas');
    await expect(files().list('/', '')).rejects.toThrow();
    await expect(files().list(42, '')).rejects.toThrow();
    await expect(files().list('relative/path', '')).rejects.toThrow();
  });

  it('refuses .., absolute and malformed relative paths', async () => {
    for (const bad of ['..', '../secret', 'src/../../secret', '/etc', 'src//deep', './src', 'a\0b', 'src\\..']) {
      await expect(files().list(root, bad), bad).rejects.toThrow('Not a path in this project');
      await expect(files().preview(root, bad), bad).rejects.toThrow();
    }
  });

  it('refuses a symlink that leads out of the project, for listing and reading', async () => {
    await expect(files().list(root, 'escape')).rejects.toThrow('outside the project');
    await expect(files().preview(root, 'escape/key.txt')).rejects.toThrow('outside the project');
    await expect(files().preview(root, 'key-link.txt')).rejects.toThrow('outside the project');
  });

  it('follows a link that stays inside', async () => {
    const listing = await files().list(root, 'src-link');
    expect(listing.entries.map((e) => e.name)).toContain('deep');
    expect(await files().preview(root, 'src-link/b2.ts')).toEqual({ kind: 'text', size: 0, text: '' });
  });

  it('reads through a root given by another name (a link to it) only where the canvas shows it', async () => {
    const alias = path.join(base, 'alias');
    await symlink(root, alias);
    const viaAlias = createProjectFiles({ roots: () => [alias] });
    expect((await viaAlias.list(alias, '')).entries.length).toBeGreaterThan(0);
    await expect(viaAlias.preview(alias, 'escape/key.txt')).rejects.toThrow('outside the project');
  });

  it('maps a root to its folder on disk (the demo)', async () => {
    const demo = createProjectFiles({ roots: () => ['/Users/demo/Documents/x'], onDisk: () => root });
    expect((await demo.preview('/Users/demo/Documents/x', 'README'))).toMatchObject({ kind: 'text', text: 'hello' });
  });

  it('says so when the folder is missing', async () => {
    const gone = createProjectFiles({ roots: () => ['/no/such/folder/here'] });
    await expect(gone.list('/no/such/folder/here', '')).rejects.toThrow('isn’t on this Mac');
  });
});

describe('project files: listing', () => {
  it('lists one level, folders first in natural order, without .git, quieting noise and .gitignore matches', async () => {
    const { entries, truncated } = await files().list(root, '');
    expect(truncated).toBe(false);
    const names = entries.map((e) => e.name);
    expect(names).not.toContain('.git');
    expect(names.slice(0, 5)).toEqual(['escape', 'logs', 'node_modules', 'src', 'src-link']);
    const by = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(by.node_modules).toMatchObject({ kind: 'dir', ignored: true });
    expect(by.logs).toMatchObject({ kind: 'dir', ignored: true });
    expect(by.src).toMatchObject({ kind: 'dir', ignored: false });
    expect(by['scratch.tmp']!.ignored).toBe(true);
    expect(by['keep.tmp']!.ignored).toBe(false);
    expect(by['package.json']).toMatchObject({ kind: 'file', size: 12, ignored: false });
    expect(by.escape).toMatchObject({ kind: 'dir', outside: true });
    expect(by['key-link.txt']).toMatchObject({ kind: 'file', outside: true });
    expect(by['src-link']!.outside).toBeUndefined();
    // Not walked: the listing holds the top level only.
    expect(names).not.toContain('deep');
  });

  it('sorts numbers naturally and marks everything under a noisy folder quiet', async () => {
    expect((await files().list(root, 'src')).entries.map((e) => e.name)).toEqual(['deep', 'b2.ts', 'b10.ts']);
    expect((await files().list(root, 'node_modules/left-pad')).entries).toEqual([{ name: 'index.js', kind: 'file', size: 0, ignored: true }]);
  });
});

describe('project files: preview', () => {
  it('returns JSON text as it is, valid or not (the page parses it)', async () => {
    expect(await files().preview(root, 'package.json')).toEqual({ kind: 'json', size: 12, text: '{"name":"x"}' });
    expect(await files().preview(root, 'broken.json')).toMatchObject({ kind: 'json', text: '{"name":' });
  });

  it('returns an image as a data URL of its type', async () => {
    const p = await files().preview(root, 'pixel.png');
    expect(p).toMatchObject({ kind: 'image', mime: 'image/png', size: PNG.length });
    expect(p.kind === 'image' && p.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('sniffs a file of unknown type: text shows, binary does not', async () => {
    expect(await files().preview(root, 'notes.unknownext')).toMatchObject({ kind: 'text', text: 'plain words' });
    expect(await files().preview(root, 'blob.bin')).toEqual({ kind: 'binary', size: 6 });
    expect(await files().preview(root, 'README')).toMatchObject({ kind: 'text' });
  });

  it('declines a text file over the cap without reading it', async () => {
    expect(await files().preview(root, 'big.txt')).toEqual({ kind: 'tooLarge', size: MAX_TEXT_BYTES + 1, limit: MAX_TEXT_BYTES });
  });

  it('refuses a folder or the root as a file', async () => {
    await expect(files().preview(root, 'src')).rejects.toThrow();
    await expect(files().preview(root, '')).rejects.toThrow('Not a file');
  });
});
