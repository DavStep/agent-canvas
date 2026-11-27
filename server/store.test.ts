import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Layout } from '../shared/types.ts';
import { defaultProbe, type Probe } from './adapter/liveness.ts';
import { ReplyTracker } from './state.ts';
import type { Engine } from './engines/engine.ts';
import { Store, type StoreOptions } from './store.ts';

const PROJECTS = path.resolve(import.meta.dirname, '../fixtures/projects');
const sid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const emptyLayout = (): Layout => ({ version: 1, zones: [], assignments: {} });

const temps: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(stores.splice(0).map((s) => s.stop()));
  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** A CLAUDE_HOME with the fixture transcripts and session files owned by this (live) process. */
async function claudeHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-home-'));
  temps.push(home);
  await fs.mkdir(path.join(home, 'sessions'));
  await fs.cp(PROJECTS, path.join(home, 'projects'), { recursive: true });
  return home;
}

async function writeSession(home: string, file: number, n: number, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const body = {
    pid: process.pid, sessionId: sid(n), hostSessionId: `host-${n}`, cwd: '/work/alpha', name: `Session ${n}`,
    startedAt: 1790000000000, status, statusUpdatedAt: 1790000000000 + n, ...extra,
  };
  await fs.writeFile(path.join(home, 'sessions', `${file}.json`), JSON.stringify(body));
}

function makeStore(home: string, opts: Partial<Pick<StoreOptions, 'codexHome' | 'onPersist' | 'replies' | 'probe' | 'minGapMs' | 'recentLimit' | 'engines' | 'appPid' | 'parents' | 'processes' | 'agentCwd'>> = {}) {
  // Polls in these tests follow each other at once; the 250 ms floor has its own test. Recent
  // (not live) sessions are left out unless a test asks for them.
  const store = new Store({
    claudeHome: home, codexHome: opts.codexHome, layout: emptyLayout(), replies: opts.replies ?? new ReplyTracker(), onPersist: opts.onPersist,
    probe: opts.probe, minGapMs: opts.minGapMs ?? 0, recentLimit: opts.recentLimit ?? 0,
    engines: opts.engines, appPid: opts.appPid, parents: opts.parents, processes: opts.processes, agentCwd: opts.agentCwd,
  });
  stores.push(store);
  const changes = vi.fn();
  store.onChange(changes);
  return { store, changes };
}

