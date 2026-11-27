import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatState, ChatUpdate, Owner } from '../../shared/chat.ts';
import type { Layout } from '../../shared/types.ts';
import type { Probe } from '../adapter/liveness.ts';
import type { RawSession } from '../adapter/sessionFiles.ts';
import { ReplyTracker } from '../state.ts';
import { Store } from '../store.ts';
import { applyUpdate } from './chatLog.ts';
import { ClaudeEngine } from './claude/engine.ts';
import { FakeSdk, SESSION_ID as S } from './claude/fakeSdk.ts';
import { foreignSessionFile, ownerOf, OPENED_ELSEWHERE } from './ownership.ts';
import { BUSY_ELSEWHERE, busyElsewhere, WRITING_ALONGSIDE } from '../../shared/banners.ts';

const APP = 4100;
const OUR_CHILD = 4101;
const OTHER_APP = 5200;

const raw = (pid: number, sessionId: string): RawSession => ({
  pid, sessionId, hostSessionId: null, cwd: '/work/demo', name: '', status: 'busy', waitingFor: null,
  startedAt: 0, statusUpdatedAt: 0, procStart: null, nameSource: null,
});
const parents = new Map([[OUR_CHILD, APP], [OTHER_APP, 1]]);
const ctx = (claudeFiles: RawSession[], engineOwned: string[] = []) => ({
  claudeFiles, appPid: APP, parentOf: (pid: number) => parents.get(pid) ?? null, engineOwned: new Set(engineOwned),
});
const claude = (id: string) => ({ id, provider: 'claude' as const, state: 'idle' as const });
const codex = (id: string, state: 'working' | 'idle' = 'idle') => ({ id, provider: 'codex' as const, state });

describe('ownerOf', () => {
  it("claude file whose pid's parent is this app → here", () => {
    expect(ownerOf(claude('s1'), ctx([raw(OUR_CHILD, 's1')]))).toBe('here');
  });

  it('claude file from another process → elsewhere', () => {
    expect(ownerOf(claude('s1'), ctx([raw(OTHER_APP, 's1')]))).toBe('elsewhere');
    // Ours and another program's at once: never two writers, so elsewhere.
    expect(ownerOf(claude('s1'), ctx([raw(OUR_CHILD, 's1'), raw(OTHER_APP, 's1')], ['s1']))).toBe('elsewhere');
    // A pid whose parent cannot be told is someone else's: if in doubt, read-only.
    expect(ownerOf(claude('s1'), ctx([raw(9999, 's1')]))).toBe('elsewhere');
  });

  it('no live file → nobody', () => {
    expect(ownerOf(claude('s1'), ctx([raw(OTHER_APP, 's2')]))).toBe('nobody');
    // The engine's process is starting and has not written its file yet.
    expect(ownerOf(claude('s1'), ctx([], ['s1']))).toBe('here');
  });

  it("a claude file whose pid descends from this app through a wrapper → here; an unrelated tree → elsewhere", () => {
    const tree = new Map([[4302, 4301], [4301, APP], [6002, 6001], [6001, 1], [7001, 7002], [7002, 7001]]);
    const c = (files: RawSession[], owned: string[] = []) => ({ ...ctx(files, owned), parentOf: (pid: number) => tree.get(pid) ?? null });
    // app → wrapper → claude
    expect(ownerOf(claude('s1'), c([raw(4302, 's1')]))).toBe('here');
    expect(ownerOf(claude('s1'), c([raw(6002, 's1')]))).toBe('elsewhere');
    // A loop in the table never hangs, and never counts as this app's.
    expect(ownerOf(claude('s1'), c([raw(7001, 's1')]))).not.toBe('here');
    // Deeper than the walk goes: not this app's.
    const deep = new Map(Array.from({ length: 30 }, (_, i) => [8000 + i, 8001 + i] as [number, number]));
    deep.set(8030, APP);
    expect(ownerOf(claude('s1'), { ...ctx([raw(8000, 's1')]), parentOf: (pid: number) => deep.get(pid) ?? null })).toBe('elsewhere');
  });

  it('parents unknown: a session this app runs keeps its last owner; one nobody here runs is read-only', () => {
    const unknown = (owned: string[], last: Owner | null) => ({ ...ctx([raw(OUR_CHILD, 's1')], owned), parentOf: () => null, lastOwner: () => last });
    expect(ownerOf(claude('s1'), unknown(['s1'], 'here'))).toBe('here');
    expect(ownerOf(claude('s1'), unknown(['s1'], null))).toBe('here');
    expect(ownerOf(claude('s1'), unknown([], 'nobody'))).toBe('elsewhere');
  });

  it('codex thread in engine.owned() → here', () => {
    expect(ownerOf(codex('codex:t1', 'working'), ctx([], ['codex:t1']))).toBe('here');
    expect(ownerOf(codex('codex:t1'), ctx([], ['codex:t1']))).toBe('here');
  });

  it('codex thread with in-progress turn written by another process → elsewhere', () => {
    expect(ownerOf(codex('codex:t1', 'working'), ctx([]))).toBe('elsewhere');
    expect(ownerOf(codex('codex:t1'), ctx([]))).toBe('nobody');
  });
});

