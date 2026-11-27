import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Layout, LayoutOp, SessionView, Snapshot } from '../../shared/types.ts';
import { applyLayoutOp, ensureFolderZones } from '../layoutOps.ts';
import { AttachmentStore } from './taskAttachments.ts';
import { ago, ASKING_TOOLS, CANVAS_TOOLS, SAFE_TOOL_IDS, zonePath, type CanvasApi, type TaskRequest } from './tools.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function session(id: string, cwd: string, patch: Partial<SessionView> = {}): SessionView {
  return {
    id, provider: 'claude', hostId: null, name: `Session ${id}`, cwd, folder: cwd.split('/').at(-1) ?? '', state: 'idle', need: null, activity: null,
    rawStatus: 'idle', stateSince: NOW - 5 * MIN, startedAt: NOW - 60 * MIN, branch: 'main', model: 'claude-demo', lastPrompt: null, lastAnswer: null,
    subagents: [], owner: 'nobody', ownerNote: null, host: null, ...patch,
  };
}

/** A CanvasApi in memory: a layout the real ops change, and what was asked of it. */
function fakeApi(opts: { sessions?: SessionView[]; layout?: Layout; folders?: Record<string, 'dir' | 'file'>; startFails?: string; openFails?: string; agent?: SessionView; store?: AttachmentStore; acp?: { id: string; name: string; installed: boolean }[] } = {}) {
  const sessions = opts.sessions ?? [];
  let layout = opts.layout ?? ensureFolderZones({ version: 1, zones: [], assignments: {} }, [...new Set(sessions.map((s) => s.folder))]);
  const ops: LayoutOp[] = [];
  const started: TaskRequest[] = [];
  const searches: [string, number][] = [];
  const opened: string[] = [];
  const api: CanvasApi = {
    snapshot: (): Snapshot => ({ generatedAt: NOW, demo: false, sessions, layout, banners: { claude: null, codex: null }, ...(opts.agent ? { agent: opts.agent } : {}) }),
    applyLayout: (op) => { ops.push(op); layout = applyLayoutOp(layout, op); },
    startSession: async (req) => {
      if (opts.startFails) throw new Error(opts.startFails);
      started.push(req);
      return `new-${started.length}`;
    },
    findFolders: async (query, limit) => {
      searches.push([query, limit]);
      return query === 'nothing' ? [] : [{ path: '/Users/me/Documents/garden-sim', git: true }, { path: '/Users/me/Desktop/garden-sim-notes', git: false }];
    },
    folderKind: async (p) => opts.folders?.[p] ?? 'missing',
    openSession: (id) => {
      if (opts.openFails) throw new Error(opts.openFails);
      opened.push(id);
    },
    keepAttachments: (paths) => (opts.store ?? new AttachmentStore('/nonexistent/attachments')).keep(paths),
    ...(opts.acp ? { acpAgents: async () => opts.acp! } : {}),
    now: () => NOW,
  };
  return { api, ops, started, searches, opened, layout: () => layout };
}

const call = (api: CanvasApi, name: string, args: Record<string, unknown> = {}) => {
  const tool = CANVAS_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.handler(api, args);
};