describe('Store', () => {
  it('yields no sessions for an empty sessions folder', async () => {
    const { store } = makeStore(await claudeHome());
    await store.poll();
    expect(store.snapshot()).toMatchObject({ demo: false, sessions: [], layout: emptyLayout() });
  });

  it('builds views from session files and transcript tails', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy');
    await writeSession(home, 3, 3, 'idle', { cwd: '/work/beta' });
    const { store } = makeStore(home);
    await store.poll();
    const { sessions, layout } = store.snapshot();
    expect(sessions.map((s) => [s.id, s.state])).toEqual([[sid(1), 'working'], [sid(3), 'idle']]);
    expect(sessions[0]?.lastPrompt).not.toBeNull();
    expect(layout.zones.map((z) => z.id)).toEqual(['folder:alpha', 'folder:beta']);
  });

  it('groups Codex worktrees with Claude, tracks finished turns, and drops archived chats', async () => {
    const home = await claudeHome();
    const now = Math.floor(Date.now() / 1000);
    await writeSession(home, 1, 1, 'idle', { startedAt: now * 1000 - 1 });
    const { store } = makeStore(home, { codexHome: home });
    const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    const history = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
    const id = sid(1);
    try {
      state.exec(`
        CREATE TABLE threads (
          id TEXT, cwd TEXT, title TEXT, name TEXT, preview TEXT, rollout_path TEXT, project_id TEXT,
          created_at INTEGER, updated_at INTEGER, git_branch TEXT, model TEXT, source TEXT, thread_source TEXT,
          archived INTEGER, has_user_event INTEGER
        );
        CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
        INSERT INTO project_roots VALUES ('project', 0, '/work/alpha');
      `);
      state.prepare(`
        INSERT INTO threads VALUES (?, '/codex/worktrees/xyz', 'Original', 'Renamed chat', 'Preview', '',
          'project', ?, ?, 'main', 'gpt-6', 'vscode', 'user', 0, 1)
      `).run(id, now, now);
      state.exec(`
        INSERT INTO threads
        SELECT 'helper', cwd, title, name, preview, rollout_path, project_id, created_at, updated_at,
               git_branch, model, source, 'subagent', archived, has_user_event
        FROM threads
      `);
      history.exec(`
        CREATE TABLE thread_turns (thread_id TEXT, rollout_ordinal INTEGER, status TEXT, started_at INTEGER, completed_at INTEGER);
        CREATE TABLE thread_items (thread_id TEXT, rollout_ordinal INTEGER, item_type TEXT, item_json TEXT);
      `);
      history.prepare("INSERT INTO thread_turns VALUES (?, 1, 'inProgress', ?, NULL)").run(id, now);
      const insertItem = history.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?)');
      insertItem.run(id, 2, 'userMessage', JSON.stringify({ content: [{ type: 'text', text: 'Latest prompt' }] }));

      await store.poll();
      expect(store.snapshot().layout.zones.map((z) => z.id)).toEqual(['folder:alpha']);
      expect(store.snapshot().sessions).toMatchObject([
        { id, provider: 'claude', state: 'idle' },
        { id: `codex:${id}`, provider: 'codex', hostId: id, folder: 'alpha', state: 'working', name: 'Renamed chat', lastPrompt: 'Latest prompt' },
      ]);

      insertItem.run(id, 3, 'agentMessage', JSON.stringify({ phase: 'final_answer', text: 'Final answer' }));
      insertItem.run(id, 4, 'agentMessage', JSON.stringify({ phase: 'commentary', text: 'Progress update' }));
      history.prepare("UPDATE thread_turns SET status = 'completed', completed_at = ?").run(now);
      await store.poll();
      expect(store.snapshot().sessions[1]).toMatchObject({ state: 'needs_you', need: 'reply', lastAnswer: 'Final answer' });

      store.markSeen([`codex:${id}`]);
      expect(store.snapshot().sessions[1]).toMatchObject({ state: 'idle', need: null });

      state.exec('UPDATE threads SET archived = 1');
      await store.poll();
      expect(store.snapshot().sessions.map((s) => s.id)).toEqual([id]);
    } finally {
      history.close();
      state.close();
    }
  });

  it('emits one change when a status file goes from busy to waiting', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy');
    const { store, changes } = makeStore(home);
    await store.poll();
    changes.mockClear();
    await writeSession(home, 1, 1, 'waiting', { waitingFor: 'permission prompt', statusUpdatedAt: 1790000009999 });
    await store.poll();
    await store.poll();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(store.snapshot().sessions[0]).toMatchObject({ state: 'needs_you', need: 'permission', stateSince: 1790000009999 });
  });

  it('emits nothing when only generatedAt would differ', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy');
    const { store, changes } = makeStore(home);
    await store.poll();
    changes.mockClear();
    await store.poll();
    await store.poll();
    expect(changes).not.toHaveBeenCalled();
  });

  it('keeps the previous view of a torn file for up to 3 polls', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy');
    const { store } = makeStore(home);
    await store.poll();
    const before = store.snapshot().sessions;
    await fs.writeFile(path.join(home, 'sessions', '1.json'), '{"pid":1,"sessionId":"aaaa');
    for (let i = 0; i < 3; i++) {
      await store.poll();
      expect(store.snapshot().sessions).toEqual(before);
    }
    await store.poll();
    expect(store.snapshot().sessions).toEqual([]);
  });

  it('drops a session whose file is deleted', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy');
    await writeSession(home, 2, 2, 'busy');
    const { store, changes } = makeStore(home);
    await store.poll();
    changes.mockClear();
    await fs.rm(path.join(home, 'sessions', '2.json'));
    await store.poll();
    expect(store.snapshot().sessions.map((s) => s.id)).toEqual([sid(1)]);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('drops a session whose process is gone', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy', { pid: 2 ** 22 + 12345 });
    const { store } = makeStore(home);
    await store.poll();
    expect(store.snapshot().sessions).toEqual([]);
  });

  it('marks busy then idle as needing a reply and clears it on markSeen, persisting each time', async () => {
    const home = await claudeHome();
    await writeSession(home, 3, 3, 'busy');
    const onPersist = vi.fn();
    const { store, changes } = makeStore(home, { onPersist });
    await store.poll();
    await writeSession(home, 3, 3, 'idle', { statusUpdatedAt: 1790000099999 });
    await store.poll();
    expect(store.snapshot().sessions[0]).toMatchObject({ state: 'needs_you', need: 'reply' });
    expect(onPersist).toHaveBeenLastCalledWith(expect.anything(), { [sid(3)]: expect.any(Number) }, {});
    changes.mockClear();
    store.markSeen('all');
    expect(store.snapshot().sessions[0]).toMatchObject({ state: 'idle', need: null });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(onPersist).toHaveBeenLastCalledWith(expect.anything(), {}, {});
  });

  it('creates folder zones by itself and applies layout ops', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy');
    const onPersist = vi.fn();
    const { store, changes } = makeStore(home, { onPersist });
    await store.poll();
    expect(onPersist).toHaveBeenCalledTimes(1);
    expect(onPersist.mock.calls[0]?.[0].zones.map((z: { id: string }) => z.id)).toEqual(['folder:alpha']);
    changes.mockClear();
    store.applyLayout({ type: 'moveZone', id: 'folder:alpha', x: 10, y: 20 });
    expect(store.snapshot().layout.zones[0]).toMatchObject({ x: 10, y: 20 });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(onPersist).toHaveBeenCalledTimes(2);
    store.applyLayout({ type: 'moveZone', id: 'nope', x: 1, y: 1 });
    expect(onPersist).toHaveBeenCalledTimes(2);
  });

  it('re-reads a tail only when the transcript or the status changed', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy');
    const { store } = makeStore(home);
    const open = vi.spyOn(fs, 'open');
    const transcript = path.join(home, 'projects', '-work-alpha', `${sid(1)}.jsonl`);
    const tailReads = () => open.mock.calls.filter((c) => String(c[0]) === transcript).length;
    await store.poll();
    await store.poll();
    expect(tailReads()).toBe(1);
    await fs.appendFile(transcript, '\n');
    const later = new Date(Date.now() + 5000);
    await fs.utimes(transcript, later, later);
    await store.poll();
    expect(tailReads()).toBe(2);
    open.mockRestore();
  });

  it('polls on a timer once started and on file changes', async () => {
    const home = await claudeHome();
    const store = new Store({ claudeHome: home, layout: emptyLayout(), replies: new ReplyTracker(), pollMs: 60_000, recentLimit: 0 });
    stores.push(store);
    const changed = new Promise<void>((resolve) => store.onChange(() => resolve()));
    store.start();
    await new Promise((r) => setTimeout(r, 100));
    await writeSession(home, 1, 1, 'busy');
    await changed;
    expect(store.snapshot().sessions).toHaveLength(1);
  });

  it('shows the live file when a dead file shares its sessionId, even a more recent one', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy', { name: 'Live one', statusUpdatedAt: 1790000000001 });
    await writeSession(home, 2, 1, 'idle', { name: 'Dead one', pid: 2 ** 22 + 12345, statusUpdatedAt: 1790000099999 });
    const { store } = makeStore(home);
    await store.poll();
    expect(store.snapshot().sessions.map((s) => [s.id, s.name, s.state])).toEqual([[sid(1), 'Live one', 'working']]);
  });

  it('probes process start times with one call per poll for all sessions', async () => {
    const home = await claudeHome();
    const started = (await defaultProbe.startTimes([process.pid])).get(process.pid)!;
    for (const n of [1, 2, 3]) await writeSession(home, n, n, 'busy', { procStart: started });
    const probe: Probe = { pidAlive: defaultProbe.pidAlive, startTimes: vi.fn(defaultProbe.startTimes) };
    const { store } = makeStore(home, { probe });
    await store.poll();
    await store.poll();
    expect(store.snapshot().sessions).toHaveLength(3);
    expect(probe.startTimes).toHaveBeenCalledTimes(2);
    expect(probe.startTimes).toHaveBeenNthCalledWith(1, [process.pid]);
  });

  it('never starts two polls less than 250 ms apart, however often it is asked', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy');
    const { store } = makeStore(home, { minGapMs: 250 });
    const sessionsDir = path.join(home, 'sessions');
    const starts: number[] = [];
    const readdir = fs.readdir.bind(fs);
    vi.spyOn(fs, 'readdir').mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === sessionsDir) starts.push(performance.now());
      return readdir(...args);
    }) as typeof fs.readdir);
    await store.poll();
    // A burst of change events, as fs.watch gives when the app rewrites a file.
    const burst = Array.from({ length: 5 }, () => store.poll());
    await new Promise((r) => setTimeout(r, 20));
    burst.push(store.poll(), store.poll());
    await Promise.all(burst);
    await store.poll();
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(249);
  });

  it('stop resolves only once a poll in flight has finished, and no follow-up poll runs', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy');
    const { store } = makeStore(home);
    const sessionsDir = path.join(home, 'sessions');
    const readdir = vi.spyOn(fs, 'readdir');
    const listings = () => readdir.mock.calls.filter((c) => String(c[0]) === sessionsDir).length;
    let finished = false;
    void store.poll().then(() => { finished = true; });
    void store.poll(); // asks for a follow-up poll; stop cancels it
    await store.stop();
    expect(finished).toBe(true);
    expect(listings()).toBe(1);
    readdir.mockRestore();
    await expect(store.stop()).resolves.toBeUndefined();
  });
});

