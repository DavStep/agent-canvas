import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { conflicted, staged } from '../shared/projectGit.ts';
import { createProjectGit } from './projectGit.ts';

let dir: string, root: string;
const service = createProjectGit({ roots: () => [root, path.join(root, 'sub')] });
const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (file: string, text: string) => writeFile(path.join(root, file), text);
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'canvas-git-'));
  root = path.join(dir, 'checkout');
  await mkdir(root);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Canvas Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it('inspects, stages, unstages, commits exactly the checked content, and pushes to a local remote', async () => {
  const filename = ':(glob)* odd\nname';
  await write(filename, 'first version\n');
  await write('leave.txt', 'leave this out\n');
  git('init', '--bare', path.join(dir, 'remote.git'));
  git('remote', 'add', 'origin', path.join(dir, 'remote.git'));
  const read = () => service.status(root);
  let state = await read();
  expect(state.branch).toBe('main');
  expect(state.files.map(f => f.path)).toContain(filename);
  expect(await service.diff(root, filename)).toContain('+first version');
  const toggle = async (type: 'stage' | 'unstage') => {
    await service.act(root, { ...state, type, file: state.files.find(f => f.path === filename) });
    state = await read();
  };
  await toggle('stage');
  expect(state.files.filter(staged).map(f => f.path)).toEqual([filename]);
  await toggle('unstage');
  expect(state.files.filter(staged)).toHaveLength(0);
  await toggle('stage');
  await write(filename, 'second version\n');
  const diff = await service.diff(root, filename);
  expect(diff).toContain('Staged\n');
  expect(diff).toContain('+second version');
  await service.act(root, { ...state, type: 'commit', message: 'Only the staged version' });
  expect(git('show', 'HEAD:' + filename)).toBe('first version');
  expect(git('ls-tree', '--name-only', 'HEAD')).not.toContain('leave.txt');
  state = await read();
  expect(state.pushTo).toEqual({ remote: 'origin', branch: 'main' });
  await service.act(root, { ...state, type: 'push', remote: 'origin', destination: 'main' });
  expect(git('rev-parse', 'main@{upstream}')).toBe(state.head);
  expect(git('--git-dir=' + path.join(dir, 'remote.git'), 'rev-parse', 'refs/heads/main')).toBe(state.head);
  // Simulate a collaborator updating the remote between pushes.
  git('commit', '--allow-empty', '-m', 'remote change');
  git('push', 'origin', 'main');
  git('reset', '--soft', 'HEAD~1');
  git('commit', '--allow-empty', '-m', 'local change');
  state = await read();
  expect(state.ahead).toBe(1);
  await expect(service.act(root, { ...state, type: 'push', remote: 'origin', destination: 'main' })).rejects.toThrow(/non-fast-forward|fetch first/);
});

it('keeps nested project paths scoped and protects against a changed commit selection', async () => {
  await mkdir(path.join(root, 'sub'));
  await write('sub/a', 'nested');
  await write('other', 'outside');
  const sub = path.join(root, 'sub');
  let state = await service.status(sub);
  expect(state.files.map(f => f.path)).toEqual(['a']);
  await expect(service.diff(sub, '../other')).rejects.toThrow();
  await expect(service.status(dir)).rejects.toThrow('not on the canvas');
  await service.act(sub, { ...state, type: 'stage', file: state.files[0] });
  state = await service.status(sub);
  git('add', 'other');
  await expect(service.act(sub, { ...state, type: 'commit', message: 'nested' })).rejects.toThrow('outside');
  const whole = await service.status(root);
  await write('other', 'newly staged outside app');
  git('add', 'other');
  await expect(service.act(root, { ...whole, type: 'commit', message: 'stale' })).rejects.toThrow('Review');
});