describe('the canvas tools: which ask', () => {
  it('reads and reversible layout changes run without asking; delete_zone and start_task ask', () => {
    expect(SAFE_TOOL_IDS).toEqual([
      'mcp__canvas__canvas_overview', 'mcp__canvas__read_session', 'mcp__canvas__find_folders', 'mcp__canvas__create_zone',
      'mcp__canvas__add_folder_zone', 'mcp__canvas__rename_zone', 'mcp__canvas__hide_zone', 'mcp__canvas__show_zone', 'mcp__canvas__move_session',
      'mcp__canvas__open_session', 'mcp__canvas__add_image', 'mcp__canvas__get_usage_summary',
      'mcp__canvas__unlink_sessions', 'mcp__canvas__set_max_running', 'mcp__canvas__list_open_threads',
      'mcp__canvas__list_notes', 'mcp__canvas__create_note', 'mcp__canvas__update_note',
    ]);
    expect(ASKING_TOOLS).toEqual(['delete_zone', 'start_task', 'remove_image', 'link_sessions', 'dismiss_open_thread', 'delete_note']);
    expect(CANVAS_TOOLS.filter((t) => t.readOnly).map((t) => t.name)).toEqual(['canvas_overview', 'read_session', 'find_folders', 'get_usage_summary', 'list_open_threads', 'list_notes']);
  });

  it('every tool has a description and names unique on the server', () => {
    expect(new Set(CANVAS_TOOLS.map((t) => t.name)).size).toBe(CANVAS_TOOLS.length);
    for (const t of CANVAS_TOOLS) expect(t.description.length).toBeGreaterThan(10);
  });
});

describe('canvas_overview', () => {
  it('lists zones with their sessions, what needs the owner first, and how long each has been in its state', async () => {
    const { api } = fakeApi({ sessions: [
      session('a', '/work/alpha'),
      session('b', '/work/alpha', { state: 'needs_you', need: 'permission', activity: 'Wants to run: npm test', stateSince: NOW - 2 * MIN, owner: 'here' }),
      session('c', '/work/beta', { provider: 'codex', state: 'working', activity: 'Running tests', stateSince: NOW - 90_000, branch: null }),
    ] });
    const r = await call(api, 'canvas_overview');
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.text);
    expect(out.totals).toEqual({ sessions: 3, needs_you: 1, working: 1, idle: 1 });
    expect(out.zones.map((z: { id: string }) => z.id)).toEqual(['folder:alpha', 'folder:beta']);
    expect(out.zones[0]).toMatchObject({ name: 'alpha', kind: 'folder', path: '/work/alpha' });
    expect(out.zones[0].sessions).toEqual([
      { id: 'b', provider: 'claude', name: 'Session b', state: 'needs_you:permission', for: '2m', activity: 'Wants to run: npm test', branch: 'main', model: 'claude-demo', modelLabel: 'Claude Demo', owner: 'here' },
      { id: 'a', provider: 'claude', name: 'Session a', state: 'idle', for: '5m', branch: 'main', model: 'claude-demo', modelLabel: 'Claude Demo', owner: 'nobody' },
    ]);
    expect(out.zones[1].sessions[0]).toMatchObject({ id: 'c', provider: 'codex', state: 'working', for: '1m' });
  });

  it('shows custom zones, hidden zones, moved sessions, and folder zones that only have a path', async () => {
    const fake = fakeApi({ sessions: [session('a', '/work/alpha')] });
    await call(fake.api, 'create_zone', { name: 'Later' });
    const custom = fake.layout().zones.find((z) => z.kind === 'custom')!;
    fake.api.applyLayout({ type: 'assign', sessionId: 'a', zoneId: custom.id });
    fake.api.applyLayout({ type: 'hideZone', id: 'folder:alpha', at: NOW });
    fake.api.applyLayout({ type: 'addFolderZone', path: '/Users/me/code/gamma' });
    const out = JSON.parse((await call(fake.api, 'canvas_overview')).text);
    // The hidden alpha zone has neither session nor path now: like the canvas, the overview leaves it out.
    expect(out.zones).toEqual([
      { id: custom.id, name: 'Later', kind: 'custom', sessions: [expect.objectContaining({ id: 'a' })] },
      { id: 'folder:gamma', name: 'gamma', kind: 'folder', path: '/Users/me/code/gamma', sessions: [] },
    ]);
  });

  it("names a provider's problem", async () => {
    const { api } = fakeApi();
    const snap = api.snapshot();
    api.snapshot = () => ({ ...snap, banners: { claude: null, codex: { text: 'Codex not found', blocking: true } } });
    expect(JSON.parse((await call(api, 'canvas_overview')).text).problems).toEqual(['codex: Codex not found']);
  });
});