/** fs functions that can write, rename, delete or change the mode or owner of something. */
const MUTATING_SYNC = [
  'appendFile', 'appendFileSync', 'chmod', 'chmodSync', 'chown', 'chownSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'createWriteStream', 'fchmod', 'fchmodSync', 'fchown', 'fchownSync', 'ftruncate', 'ftruncateSync', 'futimes', 'futimesSync',
  'lchmod', 'lchmodSync', 'lchown', 'lchownSync', 'link', 'linkSync', 'lutimes', 'lutimesSync', 'mkdir', 'mkdirSync',
  'mkdtemp', 'mkdtempSync', 'rename', 'renameSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'symlink', 'symlinkSync',
  'truncate', 'truncateSync', 'unlink', 'unlinkSync', 'utimes', 'utimesSync', 'write', 'writeSync', 'writeFile',
  'writeFileSync', 'writev', 'writevSync',
] as const;
const MUTATING_PROMISES = [
  'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lchmod', 'lchown', 'link', 'lutimes', 'mkdir', 'mkdtemp',
  'rename', 'rm', 'rmdir', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile',
] as const;
const OPENING_SYNC = ['open', 'openSync'] as const;
const READING_SYNC = [
  'access', 'accessSync', 'createReadStream', 'existsSync', 'lstat', 'lstatSync', 'opendir', 'opendirSync', 'readFile',
  'readFileSync', 'readdir', 'readdirSync', 'readlink', 'readlinkSync', 'realpath', 'realpathSync', 'stat', 'statSync',
  'watch', 'watchFile',
] as const;
const READING_PROMISES = ['access', 'lstat', 'open', 'opendir', 'readFile', 'readdir', 'readlink', 'realpath', 'stat', 'watch'] as const;
/** FileHandle methods that change a file; a handle opened read-only can still change its mode. */
const MUTATING_HANDLE = ['appendFile', 'chmod', 'chown', 'truncate', 'utimes', 'write', 'writeFile', 'writev'] as const;

const asPath = (v: unknown): string | null =>
  typeof v === 'string' ? v : v instanceof URL ? v.pathname : Buffer.isBuffer(v) ? v.toString() : null;
/** Functions whose second argument is a path too; for every other one only the first is. */
const TWO_PATHS = new Set(['rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync', 'symlink', 'symlinkSync']);
const pathsOf = (name: string, args: unknown[]): string[] =>
  args.slice(0, TWO_PATHS.has(name.slice(name.lastIndexOf('.') + 1)) ? 2 : 1).map(asPath).filter((p): p is string => p !== null);
