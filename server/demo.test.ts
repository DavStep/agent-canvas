import { describe, expect, it } from 'vitest';
import type { ChatState, ChatUpdate } from '../shared/chat.ts';
import { createDemoSource, DEMO_AGENT_CWD, DEMO_AGENT_REPORT, demoEngine, demoSnapshot } from './demo.ts';
import { zoneIdFor } from './layoutOps.ts';
import { applyUpdate } from './engines/chatLog.ts';
import { BUSY_ELSEWHERE, WRITING_ALONGSIDE } from '../shared/banners.ts';

describe('demoSnapshot', () => {
  const snap = demoSnapshot(Date.UTC(2026, 10, 19, 18, 0));

  it('gives every session a distinct fake host id so the deep link renders', () => {
    const ids = snap.sessions.map((s) => s.hostId);
    for (const id of ids) expect(id).toMatch(/^local_demo-\d+$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('places the four zones where the mockup has them', () => {
    const at = Object.fromEntries(snap.layout.zones.map((z) => [z.name, [z.x, z.y]]));
    expect(at).toEqual({
      'garden-sim': [0, 0],
      'garden-dashboard': [40, 356],
      'sailcloth-io': [572, 344],
      'No folder': [604, 500],
    });
  });

  it('starts every session before its current state began', () => {
    for (const s of snap.sessions) expect(s.startedAt).toBeLessThanOrEqual(s.stateSince);
  });
});

describe('demoSnapshot, large variant', () => {
  const snap = demoSnapshot(Date.UTC(2026, 10, 19, 18, 0), 'large');

  it('has forty invented sessions over twelve folders', () => {
    expect(snap.sessions).toHaveLength(40);
    expect(new Set(snap.sessions.map((s) => s.id)).size).toBe(40);
    expect(new Set(snap.sessions.map((s) => s.folder)).size).toBe(12);
    expect(snap.layout.zones).toHaveLength(12);
  });

  it('leaves every zone for the page to place', () => {
    for (const z of snap.layout.zones) expect([z.x, z.y]).toEqual([null, null]);
  });

  it('is well formed: needs-you exactly when there is a need, every session started before its state', () => {
    for (const s of snap.sessions) {
      expect(s.need !== null).toBe(s.state === 'needs_you');
      expect(s.startedAt).toBeLessThanOrEqual(s.stateSince);
      expect(s.hostId).toMatch(/^local_demo-\d+$/);
    }
    expect(new Set(snap.sessions.map((s) => s.state))).toEqual(new Set(['working', 'needs_you', 'idle']));
  });
});

describe('demoSnapshot owners', () => {
  it('every card has an owner, and the mockup shows all three', () => {
    const snap = demoSnapshot(Date.UTC(2026, 10, 19, 18, 0));
    expect(new Set(snap.sessions.map((s) => s.owner))).toEqual(new Set(['here', 'elsewhere', 'nobody']));
    for (const s of demoSnapshot(Date.UTC(2026, 10, 19, 18, 0), 'large').sessions) expect(['here', 'elsewhere', 'nobody']).toContain(s.owner);
  });
});

describe('demoEngine', () => {
  async function open(id: string) {
    const engine = demoEngine('claude', { stepMs: 1 });
    let state: ChatState = await engine.open(id, (u: ChatUpdate) => { state = applyUpdate(state, u); });
    const until = async (cond: (s: ChatState) => unknown, what: string) => {
      for (let n = 0; n < 500; n++) {
        if (cond(state)) return;
        await new Promise((r) => setTimeout(r, 2));
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    return { engine, current: () => state, until };
  }

  it('opens a demo card with its name, folder, owner and some history', async () => {
    const { current } = await open('demo-purchases');
    expect(current()).toMatchObject({ sessionId: 'demo-purchases', provider: 'claude', title: 'Purchases unavailable in production', cwd: '/Users/demo/Documents/garden-sim', owner: 'here', turn: 'idle' });
    expect(current().items.length).toBeGreaterThan(0);
  });

  it('a scripted turn: reasoning, streamed text, a read, an edit, then a command that waits for approval', async () => {
    const { engine, current, until } = await open('demo-purchases');
    await engine.send('demo-purchases', 'Fix the product IDs', []);
    expect(current().turn).toBe('running');
    await until((s) => s.items.some((i) => i.kind === 'approval' && i.status === 'pending'), 'approval');
    const items = current().items;
    expect(items.some((i) => i.kind === 'user' && i.text === 'Fix the product IDs')).toBe(true);
    expect(items.some((i) => i.kind === 'assistant' && i.text.length > 0)).toBe(true);
    expect(items.find((i) => i.kind === 'reasoning')).toMatchObject({ streaming: false, durationMs: 6000 });
    expect(items.find((i) => i.kind === 'tool' && i.tool === 'read')).toMatchObject({ status: 'done', name: 'Read', output: expect.stringContaining('\n') });
    // In the mockup's order: thought, reply, the read and the edit, then the command.
    const kinds = items.slice(items.findIndex((i) => i.kind === 'user' && i.text === 'Fix the product IDs'))
      .map((i) => (i.kind === 'tool' ? i.tool : i.kind));
    expect(kinds).toEqual(['user', 'reasoning', 'assistant', 'read', 'edit', 'command', 'approval']);
    expect(items.find((i) => i.kind === 'tool' && i.tool === 'edit')).toMatchObject({ status: 'done', diffs: [expect.objectContaining({ added: expect.any(Number) })] });
    expect(items.find((i) => i.kind === 'tool' && i.tool === 'command')).toMatchObject({ status: 'waiting' });
    expect(engine.busy()).toEqual([{ sessionId: 'demo-purchases', reason: 'approval' }]);

    const approval = items.find((i) => i.kind === 'approval')!;
    await engine.answerApproval('demo-purchases', approval.id, 'allow');
    await until((s) => s.turn === 'idle', 'turn idle');
    expect(current().items.find((i) => i.kind === 'tool' && i.tool === 'command')).toMatchObject({ status: 'done', exitCode: 0 });
    expect(engine.busy()).toEqual([]);
  });

  it('a Claude card open elsewhere waits while the other app works, and takes a message between its turns', async () => {
    const busy = await open('demo-dbviz');
    expect(busy.current().owner).toBe('elsewhere');
    await expect(busy.engine.send('demo-dbviz', 'hi', [])).rejects.toThrow(BUSY_ELSEWHERE);
    await expect(busy.engine.moveHere('demo-dbviz')).resolves.toBe(true);
    expect(busy.current().owner).toBe('here');
    const idle = await open('demo-deploy');
    expect(idle.current().owner).toBe('elsewhere');
    await idle.engine.send('demo-deploy', 'Ship it', []);
    expect(idle.current()).toMatchObject({ owner: 'here', turn: 'running' });
    expect(idle.current().items.filter((i) => i.kind === 'notice').at(-1)).toMatchObject({ level: 'info', text: WRITING_ALONGSIDE });
    expect(idle.current().items.some((i) => i.kind === 'user' && i.text === 'Ship it')).toBe(true);
  });

  it("options(): the demo's scripted models and the provider's modes, with their defaults", async () => {
    const claude = await demoEngine('claude').options();
    expect(claude).toMatchObject({ model: 'demo-large', mode: 'auto', models: [{ id: 'demo-large', isDefault: true }, { id: 'demo-small' }] });
    expect(claude.modes.map((m) => m.label)).toEqual(['Auto', 'Ask', 'Accept edits', 'Plan', 'Bypass']);
    const codex = await demoEngine('codex').options();
    expect(codex).toMatchObject({ model: 'demo-large', mode: 'auto' });
    expect(codex.modes.map((m) => m.label)).toEqual(['Read only', 'Auto', 'Full access']);
  });

  it('start() makes a new demo chat and returns its id', async () => {
    const engine = demoEngine('codex', { stepMs: 1 });
    const id = await engine.start({ provider: 'codex', cwd: '/Users/demo/Documents/garden-sim', model: null, effort: null, mode: null, text: 'Hello', images: [] });
    const state = await engine.open(id, () => {});
    expect(state).toMatchObject({ provider: 'codex', owner: 'here', cwd: '/Users/demo/Documents/garden-sim' });
    expect(state.items[0]).toMatchObject({ kind: 'user', text: 'Hello' });
    await engine.stop();
  });
});

describe('createDemoSource: a session started here', () => {
  it("shows up as a working card of this app's in the zone of its folder; a new folder gets a zone", () => {
    const source = createDemoSource(Date.UTC(2026, 10, 19, 18, 0));
    let changes = 0;
    source.onChange(() => { changes++; });
    source.started({ id: 'codex:demo-new-1', provider: 'codex', cwd: '/Users/demo/Documents/sailcloth-io', text: 'Tidy the deploy script\nand more', at: 1000 });
    const snap = source.snapshot();
    const card = snap.sessions.find((s) => s.id === 'codex:demo-new-1');
    expect(card).toMatchObject({ provider: 'codex', folder: 'sailcloth-io', cwd: '/Users/demo/Documents/sailcloth-io', state: 'working', owner: 'here', name: 'Tidy the deploy script', startedAt: 1000 });
    expect(zoneIdFor(card!, snap.layout)).toBe('folder:sailcloth-io');
    expect(changes).toBe(1);

    source.started({ id: 'demo-new-2', provider: 'claude', cwd: '/Users/demo/Documents/new-thing', text: 'Hello', at: 2000 });
    const next = source.snapshot();
    expect(next.layout.zones.find((z) => z.id === 'folder:new-thing')).toMatchObject({ kind: 'folder', folder: 'new-thing', x: null, y: null });
    expect(next.sessions.map((s) => s.id)).toContain('demo-new-2');
  });
});

describe('demo: the canvas agent', () => {
  it('a session started in the agent folder is the snapshot\'s agent, not a card, and makes no zone', () => {
    const source = createDemoSource(Date.UTC(2026, 10, 19, 18, 0));
    expect(source.snapshot().agent).toBeNull();
    const before = source.snapshot();
    let changes = 0;
    source.onChange(() => { changes++; });
    source.started({ id: 'demo-new-1', provider: 'claude', cwd: DEMO_AGENT_CWD, text: 'What is going on?', at: 1000 });
    const snap = source.snapshot();
    expect(snap.agent).toMatchObject({ id: 'demo-new-1', provider: 'claude', cwd: DEMO_AGENT_CWD, state: 'working', owner: 'here', lastPrompt: 'What is going on?' });
    expect(snap.sessions).toEqual(before.sessions);
    expect(snap.layout).toEqual(before.layout);
    expect(changes).toBe(1);
    source.agentTurn('demo-new-1', false);
    expect(source.snapshot().agent).toMatchObject({ state: 'idle', activity: null, lastAnswer: DEMO_AGENT_REPORT });
    source.agentTurn('demo-new-1', true);
    expect(source.snapshot().agent).toMatchObject({ state: 'working' });
    source.agentTurn('someone-else', false);
    expect(changes).toBe(3);
    // A new conversation takes its place.
    source.started({ id: 'demo-new-2', provider: 'claude', cwd: DEMO_AGENT_CWD, text: 'Again', at: 2000 });
    expect(source.snapshot().agent?.id).toBe('demo-new-2');
  });

  it("the agent's chat plays its own script: it reads the canvas, then reports by zone, with no approval", async () => {
    const turns: [string, boolean][] = [];
    const engine = demoEngine('claude', { stepMs: 1, onAgentTurn: (id, running) => turns.push([id, running]) });
    const id = await engine.start({ provider: 'claude', cwd: DEMO_AGENT_CWD, model: null, effort: null, mode: 'default', text: 'What is going on?', images: [] });
    let state: ChatState = await engine.open(id, (u: ChatUpdate) => { state = applyUpdate(state, u); });
    expect(state).toMatchObject({ cwd: DEMO_AGENT_CWD, mode: 'default', turn: 'running' });
    for (let n = 0; n < 200 && state.turn !== 'idle'; n++) await new Promise((r) => setTimeout(r, 5));
    expect(state.turn).toBe('idle');
    expect(state.items.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(state.items[1]).toMatchObject({ kind: 'tool', tool: 'mcp', name: 'mcp__canvas__canvas_overview', status: 'done' });
    expect(state.items[2]).toMatchObject({ kind: 'assistant', text: DEMO_AGENT_REPORT, streaming: false });
    expect(engine.busy()).toEqual([]);
    expect(turns).toEqual([[id, true], [id, false]]);
    // A later message plays it again.
    await engine.send(id, 'And now?', []);
    for (let n = 0; n < 200 && state.turn !== 'idle'; n++) await new Promise((r) => setTimeout(r, 5));
    expect(state.items.filter((i) => i.kind === 'assistant')).toHaveLength(2);
    await engine.stop();
  });
});
