import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionsFile } from './sessionsFile.ts';

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function dataHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-data-'));
  homes.push(dir);
  return path.join(dir, '.agent-canvas');
}

describe('SessionsFile', () => {
  it('round-trips started sessions and per-session model/mode', async () => {
    const file = path.join(await dataHome(), 'sessions.json');
    const one = await SessionsFile.load(file);
    expect(one.started()).toEqual([]);
    expect(one.settings('s1')).toEqual({ model: null, mode: null });
    await one.recordStarted({ id: 'codex:t1', provider: 'codex', cwd: '/work/a', startedAt: 1790000000000 });
    await one.setSettings('codex:t1', { model: 'demo-large' });
    await one.setSettings('codex:t1', { mode: 'full-access' });
    await one.setSettings('s2', { mode: 'plan' });

    const two = await SessionsFile.load(file);
    expect(two.started()).toEqual([{ id: 'codex:t1', provider: 'codex', cwd: '/work/a', startedAt: 1790000000000 }]);
    expect(two.settings('codex:t1')).toEqual({ model: 'demo-large', mode: 'full-access' });
    expect(two.settings('s2')).toEqual({ model: null, mode: 'plan' });
  });

  it('restores the orchestrator identity and connection without assigning the role to other chats in its folder', async () => {
    const file = path.join(await dataHome(), 'sessions.json');
    const sessions = await SessionsFile.load(file);
    const project = { folder: '/work/a', connection: 'codex-api', id: 'codex:coordinator' } as const;
    await sessions.recordProject(project);
    await sessions.recordStarted({ cwd: project.folder, id: 'other', startedAt: 1, provider: 'claude' });
    const restored = await SessionsFile.load(file);
    expect(restored.project(project.folder)).toEqual(project);
    expect(restored.role(project.id)).toEqual(project);
    expect(restored.role('other')).toBeUndefined();
    expect(restored.project('/another/a')).toBeUndefined();
  });

  it('torn file → empty, not a crash', async () => {
    const home = await dataHome();
    await fs.mkdir(home, { recursive: true });
    const file = path.join(home, 'sessions.json');
    await fs.writeFile(file, '{"version":1,"started":[{"id":"s1","prov');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const loaded = await SessionsFile.load(file);
    expect(loaded.started()).toEqual([]);
    expect(loaded.settings('s1')).toEqual({ model: null, mode: null });
    await loaded.setSettings('s1', { model: 'opus' });
    expect((await SessionsFile.load(file)).settings('s1')).toEqual({ model: 'opus', mode: null });
  });

  it('0600', async () => {
    const home = await dataHome();
    const file = path.join(home, 'sessions.json');
    await (await SessionsFile.load(file)).setSettings('s1', { mode: 'plan' });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(home)).mode & 0o777).toBe(0o700);
  });

  it('without a file (demo mode) it keeps settings in memory and writes nothing', async () => {
    const memory = await SessionsFile.load(null);
    await memory.setSettings('s1', { model: 'opus' });
    expect(memory.settings('s1')).toEqual({ model: 'opus', mode: null });
  });
});