const isReadOnlyFlag = (flags: unknown): boolean =>
  flags === undefined || flags === 'r' || flags === 'rs' || flags === 'sr' || flags === fsSync.constants.O_RDONLY;

/** A Codex home with one state and one history database, holding these threads. */
function codexHome(home: string, threads: { id: string; status: string }[]): void {
  const now = Math.floor(Date.now() / 1000);
  const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  const history = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  try {
    state.exec(`CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, preview TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,
      git_branch TEXT, source TEXT, archived INTEGER, has_user_event INTEGER)`);
    history.exec('CREATE TABLE thread_turns (thread_id TEXT, rollout_ordinal INTEGER, status TEXT, started_at INTEGER, completed_at INTEGER)');
    history.exec('CREATE TABLE thread_items (thread_id TEXT, rollout_ordinal INTEGER, item_type TEXT, item_json TEXT)');
    for (const t of threads) {
      state.prepare("INSERT INTO threads VALUES (?, '/work/gamma', ?, 'Preview', '', ?, ?, 'main', 'cli', 0, 1)").run(t.id, t.id, now, now);
      history.prepare('INSERT INTO thread_turns VALUES (?, 1, ?, ?, ?)').run(t.id, t.status, now, t.status === 'inProgress' ? null : now);
    }
  } finally {
    history.close();
    state.close();
  }
}

const SIGNED_OUT = 'Claude Code is signed out on this Mac. Run claude, then /login.';

/** An engine stand-in: only what the store asks of one. */
function fakeEngine(
  provider: 'claude' | 'codex', owned: string[], releasing: string[] = [], banner: string | null = null,
  busy: { sessionId: string; reason: 'turn' | 'approval' | 'question' }[] = [],
) {
  const lost = vi.fn();
  const engine = { provider, banner, owned: () => new Set(owned), releasing: () => new Set(releasing), lost, busy: () => busy } as unknown as Engine;
  return { engine, lost };
}