describe('read_session', () => {
  it('gives one session in full', async () => {
    const { api } = fakeApi({ sessions: [session('a', '/work/alpha', {
      lastPrompt: 'Fix the login', lastAnswer: 'Done: the token is refreshed.', recentSteps: [{ kind: 'edit', label: 'Edited auth.ts', status: 'done' }],
      subagents: [{ id: 's1', type: 'tester', description: 'Run tests', state: 'done' }],
    })] });
    const out = JSON.parse((await call(api, 'read_session', { id: 'a' })).text);
    expect(out).toMatchObject({
      id: 'a', zone: { id: 'folder:alpha', name: 'alpha' }, folder: '/work/alpha', state: 'idle', for: '5m', started: '1h ago',
      lastPrompt: 'Fix the login', lastAnswer: 'Done: the token is refreshed.',
      recentSteps: [{ kind: 'edit', label: 'Edited auth.ts', status: 'done' }], subagents: [{ id: 's1', type: 'tester', description: 'Run tests', state: 'done' }],
    });
  });

  it('an unknown id is a one-line error, not a throw', async () => {
    const r = await call(fakeApi().api, 'read_session', { id: 'nope' });
    expect(r).toEqual({ isError: true, text: 'No session has the id nope. canvas_overview lists the sessions.' });
  });

  it('bad arguments are an error too', async () => {
    const r = await call(fakeApi().api, 'read_session', { id: 42 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Bad arguments for read_session: id:/);
  });
});

describe('find_folders', () => {
  it('lists the paths found, marking git repositories, with the default limit', async () => {
    const fake = fakeApi();
    const r = await call(fake.api, 'find_folders', { query: 'idle' });
    expect(r).toEqual({ isError: false, text: '/Users/me/Documents/garden-sim  (git repository)\n/Users/me/Desktop/garden-sim-notes' });
    expect(fake.searches).toEqual([['idle', 20]]);
    await call(fake.api, 'find_folders', { query: 'idle', limit: 5 });
    expect(fake.searches[1]).toEqual(['idle', 5]);
  });

  it('says so when nothing is found, and refuses an empty name', async () => {
    const { api } = fakeApi();
    expect(await call(api, 'find_folders', { query: 'nothing' })).toEqual({ isError: false, text: 'No folder named like "nothing" was found under the home folder.' });
    expect((await call(api, 'find_folders', { query: '  ' })).isError).toBe(true);
    expect((await call(api, 'find_folders', { query: 'x', limit: 0 })).isError).toBe(true);
  });
});

describe('zone tools', () => {
  it('create_zone makes a custom zone through applyLayout and answers with its id', async () => {
    const fake = fakeApi();
    const r = await call(fake.api, 'create_zone', { name: '  Probe ' });
    const zone = fake.layout().zones[0]!;
    expect(zone).toMatchObject({ kind: 'custom', name: 'Probe' });
    expect(r).toEqual({ isError: false, text: `Created the zone "Probe" with id ${zone.id}.` });
    expect(fake.ops).toEqual([{ type: 'createZone', name: '  Probe ' }]);
    expect(await call(fake.api, 'create_zone', { name: '   ' })).toEqual({ isError: true, text: 'A zone needs a name.' });
  });

  it('add_folder_zone puts a zone with its path on the canvas for a folder that exists', async () => {
    const fake = fakeApi({ folders: { '/Users/me/code/gamma': 'dir', '/Users/me/notes.txt': 'file' } });
    const r = await call(fake.api, 'add_folder_zone', { path: '/Users/me/code/gamma/' });
    expect(r).toEqual({ isError: false, text: 'The zone "gamma" (id folder:gamma) is on the canvas for /Users/me/code/gamma.' });
    expect(fake.layout().zones).toEqual([expect.objectContaining({ id: 'folder:gamma', kind: 'folder', folder: 'gamma', path: '/Users/me/code/gamma' })]);
    expect((await call(fake.api, 'add_folder_zone', { path: '/Users/me/code/missing' })).text).toBe('The folder /Users/me/code/missing does not exist.');
    expect((await call(fake.api, 'add_folder_zone', { path: '/Users/me/notes.txt' })).text).toBe('/Users/me/notes.txt is a file, not a folder.');
    expect((await call(fake.api, 'add_folder_zone', { path: 'code/gamma' })).isError).toBe(true);
    expect(fake.ops).toHaveLength(1);
  });

  it('add_folder_zone brings a hidden zone back, and says when a same-named folder is replaced', async () => {
    const fake = fakeApi({ sessions: [session('a', '/work/alpha')], folders: { '/work/alpha': 'dir', '/other/alpha': 'dir' } });
    fake.api.applyLayout({ type: 'hideZone', id: 'folder:alpha', at: NOW });
    expect((await call(fake.api, 'add_folder_zone', { path: '/work/alpha' })).isError).toBe(false);
    expect(fake.layout().zones[0]).toMatchObject({ id: 'folder:alpha', path: '/work/alpha' });
    expect(fake.layout().zones[0]!.hiddenAt).toBeUndefined();
    const r = await call(fake.api, 'add_folder_zone', { path: '/other/alpha' });
    expect(r.text).toContain("it replaces /work/alpha as this zone's folder");
  });

  it('rename_zone, hide_zone and show_zone change a zone; a wrong id or kind is a one-line error', async () => {
    const fake = fakeApi({ sessions: [session('a', '/work/alpha')] });
    await call(fake.api, 'create_zone', { name: 'Later' });
    const custom = fake.layout().zones.find((z) => z.kind === 'custom')!.id;
    expect(await call(fake.api, 'rename_zone', { id: 'folder:alpha', name: 'Alpha API' })).toEqual({ isError: false, text: 'The zone folder:alpha is now called "Alpha API".' });
    expect((await call(fake.api, 'hide_zone', { id: 'folder:alpha' })).isError).toBe(false);
    expect(fake.layout().zones.find((z) => z.id === 'folder:alpha')!.hiddenAt).toBe(NOW);
    expect((await call(fake.api, 'show_zone', { id: 'folder:alpha' })).isError).toBe(false);
    expect(fake.layout().zones.find((z) => z.id === 'folder:alpha')!.hiddenAt).toBeUndefined();
    const before = fake.ops.length;
    expect((await call(fake.api, 'rename_zone', { id: 'folder:nope', name: 'X' })).text).toBe('No zone has the id folder:nope. canvas_overview lists the zones.');
    expect((await call(fake.api, 'rename_zone', { id: custom, name: ' ' })).isError).toBe(true);
    expect((await call(fake.api, 'hide_zone', { id: custom })).text).toMatch(/only folder zones can be hidden/);
    expect((await call(fake.api, 'show_zone', { id: 'nope' })).isError).toBe(true);
    expect(fake.ops.length).toBe(before);
  });

  it('move_session assigns a session to a zone, and back with null', async () => {
    const fake = fakeApi({ sessions: [session('a', '/work/alpha')] });
    await call(fake.api, 'create_zone', { name: 'Later' });
    const custom = fake.layout().zones.find((z) => z.kind === 'custom')!.id;
    expect(await call(fake.api, 'move_session', { sessionId: 'a', zoneId: custom })).toEqual({ isError: false, text: 'Moved "Session a" to the zone "Later".' });
    expect(fake.layout().assignments).toEqual({ a: custom });
    expect((await call(fake.api, 'move_session', { sessionId: 'a', zoneId: null })).isError).toBe(false);
    expect(fake.layout().assignments).toEqual({});
    expect((await call(fake.api, 'move_session', { sessionId: 'nope', zoneId: custom })).isError).toBe(true);
    expect((await call(fake.api, 'move_session', { sessionId: 'a', zoneId: 'custom:00000000' })).isError).toBe(true);
  });

  it('delete_zone deletes custom zones only', async () => {
    const fake = fakeApi({ sessions: [session('a', '/work/alpha')] });
    await call(fake.api, 'create_zone', { name: 'Later' });
    const custom = fake.layout().zones.find((z) => z.kind === 'custom')!.id;
    expect((await call(fake.api, 'delete_zone', { id: 'folder:alpha' })).text).toMatch(/only custom zones can be deleted/);
    expect(fake.layout().zones).toHaveLength(2);
    expect(await call(fake.api, 'delete_zone', { id: custom })).toEqual({ isError: false, text: 'Deleted the zone "Later". Its sessions are back in their folder zones.' });
    expect(fake.layout().zones.map((z) => z.id)).toEqual(['folder:alpha']);
    expect((await call(fake.api, 'delete_zone', { id: custom })).isError).toBe(true);
  });
});

describe('open_session', () => {
  it('opens the card in the app without asking and changes nothing on the canvas', async () => {
    const fake = fakeApi({ sessions: [session('a', '/work/alpha', { name: 'Fix login' })] });
    expect(await call(fake.api, 'open_session', { id: 'a' })).toEqual({ isError: false, text: 'Opened "Fix login" in the app.' });
    expect(fake.opened).toEqual(['a']);
    expect(fake.ops).toEqual([]);
  });

  it('shows a hidden zone first when the card is off the canvas', async () => {
    const fake = fakeApi({ sessions: [session('a', '/work/alpha')] });
    fake.api.applyLayout({ type: 'hideZone', id: 'folder:alpha', at: NOW });
    const r = await call(fake.api, 'open_session', { id: 'a' });
    expect(r).toEqual({ isError: false, text: 'Opened "Session a" in the app. Its zone "alpha" was hidden, so it is back on the canvas.' });
    expect(fake.ops.at(-1)).toEqual({ type: 'hideZone', id: 'folder:alpha', at: null });
    expect(fake.layout().zones[0]!.hiddenAt).toBeUndefined();
    expect(fake.opened).toEqual(['a']);
  });

  it('leaves a hidden zone hidden when the card is back on the canvas by itself', async () => {
    const fake = fakeApi({ sessions: [session('a', '/work/alpha', { state: 'needs_you', need: 'question' })] });
    fake.api.applyLayout({ type: 'hideZone', id: 'folder:alpha', at: NOW });
    expect((await call(fake.api, 'open_session', { id: 'a' })).text).toBe('Opened "Session a" in the app.');
    expect(fake.layout().zones[0]!.hiddenAt).toBe(NOW);
  });

  it('an unknown id, the agent itself, or a window that cannot open are one-line errors', async () => {
    const agent = session('me', '/data/agent');
    const fake = fakeApi({ sessions: [session('a', '/work/alpha')], agent });
    expect(await call(fake.api, 'open_session', { id: 'nope' })).toEqual({ isError: true, text: 'No session has the id nope. canvas_overview lists the sessions.' });
    expect((await call(fake.api, 'open_session', { id: 'me' })).isError).toBe(true);
    expect(fake.opened).toEqual([]);
    const quitting = fakeApi({ sessions: [session('a', '/work/alpha')], openFails: 'Agent canvas is quitting, so its window stays closed' });
    expect(await call(quitting.api, 'open_session', { id: 'a' })).toEqual({ isError: true, text: 'open_session failed: Agent canvas is quitting, so its window stays closed' });
  });
});

describe('start_task', () => {
  it('starts a Claude session in a folder with the prompt, and puts the folder zone on the canvas', async () => {
    const fake = fakeApi({ folders: { '/Users/me/code/gamma': 'dir' } });
    const r = await call(fake.api, 'start_task', { folder: '/Users/me/code/gamma', prompt: 'Add a healthcheck' });
    expect(r).toEqual({ isError: false, text: 'Handed the task to the project orchestrator for /Users/me/code/gamma. Its chat id is new-1.' });
    expect(fake.started).toEqual([{ provider: null, cwd: '/Users/me/code/gamma', model: null, mode: null, text: 'Add a healthcheck' }]);
    expect(fake.layout().zones[0]).toMatchObject({ id: 'folder:gamma', path: '/Users/me/code/gamma' });
  });

  it('takes a folder zone instead: its recorded path, else where its latest session ran', async () => {
    const fake = fakeApi({
      sessions: [session('old', '/old/alpha', { startedAt: NOW - 100 * MIN }), session('new', '/work/alpha', { startedAt: NOW - 10 * MIN })],
      folders: { '/work/alpha': 'dir', '/Users/me/code/gamma': 'dir' },
    });
    await call(fake.api, 'start_task', { zoneId: 'folder:alpha', prompt: 'Go', provider: 'codex', model: 'gpt-demo', mode: 'read-only' });
    expect(fake.started[0]).toEqual({ provider: 'codex', cwd: '/work/alpha', model: 'gpt-demo', mode: 'read-only', text: 'Go' });
    fake.api.applyLayout({ type: 'addFolderZone', path: '/Users/me/code/gamma' });
    await call(fake.api, 'start_task', { zoneId: 'folder:gamma', prompt: 'Go' });
    expect(fake.started[1]!.cwd).toBe('/Users/me/code/gamma');
  });

  it('takes an ACP agent from Settings as the provider (acp:<id> or its bare id); refuses one not there or not installed', async () => {
    const fake = fakeApi({ folders: { '/work/alpha': 'dir' }, acp: [{ id: 'gemini', name: 'Gemini CLI', installed: true }, { id: 'goose', name: 'Goose', installed: false }] });
    await call(fake.api, 'start_task', { folder: '/work/alpha', prompt: 'Go', provider: 'acp:gemini' });
    await call(fake.api, 'start_task', { folder: '/work/alpha', prompt: 'Go', provider: 'Gemini' });
    expect(fake.started.map((r) => r.provider)).toEqual(['acp:gemini', 'acp:gemini']);
    expect((await call(fake.api, 'start_task', { folder: '/work/alpha', prompt: 'Go', provider: 'acp:goose' })).text).toBe('Goose is not installed on this Mac, so it cannot take the task.');
    expect((await call(fake.api, 'start_task', { folder: '/work/alpha', prompt: 'Go', provider: 'acp:zed' })).text).toMatch(/^No ACP agent "zed" is available/);
    expect((await call(fake.api, 'start_task', { folder: '/work/alpha', prompt: 'Go', provider: 'not a name' })).isError).toBe(true);
    expect(fake.started).toHaveLength(2);
    expect(JSON.parse((await call(fake.api, 'canvas_overview')).text).acpAgents).toEqual([
      { id: 'gemini', name: 'Gemini CLI', installed: true },
      { id: 'goose', name: 'Goose', installed: false },
    ]);
  });

  it('refuses a missing folder, a custom zone, both or neither target, and an empty prompt, starting nothing', async () => {
    const fake = fakeApi({ folders: { '/Users/me/notes.txt': 'file' } });
    await call(fake.api, 'create_zone', { name: 'Later' });
    const custom = fake.layout().zones[0]!.id;
    expect((await call(fake.api, 'start_task', { folder: '/gone', prompt: 'Go' })).text).toBe('The folder /gone does not exist.');
    expect((await call(fake.api, 'start_task', { folder: '/Users/me/notes.txt', prompt: 'Go' })).text).toBe('/Users/me/notes.txt is a file, not a folder.');
    expect((await call(fake.api, 'start_task', { folder: 'relative', prompt: 'Go' })).isError).toBe(true);
    expect((await call(fake.api, 'start_task', { zoneId: custom, prompt: 'Go' })).text).toMatch(/has no known folder/);
    expect((await call(fake.api, 'start_task', { zoneId: 'folder:nope', prompt: 'Go' })).isError).toBe(true);
    expect((await call(fake.api, 'start_task', { prompt: 'Go' })).text).toBe('Give either folder or zoneId, not both and not neither.');
    expect((await call(fake.api, 'start_task', { folder: '/a', zoneId: 'b', prompt: 'Go' })).isError).toBe(true);
    expect((await call(fake.api, 'start_task', { folder: '/a', prompt: ' ' })).text).toBe('A task needs a prompt.');
    expect((await call(fake.api, 'start_task', { folder: '/a', prompt: 'Go', provider: 'gemini' })).isError).toBe(true);
    expect(fake.started).toEqual([]);
  });

  it("gives the engine's reason when the start fails, and adds no zone", async () => {
    const fake = fakeApi({ folders: { '/work/alpha': 'dir' }, startFails: 'Claude Code is signed out on this Mac. Run claude, then /login.' });
    const r = await call(fake.api, 'start_task', { folder: '/work/alpha', prompt: 'Go' });
    expect(r).toEqual({ isError: true, text: 'The task did not start: Claude Code is signed out on this Mac. Run claude, then /login.' });
    expect(fake.ops).toEqual([]);
  });
});

describe('start_task with attachments', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const setup = () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-tools-'));
    const pasted = path.join(tmp, 'claude-501', 'images');
    fs.mkdirSync(pasted, { recursive: true });
    fs.writeFileSync(path.join(pasted, '1.png'), PNG);
    fs.writeFileSync(path.join(tmp, 'notes.md'), '# Notes');
    const store = new AttachmentStore(path.join(tmp, 'data', 'attachments'));
    return { tmp, pasted, store, fake: fakeApi({ folders: { '/work/alpha': 'dir' }, store }) };
  };

  it('copies pasted images and files into the attachments folder and hands the copies on', async () => {
    const { tmp, pasted, store, fake } = setup();
    const r = await call(fake.api, 'start_task', { folder: '/work/alpha', prompt: 'Fix the header', attachments: [path.join(pasted, '1.png'), path.join(tmp, 'notes.md')] });
    expect(r.text).toBe('Handed the task with 2 attachments to the project orchestrator for /work/alpha. Its chat id is new-1.');
    const kept = fake.started[0]!.attachments!;
    expect(kept.map((a) => [a.name, a.mime])).toEqual([['1.png', 'image/png'], ['notes.md', null]]);
    for (const a of kept) expect(a.path.startsWith(store.root + path.sep)).toBe(true);
    // The temp folder goes away; the copies stay.
    fs.rmSync(pasted, { recursive: true });
    expect(fs.readFileSync(kept[0]!.path)).toEqual(PNG);
  });

  it('refuses a missing, relative or folder attachment clearly, starting nothing', async () => {
    const { tmp, fake } = setup();
    const gone = path.join(tmp, 'claude-501', 'images', '9.png');
    expect(await call(fake.api, 'start_task', { folder: '/work/alpha', prompt: 'Go', attachments: [gone] })).toEqual({ isError: true,
      text: `The task did not start: The attachment ${gone} does not exist. A pasted image's temporary file may be gone: ask the owner to paste it again.` });
    expect((await call(fake.api, 'start_task', { folder: '/work/alpha', prompt: 'Go', attachments: ['images/1.png'] })).text).toMatch(/is not an absolute path/);
    expect((await call(fake.api, 'start_task', { folder: '/work/alpha', prompt: 'Go', attachments: [tmp] })).text).toMatch(/is a folder/);
    expect(fake.started).toEqual([]);
    expect(fake.ops).toEqual([]);
  });
});