it('detects unresolved merges and rejects normal staging or committing of the conflict', async () => {
  await write('a', 'base\n');
  git('add', 'a'); git('commit', '-m', 'base');
  git('switch', '-c', 'incoming');
  await write('a', 'incoming\n');
  git('commit', '-am', 'incoming');
  git('switch', 'main');
  await write('a', 'local\n');
  git('commit', '-am', 'local');
  expect(() => git('merge', 'incoming')).toThrow();
  const state = await service.status(root);
  expect(state.conflicts).toBe(true);
  expect(state.files.filter(conflicted).map(f => f.path)).toEqual(['a']);
  expect(await service.diff(root, 'a')).toContain('incoming');
  await expect(service.act(root, { ...state, type: 'commit', message: 'conflict' })).rejects.toThrow('Resolve');
});

it('bulk selects and deselects exactly the reviewed names, atomically, even before the first commit', async () => {
  await mkdir(path.join(root, 'sub'));
  const sub = path.join(root, 'sub');
  for (const name of ['a', ':(glob)*', 'two\nlines']) await write('sub/' + name, 'local');
  await write('outside', 'kept staged');
  git('add', 'outside');
  let state = await service.status(sub);
  const original = state.files;
  await service.act(sub, { ...state, type: 'stage', files: original });
  state = await service.status(sub);
  expect(state.files.every(staged)).toBe(true);
  await service.act(sub, { ...state, type: 'unstage', files: state.files });
  state = await service.status(sub);
  expect(state.files.every(f => f.index === '?')).toBe(true);
  expect(git('diff', '--cached', '--name-only')).toBe('outside');
  await write('sub/a', 'staged by another client');
  git('add', 'sub/a');
  await expect(service.act(sub, { ...state, type: 'stage', files: original })).rejects.toThrow();
  expect(git('diff', '--cached', '--name-only')).toBe('outside\nsub/a');
});

it('identifies staged whitespace and unstaged conflict markers with their file and line', async () => {
  await write('code', 'old\n');
  git('add', 'code'); git('commit', '-m', 'base');
  await write('code', 'old\nnew  \n');
  git('add', 'code');
  await write('code', 'old\nnew  \n<<<<<<< HEAD\n');
  const [file] = (await service.status(root)).files;
  expect(file?.issues).toEqual(expect.arrayContaining([
    { line: 2, message: 'trailing whitespace.', staged: true },
    { line: 3, message: 'leftover conflict marker', staged: false },
  ]));
});

it('counts the commits a push would send and refuses an empty push', async () => {
  git('init', '--bare', path.join(dir, 'remote.git'));
  git('remote', 'add', 'origin', path.join(dir, 'remote.git'));
  await write('a', 'one\n');
  git('add', 'a'); git('commit', '-m', 'one');
  // A branch the remote has never seen: the whole branch goes, count unknown.
  let state = await service.status(root);
  expect(state.ahead).toBeNull();
  await service.act(root, { ...state, type: 'push', remote: 'origin', destination: 'main' });
  state = await service.status(root);
  expect(state.ahead).toBe(0);
  await expect(service.act(root, { ...state, type: 'push', remote: 'origin', destination: 'main' })).rejects.toThrow('Nothing to push');
  git('commit', '--allow-empty', '-m', 'two');
  git('commit', '--allow-empty', '-m', 'three');
  expect((await service.status(root)).ahead).toBe(2);
});

it('pushes the branch even when a commit landed after the Git tab last read it', async () => {
  git('init', '--bare', path.join(dir, 'remote.git'));
  git('remote', 'add', 'origin', path.join(dir, 'remote.git'));
  await write('a', 'one\n');
  git('add', 'a'); git('commit', '-m', 'one');
  const stale = await service.status(root);
  // An agent on the canvas commits while the panel is open.
  git('commit', '--allow-empty', '-m', 'from an agent');
  await service.act(root, { ...stale, type: 'push', remote: 'origin', destination: 'main' });
  expect(git('--git-dir=' + path.join(dir, 'remote.git'), 'rev-parse', 'refs/heads/main')).toBe(git('rev-parse', 'HEAD'));
  git('switch', '-c', 'other');
  await expect(service.act(root, { ...stale, type: 'push', remote: 'origin', destination: 'main' })).rejects.toThrow('branch changed');
});
