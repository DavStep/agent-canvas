import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onePerSession, readSessionFiles, type RawSession } from './sessionFiles.ts';

const SESSIONS = path.resolve(import.meta.dirname, '../../fixtures/sessions');
const sid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

const temps: string[] = [];

async function tempCopy(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-sessions-'));
  temps.push(dir);
  await fs.cp(SESSIONS, dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('readSessionFiles', () => {
  it('reads only <digits>.json files', async () => {
    const { sessions } = await readSessionFiles(SESSIONS);
    expect(sessions.map((s) => s.sessionId)).not.toContain('should-be-ignored');
    expect(sessions.every((s) => s.pid >= 1001)).toBe(true);
  });

  it('never opens a .key file', async () => {
    const readFile = vi.spyOn(fs, 'readFile');
    const open = vi.spyOn(fs, 'open');
    await readSessionFiles(SESSIONS);
    const touched = [...readFile.mock.calls, ...open.mock.calls].map((c) => String(c[0]));
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.some((p) => p.endsWith('.key'))).toBe(false);
  });

  it('reads each status as written, including waitingFor and an unknown status', async () => {
    const { sessions } = await readSessionFiles(SESSIONS);
    const by = new Map(sessions.map((s) => [s.sessionId, s]));
    expect(by.get(sid(1))?.status).toBe('busy');
    expect(by.get(sid(2))?.status).toBe('shell');
    expect(by.get(sid(3))?.status).toBe('idle');
    expect(by.get(sid(4))).toMatchObject({ status: 'waiting', waitingFor: 'permission prompt' });
    expect(by.get(sid(5))).toMatchObject({ status: 'waiting', waitingFor: 'input needed' });
    expect(by.get(sid(6))?.status).toBe('compacting');
    expect(by.get(sid(1))).toEqual({
      pid: 1001, sessionId: sid(1), hostSessionId: 'host-0001', cwd: '/work/alpha',
      name: 'Busy session', status: 'busy', waitingFor: null, startedAt: 1790000000000,
      statusUpdatedAt: 1790000100000, procStart: 'Mon Sep 21 10:00:00 2026', nameSource: 'user',
    });
  });

  it('lists a torn file by filename and still returns the others', async () => {
    const { sessions, torn } = await readSessionFiles(SESSIONS);
    expect(torn).toEqual(['1007.json']);
    expect(sessions.map((s) => s.sessionId)).not.toContain(sid(7));
    expect(sessions).toHaveLength(9);
  });

  it('lists a torn file by sessionId when a previous read knew it', async () => {
    const dir = await tempCopy();
    const good = '{"pid":1007,"sessionId":"' + sid(7) + '","startedAt":1,"status":"idle"}';
    await fs.writeFile(path.join(dir, '1007.json'), good);
    expect((await readSessionFiles(dir)).torn).toEqual([]);
    await fs.writeFile(path.join(dir, '1007.json'), good.slice(0, 20));
    expect((await readSessionFiles(dir)).torn).toEqual([sid(7)]);
  });

  it('forgets the sessionId of a file that left the folder', async () => {
    const dir = await tempCopy();
    const file = path.join(dir, '1007.json');
    await fs.writeFile(file, '{"pid":1007,"sessionId":"' + sid(7) + '","startedAt":1,"status":"idle"}');
    await readSessionFiles(dir);
    await fs.rm(file);
    await readSessionFiles(dir);
    await fs.writeFile(file, '{"pid":1007,"sess');
    expect((await readSessionFiles(dir)).torn).toEqual(['1007.json']);
  });

  it('turns missing optional fields into null or empty strings', async () => {
    const { sessions } = await readSessionFiles(SESSIONS);
    expect(sessions.find((s) => s.sessionId === sid(10))).toEqual({
      pid: 1010, sessionId: sid(10), hostSessionId: null, cwd: '', name: '', status: 'idle',
      waitingFor: null, startedAt: 1790001000000, statusUpdatedAt: 1790001000000, procStart: null, nameSource: null,
    });
  });

  it('falls back from statusUpdatedAt to updatedAt, then startedAt', async () => {
    const { sessions } = await readSessionFiles(SESSIONS);
    expect(sessions.find((s) => s.sessionId === sid(6))?.statusUpdatedAt).toBe(1790000600000);
    expect(sessions.find((s) => s.sessionId === sid(10))?.statusUpdatedAt).toBe(1790001000000);
  });

  it('returns every file of a sessionId shared by two, for liveness to choose between', async () => {
    const { sessions } = await readSessionFiles(SESSIONS);
    expect(sessions.filter((s) => s.sessionId === sid(8)).map((s) => s.pid)).toEqual([1008, 1009]);
  });

  it('returns nothing for a missing folder', async () => {
    expect(await readSessionFiles(path.join(SESSIONS, 'nope'))).toEqual({ sessions: [], torn: [] });
  });
});

describe('onePerSession', () => {
  const file = (pid: number, sessionId: string, statusUpdatedAt: number): RawSession => ({
    pid, sessionId, hostSessionId: null, cwd: '', name: '', status: 'idle', waitingFor: null,
    startedAt: 0, statusUpdatedAt, procStart: null, nameSource: null,
  });

  it('keeps the live file with the larger statusUpdatedAt when two share a sessionId', () => {
    const files = [file(1, 'a', 100), file(2, 'a', 200), file(3, 'b', 50)];
    expect(onePerSession(files, [true, true, true]).map((f) => f.pid)).toEqual([2, 3]);
  });

  it('never lets a dead file hide a live one, however recent the dead one is', () => {
    const files = [file(1, 'a', 100), file(2, 'a', 900)];
    expect(onePerSession(files, [true, false]).map((f) => f.pid)).toEqual([1]);
    expect(onePerSession([...files].reverse(), [false, true]).map((f) => f.pid)).toEqual([1]);
  });

  it('drops a session whose files are all dead', () => {
    expect(onePerSession([file(1, 'a', 1), file(2, 'a', 2)], [false, false])).toEqual([]);
  });
});