describe('helpers', () => {
  it('ago: seconds, minutes, hours, days', () => {
    expect([5_000, 59_000, 61_000, 3 * 3_600_000 + 5, 49 * 3_600_000].map((d) => ago(NOW - d, NOW))).toEqual(['5s', '59s', '1m', '3h', '2d']);
    expect(ago(NOW + 10_000, NOW)).toBe('0s');
  });

  it('zonePath: a session in a worktree stands for its repository', () => {
    const zone = ensureFolderZones({ version: 1, zones: [], assignments: {} }, ['alpha']).zones[0]!;
    expect(zonePath(zone, [session('a', '/work/alpha/.claude/worktrees/fix-1', { folder: 'alpha' })])).toBe('/work/alpha');
    expect(zonePath(zone, [])).toBeNull();
  });
});

describe('add_image and remove_image', () => {
  const layout = (): Layout => ({ version: 1, zones: [{ id: 'custom:a', name: 'Refs', kind: 'custom', folder: null, x: 100, y: 200, hueIndex: 0 }], assignments: {} });

  it('adds an image file by path, free beside the zones or into a zone, and canvas_overview lists it', async () => {
    const fake = fakeApi({ layout: layout(), folders: { '/Users/me/shots/hero.png': 'file' } });
    const free = await call(fake.api, 'add_image', { path: '/Users/me/shots/hero.png', caption: ' The hero ' });
    expect(free.isError).toBe(false);
    const [a] = fake.layout().items!;
    expect(a).toMatchObject({ kind: 'image', src: { kind: 'path', path: '/Users/me/shots/hero.png' }, name: 'hero.png', caption: 'The hero', place: { zone: null } });
    expect(a!.place.zone === null && a!.place.x < 100).toBe(true);
    expect(free.text).toContain(a!.id);

    const inZone = await call(fake.api, 'add_image', { path: '/Users/me/shots/hero.png', zoneId: 'custom:a' });
    expect(inZone.text).toContain('to the zone "Refs"');
    expect(fake.layout().items![1]!.place).toEqual({ zone: 'custom:a', col: 0, top: 20_000 });
    const out = JSON.parse((await call(fake.api, 'canvas_overview')).text);
    expect(out.images).toHaveLength(2);
    expect(out.images[0]).toMatchObject({ name: 'hero.png', path: '/Users/me/shots/hero.png', zone: null, caption: 'The hero' });
  });

  it('refuses a relative path, a file that is not an image, a missing file, a folder and an unknown zone', async () => {
    const fake = fakeApi({ layout: layout(), folders: { '/Users/me/shots': 'dir', '/Users/me/a.png': 'file' } });
    expect((await call(fake.api, 'add_image', { path: 'shots/hero.png' })).isError).toBe(true);
    expect((await call(fake.api, 'add_image', { path: '/Users/me/notes.txt' })).text).toContain('not an image');
    expect((await call(fake.api, 'add_image', { path: '/Users/me/gone.png' })).text).toContain('does not exist');
    expect((await call(fake.api, 'add_image', { path: '/Users/me/a.png', zoneId: 'custom:nope' })).text).toContain('No zone');
    expect(fake.layout().items ?? []).toEqual([]);
  });

  it('removes by id, or every image of one file by path, and never touches the file', async () => {
    const fake = fakeApi({ layout: layout(), folders: { '/Users/me/a.png': 'file', '/Users/me/b.png': 'file' } });
    await call(fake.api, 'add_image', { path: '/Users/me/a.png' });
    await call(fake.api, 'add_image', { path: '/Users/me/a.png', zoneId: 'custom:a' });
    await call(fake.api, 'add_image', { path: '/Users/me/b.png' });
    const b = fake.layout().items![2]!;
    expect((await call(fake.api, 'remove_image', { path: '/Users/me/a.png' })).text).toContain('2 images');
    expect(fake.layout().items!.map((it) => it.id)).toEqual([b.id]);
    expect((await call(fake.api, 'remove_image', { id: b.id })).isError).toBe(false);
    expect(fake.layout().items).toEqual([]);
    expect((await call(fake.api, 'remove_image', { id: b.id })).isError).toBe(true);
    expect((await call(fake.api, 'remove_image', {})).isError).toBe(true);
  });
});