async function writeTranscript(home: string, n: number, cwd: string, text: string, mtimeS: number): Promise<void> {
  const file = path.join(home, 'projects', '-work-recent', `${sid(n)}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // A finished turn: a prompt and its answer (a prompt alone, with no process, is a cut-off turn).
  await fs.writeFile(file, JSON.stringify({ type: 'user', cwd, gitBranch: 'main', timestamp: '2026-11-01T09:00:00.000Z', message: { role: 'user', content: text } }) + '\n'
    + JSON.stringify({ type: 'assistant', timestamp: '2026-11-01T09:00:05.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } }) + '\n');
  await fs.utimes(file, mtimeS, mtimeS);
}

describe('Store: recent sessions and owners', () => {
  it('rechecks a saved Codex usage limit and unlocks only failures older than the confirmed availability', async () => {
    const home = await claudeHome();
    codexHome(home, [{ id: 'limited', status: 'failed' }, { id: 'overloaded', status: 'failed' }]);
    const history = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
    const at = Math.floor(Date.now() / 1000);
    history.exec('ALTER TABLE thread_turns ADD COLUMN error_json TEXT');
    const fail = history.prepare('UPDATE thread_turns SET completed_at = ?, error_json = ? WHERE thread_id = ?');
    fail.run(at, JSON.stringify({ message: "You've hit your usage limit. Try again at 4:00 PM.", codexErrorInfo: 'usageLimitExceeded' }), 'limited');
    fail.run(at, JSON.stringify({ message: 'Overloaded', codexErrorInfo: 'serverOverloaded' }), 'overloaded');
    history.close();

    const engine = { ...fakeEngine('codex', []).engine, usageAllowedAt: at * 1000 - 1, account: vi.fn() };
    const { store } = makeStore(home, { codexHome: home, engines: { codex: engine } });
    const card = (id: string) => store.snapshot().sessions.find(s => s.id === 'codex:' + id)!;
    await store.poll();
    expect(engine.account).toHaveBeenCalledTimes(1);
    expect(card('limited').interruption?.codexUsage).toBe('blocked');
    engine.usageAllowedAt = (at + 1) * 1000;
    await store.refreshCodexLimit();
    expect(card('limited')).toMatchObject({ need: 'interrupted', interruption: { codexUsage: 'available', resetsAt: null } });
    expect(card('overloaded').interruption?.codexUsage).toBeUndefined();
    await store.poll();
    await store.refreshCodexLimit();
    expect(engine.account).toHaveBeenCalledTimes(2);
    expect(card('limited').interruption?.codexUsage).toBe('available');
  });

  it('live and recent Claude sessions merge without duplicates', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy');
    await writeTranscript(home, 1, '/work/alpha', 'Also a recent transcript', 1_790_000_010);
    await writeTranscript(home, 20, '/work/delta', 'An older idle session', 1_790_000_005);
    const { store } = makeStore(home, { recentLimit: 40 });
    await store.poll();
    const sessions = store.snapshot().sessions;
    expect(sessions.filter((s) => s.id === sid(1))).toEqual([expect.objectContaining({ state: 'working', name: 'Session 1' })]);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(sessions.length);
    expect(sessions.find((s) => s.id === sid(20))).toMatchObject({
      provider: 'claude', name: 'An older idle session', cwd: '/work/delta', folder: 'delta', state: 'idle', need: null,
      branch: 'main', owner: 'nobody', stateSince: 1_790_000_005_000,
    });
    expect(store.snapshot().layout.zones.map((z) => z.id)).toContain('folder:delta');
    // Only the fixture transcripts and these two: the 40 most recent, never more.
    expect(sessions.filter((s) => s.provider === 'claude').length).toBeLessThanOrEqual(41);
  });

  it('owner field on every SessionView', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy');
    await writeSession(home, 2, 2, 'busy', { pid: 777001 });
    await writeTranscript(home, 20, '/work/delta', 'An older idle session', 1_790_000_005);
    codexHome(home, [{ id: 'th-here', status: 'completed' }, { id: 'th-other', status: 'inProgress' }, { id: 'th-free', status: 'completed' }, { id: 'th-gone', status: 'completed' }]);
    const claude = fakeEngine('claude', []);
    const codex = fakeEngine('codex', ['th-here', 'th-gone'], ['th-gone']);
    const probe: Probe = { pidAlive: () => true, startTimes: async () => new Map() };
    const { store } = makeStore(home, {
      codexHome: home, recentLimit: 40, probe, engines: { claude: claude.engine, codex: codex.engine },
      appPid: 777000, parents: async () => new Map([[777001, 777000], [process.pid, 1]]),
    });
    await store.poll();
    const sessions = store.snapshot().sessions;
    for (const s of sessions) expect(['here', 'elsewhere', 'nobody']).toContain(s.owner);
    const owners = Object.fromEntries(sessions.map((s) => [s.id, [s.owner, s.ownerNote]]));
    expect(owners[sid(1)]).toEqual(['elsewhere', null]);
    expect(owners[sid(2)]).toEqual(['here', null]);
    expect(owners[sid(20)]).toEqual(['nobody', null]);
    expect(owners['codex:th-here']).toEqual(['here', null]);
    expect(owners['codex:th-other']).toEqual(['elsewhere', null]);
    expect(owners['codex:th-free']).toEqual(['nobody', null]);
    // Let go here, still held by this app's Codex server until it unloads the thread.
    expect(owners['codex:th-gone']).toEqual(['here', 'Released in about a minute']);
    expect(store.owner(sid(1))).toBe('elsewhere');
    expect(store.owner('no-such-session')).toBeNull();
    // Each engine hears of its sessions that turned up elsewhere (Codex by its bare thread id), once.
    expect(claude.lost.mock.calls).toEqual([[sid(1)]]);
    expect(codex.lost.mock.calls).toEqual([['th-other']]);
    await store.poll();
    expect(claude.lost).toHaveBeenCalledTimes(1);
    expect(codex.lost).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['rejects', async (): Promise<Map<number, number>> => { throw new Error('ps timed out'); }],
    ['returns nothing', async () => new Map<number, number>()],
  ])("when the parent lookup %s, a session this app runs stays here and is never closed", async (_what, broken) => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy', { pid: 777001 });
    const claude = fakeEngine('claude', [sid(1)]);
    let parents: (pids: number[]) => Promise<Map<number, number>> = async () => new Map([[777001, 777000]]);
    const probe: Probe = { pidAlive: () => true, startTimes: async () => new Map() };
    const { store } = makeStore(home, { probe, engines: { claude: claude.engine }, appPid: 777000, parents: (pids) => parents(pids) });
    await store.poll();
    expect(store.owner(sid(1))).toBe('here');
    parents = broken;
    await store.poll();
    await store.poll();
    expect(store.owner(sid(1))).toBe('here');
    expect(claude.lost).not.toHaveBeenCalled();
  });

  it('an approval or question waiting in this app makes its card "Needs you" (Codex by its bare thread id)', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy');
    await writeSession(home, 2, 2, 'busy');
    await writeSession(home, 3, 3, 'busy');
    codexHome(home, [{ id: 'th-ask', status: 'inProgress' }, { id: 'th-run', status: 'inProgress' }]);
    const claude = fakeEngine('claude', [sid(1), sid(2), sid(3)], [], null,
      [{ sessionId: sid(1), reason: 'approval' }, { sessionId: sid(2), reason: 'question' }, { sessionId: sid(3), reason: 'turn' }]);
    const codex = fakeEngine('codex', ['th-ask', 'th-run'], [], null, [{ sessionId: 'th-ask', reason: 'approval' }, { sessionId: 'th-run', reason: 'turn' }]);
    const { store } = makeStore(home, { codexHome: home, engines: { claude: claude.engine, codex: codex.engine } });
    await store.poll();
    const card = (id: string) => store.snapshot().sessions.find((s) => s.id === id);
    expect(card(sid(1))).toMatchObject({ state: 'needs_you', need: 'permission', activity: 'Wants permission' });
    expect(card(sid(2))).toMatchObject({ state: 'needs_you', need: 'question', activity: 'Has a question' });
    expect(card(sid(3))).toMatchObject({ state: 'working', need: null });
    expect(card('codex:th-ask')).toMatchObject({ state: 'needs_you', need: 'permission', activity: 'Wants permission' });
    expect(card('codex:th-run')).toMatchObject({ state: 'working', need: null });
  });

  describe('a CLI session waiting on a dialog in its own terminal', () => {
    // claude (777001) under -zsh under login under Terminal, as `ps` lists them.
    const procs = async () => new Map([
      [777001, { ppid: 777002, tty: 'ttys006', comm: '/Users/demo/.local/bin/claude' }],
      [777002, { ppid: 777003, tty: 'ttys006', comm: '-zsh' }],
      [777003, { ppid: 777004, tty: 'ttys006', comm: 'login' }],
      [777004, { ppid: 1, tty: null, comm: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' }],
      [process.pid, { ppid: 777000, tty: null, comm: 'node' }],
    ]);
    const probe: Probe = { pidAlive: () => true, startTimes: async () => new Map() };
    const dialog = { pid: 777001, entrypoint: 'cli', kind: 'interactive', waitingFor: 'dialog open' };

    it('with an empty transcript: needs you in terminal, owned elsewhere, in Terminal on its tty', async () => {
      const home = await claudeHome();
      await writeSession(home, 777001, 50, 'waiting', dialog);
      await writeSession(home, 2, 2, 'busy');
      const { store } = makeStore(home, { probe, engines: { claude: fakeEngine('claude', [sid(2)]).engine }, appPid: 777000, processes: procs });
      await store.poll();
      const card = store.snapshot().sessions.find((s) => s.id === sid(50));
      expect(card).toMatchObject({
        owner: 'elsewhere', state: 'needs_you', need: 'terminal', activity: 'Waiting on a prompt in its terminal',
        host: { app: 'Terminal', tty: 'ttys006', showable: true },
      });
      // A session this app runs has no host.
      expect(store.snapshot().sessions.find((s) => s.id === sid(2))).toMatchObject({ owner: 'here', host: null });
      expect(store.hostPid(sid(50))).toBe(777001);
      expect(store.hostPid(sid(2))).toBeNull();
      expect(store.hostPid('no-such-session')).toBeNull();
    });

    it('a real pending permission still wins', async () => {
      const home = await claudeHome();
      await writeSession(home, 777001, 50, 'waiting', dialog);
      const claude = fakeEngine('claude', [], [], null, [{ sessionId: sid(50), reason: 'approval' }]);
      const { store } = makeStore(home, { probe, engines: { claude: claude.engine }, appPid: 777000, processes: procs });
      await store.poll();
      expect(store.snapshot().sessions.find((s) => s.id === sid(50))).toMatchObject({ state: 'needs_you', need: 'permission', activity: 'Wants permission' });
    });

    it('when ps cannot be read the card still says terminal, with no host', async () => {
      const home = await claudeHome();
      await writeSession(home, 777001, 50, 'waiting', dialog);
      const { store } = makeStore(home, { probe, appPid: 777000, processes: async () => { throw new Error('ps timed out'); } });
      await store.poll();
      expect(store.snapshot().sessions.find((s) => s.id === sid(50))).toMatchObject({ owner: 'elsewhere', need: 'terminal', host: null });
    });
  });

  it("each engine's banner is shown on its provider's cards", async () => {
    const home = await claudeHome();
    const { store } = makeStore(home, { engines: { claude: fakeEngine('claude', []).engine, codex: fakeEngine('codex', [], [], 'Codex not found').engine } });
    await store.poll();
    expect(store.snapshot().banners).toEqual({ claude: null, codex: { text: 'Codex not found', blocking: true } });
    expect(makeStore(home).store.snapshot().banners).toEqual({ claude: null, codex: null });
  });

  it("a request timeout is published as a warning that blocks nothing", async () => {
    const home = await claudeHome();
    const warning = "Codex didn't answer";
    const { store } = makeStore(home, { engines: { claude: fakeEngine('claude', [], [], SIGNED_OUT).engine, codex: fakeEngine('codex', [], [], warning).engine } });
    await store.poll();
    expect(store.snapshot().banners).toEqual({ claude: { text: SIGNED_OUT, blocking: true }, codex: { text: warning, blocking: false } });
  });

  it('a session an engine runs that turns up elsewhere is reported to that engine until it lets go', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy');
    const owned = new Set([sid(1)]);
    const lost = vi.fn((id: string) => { owned.delete(id); });
    const engine = { provider: 'claude', owned: () => new Set(owned), releasing: () => new Set(), lost, busy: () => [] } as unknown as Engine;
    const { store } = makeStore(home, { engines: { claude: engine }, appPid: 777000, parents: async () => new Map([[process.pid, 1]]) });
    await store.poll();
    expect(lost.mock.calls).toEqual([[sid(1)]]);
    await store.poll();
    expect(lost).toHaveBeenCalledTimes(1);
  });
});

describe('Store: the canvas agent', () => {
  const AGENT = '/data/agent-canvas/agent';

  it('a session in the agent folder is no card and gets no zone: the one started last is the snapshot\'s agent', async () => {
    const home = await claudeHome();
    await writeSession(home, 1, 1, 'busy');
    await writeSession(home, 2, 2, 'idle', { cwd: AGENT, startedAt: 1795000000100 });
    await writeSession(home, 3, 3, 'busy', { cwd: AGENT, startedAt: 1795000000200 });
    // An older conversation with the agent (1 November 2026), known from its transcript alone.
    await writeTranscript(home, 20, AGENT, 'What is going on?', 1_790_000_005);
    await writeTranscript(home, 21, '/work/delta', 'An idle session', 1_790_000_006);
    const { store } = makeStore(home, { agentCwd: AGENT, recentLimit: 40 });
    await store.poll();
    const snap = store.snapshot();
    expect(snap.sessions.map((s) => s.id)).toEqual(expect.arrayContaining([sid(1), sid(21)]));
    expect(snap.sessions.some((s) => s.cwd === AGENT)).toBe(false);
    expect(snap.agent).toMatchObject({ id: sid(3), provider: 'claude', cwd: AGENT, state: 'working' });
    expect(snap.layout.zones.map((z) => z.id)).toEqual(expect.arrayContaining(['folder:alpha', 'folder:delta']));
    expect(snap.layout.zones.map((z) => z.id)).not.toContain('folder:agent');
    // Its owner is still known by id, for the engine and the chat.
    expect(store.owner(sid(3))).toBe('elsewhere');
  });

  it('with no live conversation the newest transcript in the agent folder is the agent; with none it is null', async () => {
    const home = await claudeHome();
    const { store } = makeStore(home, { agentCwd: AGENT, recentLimit: 40 });
    await store.poll();
    expect(store.snapshot().agent).toBeNull();
    await writeTranscript(home, 20, AGENT, 'What is going on?', 1_790_000_005);
    await store.poll();
    expect(store.snapshot().agent).toMatchObject({ id: sid(20), state: 'idle', owner: 'nobody' });
    expect(store.snapshot().sessions.some((s) => s.id === sid(20))).toBe(false);
  });

  it('a store with no agent folder treats every session as a card and has no agent field', async () => {
    const home = await claudeHome();
    await writeSession(home, 2, 2, 'idle', { cwd: AGENT });
    const { store } = makeStore(home);
    await store.poll();
    expect(store.snapshot().sessions.map((s) => s.id)).toEqual([sid(2)]);
    expect('agent' in store.snapshot()).toBe(false);
  });

  it('an approval waiting in the agent shows on it, and a change of the agent alone is a change', async () => {
    const home = await claudeHome();
    await writeSession(home, 2, 2, 'busy', { cwd: AGENT });
    const busy: { sessionId: string; reason: 'turn' | 'approval' | 'question' }[] = [];
    const claude = fakeEngine('claude', [sid(2)], [], null, busy);
    const { store, changes } = makeStore(home, { agentCwd: AGENT, engines: { claude: claude.engine } });
    await store.poll();
    expect(store.snapshot().agent).toMatchObject({ id: sid(2), state: 'working', need: null });
    const before = changes.mock.calls.length;
    busy.push({ sessionId: sid(2), reason: 'approval' });
    await store.poll();
    expect(store.snapshot().agent).toMatchObject({ state: 'needs_you', need: 'permission', activity: 'Wants permission' });
    expect(changes.mock.calls.length).toBe(before + 1);
  });

  it('a conversation just started is the agent at once, before its files are seen, and stays it over a newer-looking one', async () => {
    const home = await claudeHome();
    await writeSession(home, 3, 3, 'idle', { cwd: AGENT, startedAt: 1790000000200 });
    const owned: string[] = [sid(9)];
    const claude = { provider: 'claude', banner: null, owned: () => new Set(owned), releasing: () => new Set(), lost: vi.fn(), busy: () => [] } as unknown as Engine;
    const { store, changes } = makeStore(home, { agentCwd: AGENT, engines: { claude } });
    await store.poll();
    expect(store.snapshot().agent?.id).toBe(sid(3));
    const before = changes.mock.calls.length;
    store.agentStarted({ cwd: AGENT, provider: 'claude', id: sid(9), text: 'What is going on?', at: 1790000000150 });
    expect(changes.mock.calls.length).toBe(before + 1);
    expect(store.snapshot().agent).toMatchObject({ id: sid(9), cwd: AGENT, state: 'working', owner: 'here', lastPrompt: 'What is going on?' });
    expect(store.snapshot().sessions.some((s) => s.id === sid(9))).toBe(false);
    // The poll finds the real session: its own view replaces the stand-in, under the same id.
    await writeSession(home, 9, 9, 'busy', { cwd: AGENT, startedAt: 1790000000150, name: 'Agent chat' });
    await store.poll();
    expect(store.snapshot().agent).toMatchObject({ id: sid(9), name: 'Agent chat' });
    // A start the engine does not run (it ended before any session file): no stand-in, and the
    // newest conversation known is the agent again.
    store.agentStarted({ cwd: AGENT, provider: 'claude', id: sid(10), text: 'Again', at: 1790000000300 });
    expect(store.snapshot().agent?.id).toBe(sid(3));
    owned.push(sid(10));
    await store.poll();
    expect(store.snapshot().agent?.id).toBe(sid(10));
    owned.pop();
    await store.poll();
    expect(store.snapshot().agent?.id).toBe(sid(3));
  });
});

describe('Store read-only promise', () => {
  it('never writes, renames, deletes or changes the mode of anything under CLAUDE_HOME, and never touches a .key file', async () => {
    const home = await claudeHome();
    await fs.cp(path.resolve(import.meta.dirname, '../fixtures/sessions'), path.join(home, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(home, 'sessions', `${process.pid}.feedfacecafebeef.key`), 'invented key');
    await writeSession(home, process.pid, 1, 'busy', { name: 'Busy with subagents' });
    await writeSession(home, 3, 3, 'busy', { cwd: '/work/beta' });
    // A FileHandle prototype, so its methods can be watched too.
    const probeHandle = await fs.open(path.join(home, 'projects', '-work-alpha', `${sid(1)}.jsonl`), 'r');
    const handleProto = Object.getPrototypeOf(probeHandle) as Record<string, unknown>;
    await probeHandle.close();
    const keyFiles = (await fs.readdir(path.join(home, 'sessions'))).filter((n) => n.endsWith('.key'));
    expect(keyFiles).toHaveLength(2);

    const spies: { name: string; spy: MockInstance; kind: 'mutate' | 'open' | 'read' }[] = [];
    const watchAll = (target: object, names: readonly string[], kind: 'mutate' | 'open' | 'read', prefix: string) => {
      for (const name of names) {
        if (typeof (target as Record<string, unknown>)[name] !== 'function') continue;
        spies.push({ name: `${prefix}${name}`, kind, spy: vi.spyOn(target as Record<string, (...a: unknown[]) => unknown>, name) });
      }
    };
    const store = new Store({ claudeHome: home, layout: emptyLayout(), replies: new ReplyTracker(), pollMs: 60_000, minGapMs: 0 });
    stores.push(store);
    try {
      watchAll(fsSync, MUTATING_SYNC, 'mutate', 'fs.');
      watchAll(fsSync, OPENING_SYNC, 'open', 'fs.');
      watchAll(fsSync, READING_SYNC, 'read', 'fs.');
      watchAll(fs, MUTATING_PROMISES, 'mutate', 'fs/promises.');
      watchAll(fs, READING_PROMISES, 'read', 'fs/promises.');
      watchAll(handleProto, MUTATING_HANDLE, 'mutate', 'FileHandle.');
      syncBuiltinESMExports(); // named imports of node:fs follow the spied functions

      store.start(); // the timer and fs.watch, as in real use
      await store.poll();
      await writeSession(home, 3, 3, 'idle', { cwd: '/work/beta', statusUpdatedAt: 1790000099999 }).catch(() => {});
      await store.poll();
      await store.poll();
      expect(store.snapshot().sessions.length).toBeGreaterThanOrEqual(2);
      store.applyLayout({ type: 'createZone', name: 'Later' });
      store.applyLayout({ type: 'moveZone', id: 'folder:alpha', x: 10, y: 20 });
      store.markSeen('all');
      await store.poll();
      await store.stop();
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }

    const inHome = (p: string) => path.resolve(p) === home || path.resolve(p).startsWith(home + path.sep);
    const offences: string[] = [];
    let reads = 0;
    for (const { name, spy, kind } of spies) {
      for (const [i, args] of spy.mock.calls.entries()) {
        const paths = pathsOf(name, args);
        if (paths.some((p) => p.endsWith('.key'))) offences.push(`${name} touched ${paths.join(', ')}`);
        if (kind === 'read' && paths.some(inHome)) reads++;
        const writes = kind === 'mutate' || (kind === 'open' && !isReadOnlyFlag(args[1]))
          || (name === 'fs/promises.open' && !isReadOnlyFlag(args[1]));
        if (name.startsWith('FileHandle.')) offences.push(`${name} called on a handle (this: ${String(spy.mock.contexts[i])})`);
        else if (writes && paths.some(inHome)) offences.push(`${name} wrote ${paths.join(', ')}`);
      }
    }
    // The test's own writeSession call above ran with the spies on; it is the only allowed write.
    const own = path.join(home, 'sessions', '3.json');
    expect(offences.filter((o) => o !== `fs/promises.writeFile wrote ${own}`)).toEqual([]);
    // The spies saw the store at work: session files, transcripts and subagents were read.
    expect(reads).toBeGreaterThan(10);
  });
});

describe('Store: ACP agents', () => {
  const acpView = (state: 'working' | 'idle', rawStatus: string) => ({
    id: 'acp:one', provider: 'acp' as const, hostId: null, name: 'Gemini task', cwd: '/work/gemini', folder: 'gemini', state, need: null,
    activity: null, rawStatus, stateSince: 1_790_000_000_000, startedAt: 1_790_000_000_000, branch: null, model: null, lastPrompt: 'Go',
    lastAnswer: null, subagents: [], owner: 'here' as const, ownerNote: null, host: null, acp: { id: 'gemini', name: 'Gemini CLI', icon: 'agent' as const },
  });

  it("joins the engine's cards: a folder zone, an approval as needs-you, a finished turn as needs-reply, a cut-off one as interrupted", async () => {
    let view = acpView('working', 'busy');
    let busy: { sessionId: string; reason: 'turn' | 'approval' | 'question' }[] = [{ sessionId: 'one', reason: 'approval' }];
    const interruptions = new Map<string, { kind: 'limit' | 'error' | 'killed'; reason: string; at: number; resetsAt: null }>();
    const acp = { provider: 'acp', banner: null, interruptions, views: () => [view], owned: () => new Set(['one']), releasing: () => new Set(), lost: vi.fn(), busy: () => busy };
    const { store } = makeStore(await claudeHome(), { engines: { acp: acp as never } });
    await store.poll();
    expect(store.snapshot().sessions).toMatchObject([{ id: 'acp:one', state: 'needs_you', need: 'permission', acp: { name: 'Gemini CLI' } }]);
    expect(store.snapshot().layout.zones.map((z) => z.id)).toContain('folder:gemini');

    busy = [];
    view = acpView('idle', 'idle');
    store.engineChanged();
    expect(store.snapshot().sessions[0]).toMatchObject({ state: 'needs_you', need: 'reply', activity: 'Finished' });
    store.markSeen(['acp:one']);
    expect(store.snapshot().sessions[0]).toMatchObject({ state: 'idle' });

    interruptions.set('one', { kind: 'limit', reason: 'Usage limit reached', at: 1_790_000_000_500, resetsAt: null });
    store.engineChanged();
    expect(store.snapshot().sessions[0]).toMatchObject({ state: 'needs_you', need: 'interrupted', activity: 'Usage limit reached' });
  });
});