describe('a session running here gains a foreign owner', () => {
  const homes: string[] = [];
  const stores: Store[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((s) => s.stop()));
    await Promise.all(homes.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('session running here gains a foreign claude file → elsewhere and the engine is told to stop sending', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-own-'));
    homes.push(home);
    await fs.mkdir(path.join(home, 'sessions'));
    await fs.mkdir(path.join(home, 'projects', '-work-demo'), { recursive: true });
    await fs.copyFile(path.resolve(import.meta.dirname, '../../fixtures/claude/history-basic.jsonl'), path.join(home, 'projects', '-work-demo', `${S}.jsonl`));
    const writeFile = (pid: number, status = 'busy') => fs.writeFile(path.join(home, 'sessions', `${pid}.json`), JSON.stringify({
      pid, sessionId: S, cwd: '/work/demo', status, startedAt: 1, statusUpdatedAt: 2, entrypoint: pid === OUR_CHILD ? 'sdk-ts' : 'claude-desktop',
    }));

    const probe: Probe = { pidAlive: () => true, startTimes: async () => new Map() };
    const layout: Layout = { version: 1, zones: [], assignments: {} };
    let store: Store | null = null;
    const sdk = new FakeSdk();
    const engine = new ClaudeEngine({
      sdk, claudeHome: home, elsewhere: (id) => store?.owner(id) === 'elsewhere',
      workingElsewhere: (id) => busyElsewhere(store?.snapshot().sessions.find((s) => s.id === id)),
    });
    store = new Store({
      claudeHome: home, layout, replies: new ReplyTracker(), probe, minGapMs: 0, recentLimit: 0,
      engines: { claude: engine }, appPid: APP, parents: async (pids) => new Map(pids.flatMap((p) => (parents.has(p) ? [[p, parents.get(p)!]] : []))),
    });
    stores.push(store);

    let state: ChatState | null = null;
    state = await engine.open(S, (u: ChatUpdate) => { state = applyUpdate(state!, u); });
    await engine.send(S, 'hi', []);
    await writeFile(OUR_CHILD);
    await store.poll();
    expect(store.snapshot().sessions.find((s) => s.id === S)?.owner).toBe('here');
    expect(engine.owned().has(S)).toBe(true);

    // The owner opens the same session in the Claude app.
    await writeFile(OTHER_APP);
    await store.poll();
    expect(store.snapshot().sessions.find((s) => s.id === S)?.owner).toBe('elsewhere');
    expect(sdk.last.closed).toBe(true);
    expect(engine.owned().has(S)).toBe(false);
    expect(state!.owner).toBe('elsewhere');
    expect(state!.items.at(-1)).toMatchObject({ kind: 'notice', level: 'warn', text: OPENED_ELSEWHERE });
    const prompts = sdk.queries.map((q) => q.prompts.length);
    // Mid-turn there: a message here waits.
    await expect(engine.send(S, 'still there?', [])).rejects.toThrow(BUSY_ELSEWHERE);
    expect(sdk.queries.map((q) => q.prompts.length)).toEqual(prompts);
    await expect(engine.moveHere(S)).resolves.toBe(false);

    // Between its turns there: the message resumes the session here, alongside the Claude app,
    // and later polls do not take it away while it runs.
    await fs.rm(path.join(home, 'sessions', `${OUR_CHILD}.json`)); // this app's process ended
    await writeFile(OTHER_APP, 'idle');
    await store.poll();
    await engine.send(S, 'between turns', []);
    expect(sdk.queries).toHaveLength(2);
    expect(sdk.last.options.resume).toBe(S);
    expect(state!.owner).toBe('here');
    expect(state!.items.filter((i) => i.kind === 'notice').at(-1)).toMatchObject({ level: 'info', text: WRITING_ALONGSIDE });
    expect(engine.shared().has(S)).toBe(true);
    await store.poll();
    expect(sdk.last.closed).toBe(false);
    expect(engine.owned().has(S)).toBe(true);
    sdk.last.close();
    await new Promise((r) => setTimeout(r, 0));

    // Closed there: Move here succeeds and the next message resumes it here.
    await fs.rm(path.join(home, 'sessions', `${OTHER_APP}.json`));
    await fs.rm(path.join(home, 'sessions', `${OUR_CHILD}.json`), { force: true });
    await store.poll();
    await expect(engine.moveHere(S)).resolves.toBe(true);
    expect(state!.owner).toBe('nobody');
    await engine.send(S, 'back here', []);
    expect(sdk.queries).toHaveLength(3);
    expect(sdk.last.options.resume).toBe(S);
  });
});

describe('foreignSessionFile: read just before a Claude resume, so the last poll is not trusted', () => {
  const alive: Probe = { pidAlive: () => true, startTimes: async () => new Map() };
  const write = async (dir: string, pid: number, sessionId: string) =>
    fs.writeFile(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: '/w', startedAt: 1, status: 'idle', statusUpdatedAt: 1 }));

  it("another process tree's live file for the session is foreign; this app's own child, another session's file or none is not", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-foreign-'));
    try {
      const parents = async () => new Map([[901, 900], [902, 1], [903, 1]]);
      expect(await foreignSessionFile(dir, S, 900, parents, alive)).toBe(false);
      await write(dir, 901, S); // our child
      await write(dir, 903, 'another-session');
      expect(await foreignSessionFile(dir, S, 900, parents, alive)).toBe(false);
      await write(dir, 902, S); // the Claude app
      expect(await foreignSessionFile(dir, S, 900, parents, alive)).toBe(true);
      // When the parents cannot be told, a session this app does not run is not resumed.
      expect(await foreignSessionFile(dir, S, 900, async () => { throw new Error('ps timed out'); }, alive)).toBe(true);
      // A dead process's leftover file does not count.
      expect(await foreignSessionFile(dir, S, 900, parents, { pidAlive: (pid: number) => pid !== 902, startTimes: async () => new Map() })).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

