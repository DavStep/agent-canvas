import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pkg from '../../../package.json' with { type: 'json' };
import type { ApprovalAnswer, ChatItem, ChatState, ChatUpdate } from '../../../shared/chat.ts';
import { applyUpdate } from '../chatLog.ts';
import type { CodexCanvasAgent } from '../../agent/codex.ts';
import { CodexEngine } from './engine.ts';
import { FakeAppServer, RpcFailure, THREAD_ID as T, type Msg } from './fakeAppServer.ts';

const NOW = 1795000300000;

function setup(configure: (fake: FakeAppServer) => void = () => {}, pollMs = 60_000, handshakeMs?: number, agent?: CodexCanvasAgent) {
  const fake = new FakeAppServer();
  configure(fake);
  // The store's view of who writes a thread: here, the threads the fake says another process holds.
  const engine = new CodexEngine({
    agent, codexPath: '/fake/bin/codex', spawn: fake.spawn, now: () => NOW, pollMs, elsewhere: (id) => fake.lockedElsewhere.has(id),
    ...(handshakeMs ? { handshakeMs } : {}),
  });
  const updates: ChatUpdate[] = [];
  let state: ChatState | null = null;
  const emit = (u: ChatUpdate) => {
    updates.push(u);
    if (state) state = applyUpdate(state, u);
  };
  const open = async (id = T): Promise<ChatState> => {
    state = await engine.open(id, emit);
    return state;
  };
  const current = (): ChatState => {
    if (!state) throw new Error('chat not open');
    return state;
  };
  const item = <K extends ChatItem['kind']>(kind: K, pred: (i: Extract<ChatItem, { kind: K }>) => boolean = () => true) =>
    current().items.find((i): i is Extract<ChatItem, { kind: K }> => i.kind === kind && pred(i as Extract<ChatItem, { kind: K }>));
  const until = async (cond: () => unknown, what = 'condition'): Promise<void> => {
    for (let n = 0; n < 400; n++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  /** Takes the thread here as the owner would: one message, its turn played to the end. */
  const hold = async (id = T): Promise<void> => {
    await engine.send(id, 'Say hello', []);
    await fake.replay('turn-text.jsonl');
    await until(() => current().turn === 'idle', 'turn idle');
  };
  return { fake, engine, updates, open, current, item, until, hold };
}

const textInput = (text: string) => ({ type: 'text', text, text_elements: [] });

describe('CodexEngine', () => {
  it('resumes an API agent with keyed auth and asks before changing the canvas', async () => {
    const cwd = '/data/agent/codex-api';
    const findFolders = vi.fn().mockResolvedValue([]);
    const agent = { cwd, auth: { command: '/key-helper', args: ['codex'] }, api: { findFolders } as unknown as CodexCanvasAgent['api'] };
    const { engine, fake, open, item, until } = setup(f => { f.thread.cwd = cwd; }, 60_000, undefined, agent);
    try {
      await open();
      await engine.send(T, 'Check the canvas', []);
      expect(fake.requests('thread/resume')[0]).toMatchObject({
        modelProvider: 'canvas_openai', config: { 'model_providers.canvas_openai': { auth: agent.auth } },
      });
      const call = (id: number, tool: string, args: object) => fake.write({ id, method: 'item/tool/call',
        params: { threadId: T, turnId: 'turn-a1', callId: 'c' + id, namespace: null, tool, arguments: args } });
      call(201, 'find_folders', { query: 'demo' });
      await until(() => fake.replyTo(201));
      expect(findFolders).toHaveBeenCalledOnce();
      expect(fake.replyTo(201)?.result.success).toBe(true);
      call(202, 'start_task', { folder: '/demo', prompt: 'Review changes' });
      await until(() => item('approval'));
      expect(fake.replyTo(202)).toBeUndefined();
      await engine.answerApproval(T, item('approval')!.id, 'deny');
      await until(() => fake.replyTo(202));
      expect(fake.replyTo(202)?.result).toMatchObject({ success: false, contentItems: [{ text: 'The owner declined this action.' }] });
    } finally { await engine.stop(); }
  });

  it('in Full access a canvas tool that would ask runs at once', async () => {
    const cwd = '/data/agent';
    const deleted: unknown[] = [];
    const api = {
      snapshot: () => ({ layout: { zones: [{ id: 'custom:x', name: 'X', kind: 'custom' }] }, sessions: [] }),
      applyLayout: (op: unknown) => { deleted.push(op); },
    } as unknown as CodexCanvasAgent['api'];
    const agent = { cwd, auth: { command: '/key-helper', args: [] }, api };
    const { engine, fake, open, item, until } = setup(f => { f.thread.cwd = cwd; }, 60_000, undefined, agent);
    try {
      await open();
      await engine.setMode(T, 'full-access');
      await engine.send(T, 'Tidy the canvas', []);
      fake.write({ id: 210, method: 'item/tool/call',
        params: { threadId: T, turnId: 'turn-a1', callId: 'c210', namespace: null, tool: 'delete_zone', arguments: { id: 'custom:x' } } });
      await until(() => fake.replyTo(210));
      expect(item('approval')).toBeUndefined();
      expect(fake.replyTo(210)?.result.success).toBe(true);
      expect(deleted).toEqual([{ type: 'deleteZone', id: 'custom:x' }]);
    } finally { await engine.stop(); }
  });

  it('restores the project role by thread id and exposes only its project tools', async () => {
    const project = { connection: 'codex-api' as const, prompt: 'Coordinate this project.', tools: [] };
    const agent = { cwd: '/data/agent', projectFor: (id: string) => id === T ? project : undefined,
      auth: { command: '/key-helper', args: [] }, api: {} as CodexCanvasAgent['api'] };
    const { engine, fake, open, until } = setup(() => {}, 60_000, undefined, agent);
    try {
      await open();
      await engine.send(T, 'Coordinate work', []);
      expect(fake.requests('thread/resume')[0]).toMatchObject({ developerInstructions: project.prompt });
      fake.write({ id: 209, method: 'item/tool/call',
        params: { threadId: T, turnId: 'turn-a1', callId: 'c209', namespace: null, tool: 'canvas_overview', arguments: {} } });
      await until(() => fake.replyTo(209));
      expect(fake.replyTo(209)?.result.success).toBe(false);
    } finally { await engine.stop(); }
  });

  it('shows the newest Codex browser attachment and clears it when Codex removes it', async () => {
    const payload = { screenshotUrl: 'data:image/jpeg;base64,AAAA' };
    const capture = { attachmentType: 'browser_preview', id: 'capture', createdAt: 2, payload };
    const { fake, open, current, until } = setup(f => {
      f.handlers['thread/attachment/list'] = () => ({ data: [capture, { ...capture, id: 'old', createdAt: 1 }], nextCursor: null });
    });
    expect((await open()).browserCapture).toEqual({ id: 'capture', src: payload.screenshotUrl });
    fake.handlers['thread/attachment/list'] = () => ({ data: [], nextCursor: null });
    fake.write({ method: 'thread/attachment/updated', params: { threadId: T, attachmentType: 'browser_preview' } });
    await until(() => current().browserCapture === null);
  });

  it('handshake sends initialize with clientInfo agent-canvas and experimentalApi true, then initialized', async () => {
    const { fake, open } = setup();
    await open();
    expect(fake.sent[0]).toEqual({
      id: 1, method: 'initialize',
      params: { clientInfo: { name: 'agent-canvas', title: 'Agent canvas', version: pkg.version }, capabilities: { experimentalApi: true } },
    });
    expect(fake.sent[1]).toEqual({ method: 'initialized' });
    expect(fake.spawns).toContainEqual(['app-server']);
  });

  it('open() of a thread another process writes → history from thread/read and messages through the queue', async () => {
    const { fake, engine, open } = setup((f) => f.lockedElsewhere.add(T));
    const state = await open();
    expect(state.owner).toBe('elsewhere');
    expect(state.banner).toBeNull();
    // Metadata from thread/read, then a bounded page of turns: never the whole thread.
    expect(fake.requests('thread/read')).toEqual([{ threadId: T, includeTurns: false }]);
    expect(fake.requests('thread/turns/list')).toEqual([{ threadId: T, limit: 50, sortDirection: 'desc', itemsView: 'full' }]);
    expect(state.items.map((i) => i.id)).toEqual(expect.arrayContaining(['item-u1', 'item-c1', 'item-a1', 'item-u2']));
    expect(engine.owned().has(T)).toBe(false);
    await engine.send(T, 'hi', []);
    expect(fake.requests('thread/queue/add')).toHaveLength(1);
    expect(fake.requests('turn/start')).toEqual([]);
  });

  it('open() of a free thread sends no thread/resume: owner nobody, history from a bounded thread/turns/list, no poll', async () => {
    const { fake, engine, open } = setup(() => {}, 5);
    const state = await open();
    expect(fake.requests('thread/resume')).toEqual([]);
    expect(fake.requests('thread/read')).toEqual([{ threadId: T, includeTurns: false }]);
    expect(fake.requests('thread/turns/list')).toEqual([{ threadId: T, limit: 50, sortDirection: 'desc', itemsView: 'full' }]);
    expect(state).toMatchObject({ sessionId: T, provider: 'codex', owner: 'nobody', banner: null, cwd: '/work/demo', turn: 'idle' });
    expect(state.items.map((i) => i.id)).toEqual(expect.arrayContaining(['item-u1', 'item-r1', 'item-c1', 'item-a1', 'item-u2']));
    expect(state.hasOlder).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(engine.owned().has(T)).toBe(false);
    // Viewing is not followed: no elsewhere poll.
    expect(fake.requests('thread/read')).toHaveLength(1);
    // Picking a model or mode before the first message takes no lock either.
    await engine.setModel(T, 'demo-mini');
    await engine.setMode(T, 'auto');
    expect(fake.requests('thread/resume')).toEqual([]);
  });

  it('the first send resumes the thread, then sends; the chat is here from then on', async () => {
    const { fake, engine, open, current } = setup();
    await open();
    await engine.send(T, 'hi', []);
    const methods = fake.sent.filter((m) => m.method === 'thread/resume' || m.method === 'turn/start').map((m) => m.method);
    expect(methods).toEqual(['thread/resume', 'turn/start']);
    expect(fake.requests('thread/resume')).toEqual([{ threadId: T, excludeTurns: true }]);
    // Nothing picked or saved: the thread's own sandbox (the fake resumes it readOnly) shows and runs.
    expect(current()).toMatchObject({ owner: 'here', turn: 'running', mode: 'read-only' });
    await new Promise((r) => setTimeout(r, 10));
    expect(engine.owned()).toEqual(new Set([T]));
    await engine.send(T, 'again', []);
    expect(fake.requests('thread/resume')).toHaveLength(1);
  });

  it('a chat opened read-only with nothing saved resumes in its own sandbox: Full access stays Full access, never on-request', async () => {
    const { fake, engine, open, current } = setup((f) => { f.resumeSandbox = { type: 'dangerFullAccess' }; });
    expect((await open()).mode).toBe('auto');
    await engine.send(T, 'hi', []);
    expect(fake.requests('turn/start')[0]).not.toHaveProperty('approvalPolicy');
    expect(fake.requests('turn/start')[0]).not.toHaveProperty('sandboxPolicy');
    expect(current().mode).toBe('full-access');
  });

  it('a saved mode restored as it reads (Auto over Auto) binds: the resume keeps it over the thread\'s own sandbox', async () => {
    const { fake, engine, open, current } = setup((f) => { f.resumeSandbox = { type: 'dangerFullAccess' }; });
    expect((await open()).mode).toBe('auto');
    // main's restore() applies a saved Codex mode even when it equals the shown one.
    await engine.setMode(T, 'auto');
    await engine.send(T, 'hi', []);
    expect(fake.requests('turn/start')[0]).toMatchObject({
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    });
    expect(current().mode).toBe('auto');
    await fake.replay('turn-text.jsonl');
    // Later turns send no preset until the owner picks another mode.
    await engine.send(T, 'again', []);
    expect(fake.requests('turn/start')[1]).not.toHaveProperty('sandboxPolicy');
    expect(fake.requests('turn/start')[1]).not.toHaveProperty('approvalPolicy');
  });

  it('a chat opened read-only with a mode picked before the first send runs that mode', async () => {
    for (const [mode, approvalPolicy, type] of [['read-only', 'on-request', 'readOnly'], ['full-access', 'never', 'dangerFullAccess']] as const) {
      const { fake, engine, open, current } = setup();
      await open();
      await engine.setMode(T, mode);
      await engine.send(T, 'hi', []);
      expect(fake.requests('turn/start')[0]).toMatchObject({ approvalPolicy, sandboxPolicy: { type } });
      expect(current().mode).toBe(mode);
    }
  });

  it('a mode and model picked (or restored) while another app holds the chat are recorded, and go out once it is free', async () => {
    const { fake, engine, open, current } = setup((f) => f.lockedElsewhere.add(T));
    expect((await open()).owner).toBe('elsewhere');
    // restore() re-applies the owner's saved picks: recorded here, no resume, no error.
    await engine.setMode(T, 'read-only');
    await engine.setModel(T, 'demo-large');
    expect(current()).toMatchObject({ owner: 'elsewhere', mode: 'read-only', model: 'demo-large' });
    expect(fake.requests('thread/resume')).toEqual([]);
    // The Codex app lets go; the owner moves the chat here and sends.
    fake.lockedElsewhere.delete(T);
    await expect(engine.moveHere(T)).resolves.toBe(true);
    expect(current()).toMatchObject({ owner: 'here', mode: 'read-only', model: 'demo-large' });
    await engine.send(T, 'hi', []);
    expect(fake.requests('turn/start')[0]).toMatchObject({
      model: 'demo-large', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
  });

  it('a thread resumed eagerly (moveHere) shows its own sandbox and sends no preset until the owner changes it', async () => {
    const { fake, engine, open, current } = setup((f) => f.lockedElsewhere.add(T));
    await open();
    fake.lockedElsewhere.delete(T);
    await expect(engine.moveHere(T)).resolves.toBe(true);
    expect(current().mode).toBe('read-only');
    await engine.send(T, 'hi', []);
    expect(fake.requests('turn/start')[0]).not.toHaveProperty('sandboxPolicy');
    expect(current().mode).toBe('read-only');
  });

  it('a writer conflict queues the original draft and images exactly once', async () => {
    const { fake, engine, open, current, item } = setup();
    await open();
    fake.lockedElsewhere.add(T); // the Codex app opened it meanwhile
    const image = { mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' };
    await engine.send(T, 'hi', [image]);
    const queued = item('user', u => u.text === 'hi');
    expect(queued).toMatchObject({ queued: true, images: [image] });
    expect(fake.requests('thread/queue/add')).toEqual([{ threadId: T, clientUserMessageId: queued?.id,
      input: [textInput('hi'), { type: 'image', url: image.dataUrl }] }]);
    expect(current()).toMatchObject({ owner: 'elsewhere', banner: null });
    expect(fake.requests('turn/start')).toEqual([]);
  });

  it('reports a rejected queue submission without adding it to the thread', async () => {
    const { fake, engine, open, item } = setup(f => f.lockedElsewhere.add(T));
    fake.handlers['thread/queue/add'] = () => new RpcFailure(-32601, 'Method not found');
    await open();
    await expect(engine.send(T, 'keep my draft', [])).rejects.toThrow('cannot queue messages');
    expect(item('user', u => u.text === 'keep my draft')).toBeUndefined();
    expect(fake.requests('turn/start')).toEqual([]);
  });

  it('moveHere() that fails after its resume lets the thread go again', async () => {
    const { fake, engine, open, current } = setup((f) => f.lockedElsewhere.add(T), 60_000);
    await open();
    fake.lockedElsewhere.delete(T);
    fake.handlers['thread/turns/list'] = () => new RpcFailure(-32603, 'turns unavailable');
    await expect(engine.moveHere(T)).rejects.toThrow('turns unavailable');
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.requests('thread/unsubscribe')).toEqual([{ threadId: T }]);
    expect(current().owner).toBe('elsewhere');
  });

  it('send() passes model explicitly and streams item/agentMessage/delta into append ops', async () => {
    const { fake, engine, open, current, item, until, updates } = setup();
    await open();
    await engine.send(T, 'Say hello', []);
    expect(fake.requests('turn/start')).toEqual([
      expect.objectContaining({ threadId: T, model: 'demo-large', input: [textInput('Say hello')] }),
    ]);
    expect(current().turn).toBe('running');
    expect(item('user', (u) => u.text === 'Say hello')).toBeTruthy();

    await fake.replay('turn-text.jsonl');
    await until(() => current().turn === 'idle', 'turn idle');
    expect(updates).toContainEqual({ op: 'append', id: 'item-a9', field: 'text', chunk: 'Hel' });
    expect(updates).toContainEqual({ op: 'append', id: 'item-a9', field: 'text', chunk: 'lo' });
    expect(item('assistant', (a) => a.id === 'item-a9')).toMatchObject({ text: 'Hello', streaming: false, at: 1795000203000 });
    expect(item('reasoning', (r) => r.id === 'item-r9')).toMatchObject({ text: 'Greeting the owner.', streaming: false, durationMs: 1500 });
    // The server's userMessage carries our clientUserMessageId, so it replaces the local item.
    expect(current().items.filter((i) => i.kind === 'user' && i.text === 'Say hello')).toHaveLength(1);
  });

  describe('command approval → approval item pending, tool status waiting', () => {
    it.each<[ApprovalAnswer, unknown, string]>([
      ['allow', 'accept', 'allowed'],
      ['allowAlways', 'acceptForSession', 'allowedAlways'],
      ['deny', 'decline', 'denied'],
    ])('answering %s sends {decision:%j}', async (answer, decision, status) => {
      const { fake, engine, open, current, item, until } = setup();
      await open();
      await engine.send(T, 'Run the tests', []);
      const played = fake.replay('turn-approval.jsonl');
      await until(() => item('approval'), 'approval');
      const approval = item('approval')!;
      expect(approval).toMatchObject({ status: 'pending', toolItemId: 'exec-c9', title: 'Allow this command?', detail: 'npm test', alwaysLabel: 'this session' });
      expect(item('tool', (t) => t.id === 'exec-c9')?.status).toBe('waiting');
      expect(engine.busy()).toEqual([{ sessionId: T, reason: 'approval' }]);

      await engine.answerApproval(T, approval.id, answer);
      await played;
      expect(fake.replyTo(0)).toEqual({ id: 0, result: { decision } });
      expect(item('approval')?.status).toBe(status);
      await until(() => current().turn === 'idle', 'turn idle');
      expect(item('tool', (t) => t.id === 'exec-c9')).toMatchObject({ status: 'done', output: '1 passing\n', exitCode: 0 });
      expect(engine.busy()).toEqual([]);
    });

    it('without acceptForSession or decline: always = the execpolicy amendment, deny = cancel', async () => {
      const limited = (m: Msg): Msg => (m.method === 'item/commandExecution/requestApproval'
        ? { ...m, params: { ...m.params, availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } }, 'cancel'] } }
        : m);
      for (const [answer, decision] of [
        ['allowAlways', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } }],
        ['deny', 'cancel'],
      ] as const) {
        const { fake, engine, open, item, until } = setup();
        await open();
        await engine.send(T, 'Run the tests', []);
        const played = fake.replay('turn-approval.jsonl', limited);
        await until(() => item('approval'), 'approval');
        expect(item('approval')?.alwaysLabel).toBe('your Codex rules, permanently (not just this session): commands starting with `npm test`');
        await engine.answerApproval(T, item('approval')!.id, answer);
        await played;
        expect(fake.replyTo(0)).toEqual({ id: 0, result: { decision } });
      }
    });

    it('with neither offered, "Always allow" is hidden', async () => {
      const { fake, engine, open, item, until } = setup();
      await open();
      await engine.send(T, 'Run the tests', []);
      const played = fake.replay('turn-approval.jsonl', (m) =>
        (m.method === 'item/commandExecution/requestApproval' ? { ...m, params: { ...m.params, availableDecisions: ['accept', 'cancel'] } } : m));
      await until(() => item('approval'), 'approval');
      expect(item('approval')?.alwaysLabel).toBeNull();
      await expect(engine.answerApproval(T, item('approval')!.id, 'allowAlways')).rejects.toThrow();
      await engine.answerApproval(T, item('approval')!.id, 'allow');
      await played;
      expect(fake.replyTo(0)).toEqual({ id: 0, result: { decision: 'accept' } });
    });
  });

  it('requestUserInput → question item; answer sends {answers}', async () => {
    const { fake, engine, open, item, until } = setup();
    await open();
    await engine.send(T, 'Set up a database', []);
    const played = fake.replay('turn-question.jsonl');
    await until(() => item('question'), 'question');
    expect(engine.busy()).toEqual([{ sessionId: T, reason: 'question' }]);
    const q = item('question')!;
    expect(q).toMatchObject({
      status: 'pending', answers: null,
      questions: [{
        id: 'db', header: 'Database', text: 'Which database should the demo use?', multiSelect: false, allowOther: true,
        options: [{ label: 'SQLite', description: 'One file, nothing to run' }, { label: 'Postgres', description: 'Needs a server' }],
      }],
    });
    await engine.answerQuestion(T, q.id, { db: 'SQLite' });
    await played;
    expect(fake.replyTo(0)).toEqual({ id: 0, result: { answers: { db: { answers: ['SQLite'] } } } });
    expect(item('question')).toMatchObject({ status: 'answered', answers: { db: 'SQLite' } });
  });

  it('a secret question is flagged, and its answer goes to Codex but never into the thread', async () => {
    const { fake, engine, open, item, until } = setup();
    await open();
    await engine.send(T, 'Deploy it', []);
    const played = fake.replay('turn-question.jsonl', (m) => (m.method === 'item/tool/requestUserInput'
      ? { ...m, params: { ...m.params, questions: [{ ...m.params.questions[0], isSecret: true }] } }
      : m));
    await until(() => item('question'), 'question');
    const q = item('question')!;
    expect(q).toMatchObject({ questions: [{ id: 'db', isSecret: true }] });
    await engine.answerQuestion(T, q.id, { db: 'hunter2' });
    await played;
    expect(fake.replyTo(0)).toEqual({ id: 0, result: { answers: { db: { answers: ['hunter2'] } } } });
    expect(item('question')).toMatchObject({ status: 'answered', answers: { db: '' } });
  });

  it('interrupt sends turn/interrupt with the running turnId', async () => {
    const { fake, engine, open, item, until } = setup();
    await open();
    await engine.send(T, 'Run the tests', []);
    void fake.replay('turn-approval.jsonl');
    await until(() => item('approval'), 'approval');
    await engine.interrupt(T);
    expect(fake.requests('turn/interrupt')).toEqual([{ threadId: T, turnId: 'turn-a1' }]);
  });

  it.each([true, false])('a Stop pressed here is no interruption; an interrupt nobody asked for is (Stop pressed: %s)', async (manual) => {
    const { fake, engine, open, current, until } = setup();
    await open();
    await engine.send(T, 'Run', []);
    if (manual) await engine.interrupt(T);
    fake.write({ method: 'turn/completed', params: { threadId: T, turn: { id: 'turn-a1', status: 'interrupted', items: [], error: null } } });
    await until(() => current().turn === 'idle', 'turn idle');
    expect(engine.interruptions.get(T)?.kind).toBe(manual ? undefined : 'killed');
    // Continue: a new turn clears it.
    await engine.send(T, 'Continue', []);
    expect(engine.interruptions.has(T)).toBe(false);
  });

  it('a failed turn is an error interruption', async () => {
    const { fake, engine, open, current, until } = setup();
    await open();
    await engine.send(T, 'Hi', []);
    await fake.replay('turn-failed.jsonl');
    await until(() => current().turn === 'idle', 'turn idle');
    expect(engine.interruptions.get(T)).toMatchObject({ kind: 'error', reason: "The 'demo-old' model is not supported." });
  });

  it('send() while a turn runs → turn/steer with that turnId, and the user item appears at once', async () => {
    const { fake, engine, open, item } = setup();
    await open();
    await engine.send(T, 'Run the tests', []);
    await engine.send(T, 'Also run lint', []);
    expect(fake.requests('turn/start')).toHaveLength(1);
    expect(fake.requests('turn/steer')).toEqual([
      expect.objectContaining({ threadId: T, expectedTurnId: 'turn-a1', input: [textInput('Also run lint')] }),
    ]);
    expect(item('user', (u) => u.text === 'Also run lint')).toMatchObject({ at: NOW, images: [] });
  });

  it("images go as {type:'image', url: dataUrl}", async () => {
    const { fake, engine, open, item } = setup();
    await open();
    const image = { mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
    await engine.send(T, 'Look at this', [image]);
    expect(fake.requests('turn/start')[0].input).toEqual([textInput('Look at this'), { type: 'image', url: image.dataUrl }]);
    expect(item('user', (u) => u.text === 'Look at this')?.images).toEqual([image]);
  });

  it('turn/completed failed → error notice and turn idle', async () => {
    const { fake, engine, open, current, until } = setup();
    await open();
    await engine.send(T, 'Hi', []);
    await fake.replay('turn-failed.jsonl');
    await until(() => current().turn === 'idle', 'turn idle');
    const notices = current().items.filter((i) => i.kind === 'notice' && i.level === 'error');
    expect(notices).toEqual([expect.objectContaining({ text: "The 'demo-old' model is not supported." })]);
  });

  it('server exits mid-turn → error notice, pending approvals expired, next send respawns', async () => {
    const { fake, engine, open, current, item, until } = setup();
    await open();
    await engine.send(T, 'Run the tests', []);
    void fake.replay('turn-approval.jsonl');
    await until(() => item('approval'), 'approval');
    fake.crash(1);
    await until(() => current().turn === 'idle', 'turn idle');
    expect(item('approval')?.status).toBe('expired');
    expect(item('tool', (t) => t.id === 'exec-c9')?.status).toBe('failed');
    expect(item('notice', (n) => n.level === 'error')?.text).toMatch(/Codex stopped/);
    expect(current().owner).toBe('nobody');
    expect(engine.owned().has(T)).toBe(false);
    expect(engine.busy()).toEqual([]);
    await expect(engine.answerApproval(T, item('approval')!.id, 'allow')).rejects.toThrow();

    await engine.send(T, 'Try again', []);
    expect(fake.appServerSpawns).toBe(2);
    expect(fake.requests('thread/resume')).toHaveLength(2);
    expect(fake.requests('turn/start')).toHaveLength(2);
    expect(current()).toMatchObject({ owner: 'here', turn: 'running' });
  });

  it('model/list fills models, default isDefault', async () => {
    const { fake, engine, open, current, until } = setup((f) => {
      const resume = f.handlers['thread/resume']!;
      f.handlers['thread/resume'] = (p, me) => ({ ...(resume(p, me) as object), model: 'gpt-from-config' });
    });
    const state = await open();
    expect(state.models).toEqual([
      { id: 'demo-large', label: 'Demo Large', isDefault: false, efforts: ['low', 'high'], defaultEffort: 'low' },
      { id: 'demo-mini', label: 'Demo Mini', isDefault: true, efforts: ['medium', 'high'], defaultEffort: 'medium' },
    ]);
    // The thread's model is not one the server offers: use the default, never the config's.
    expect(state.model).toBe('demo-mini');
    await engine.send(T, 'Hi', []);
    expect(fake.requests('turn/start')[0].model).toBe('demo-mini');
    await engine.setModel(T, 'demo-large');
    await fake.replay('turn-text.jsonl');
    await until(() => current().turn === 'idle', 'turn idle');
    await engine.send(T, 'Again', []);
    expect(fake.requests('turn/start')[1].model).toBe('demo-large');
  });

  it('presets map to approvalPolicy and sandbox exactly; the one matching the config sends none', async () => {
    // The fake's config.toml sets neither, which matches Auto.
    for (const [mode, preset] of [
      ['read-only', { approvalPolicy: 'on-request', sandbox: 'read-only' }],
      [null, {}],
      ['auto', {}],
      ['full-access', { approvalPolicy: 'never', sandbox: 'danger-full-access' }],
    ] as const) {
      const { fake, engine } = setup();
      const id = await engine.start({ provider: 'codex', cwd: '/work/demo', model: null, effort: null, mode, text: 'Hi', images: [] });
      expect(id).toBe(T);
      expect(fake.requests('thread/start')).toEqual([{ cwd: '/work/demo', model: 'demo-mini', ...preset }]);
      expect(fake.requests('turn/start')).toEqual([expect.objectContaining({ threadId: T, model: 'demo-mini', input: [textInput('Hi')] })]);
      expect(engine.owned().has(T)).toBe(true);
    }
    const { fake, engine, open } = setup();
    const state = await open();
    expect(state.modes).toEqual([
      { id: 'read-only', label: 'Read only' }, { id: 'auto', label: 'Auto' }, { id: 'full-access', label: 'Full access' },
    ]);
    await engine.setMode(T, 'full-access');
    await engine.send(T, 'Hi', []);
    expect(fake.requests('turn/start')[0]).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    await expect(engine.setMode(T, 'untrusted')).rejects.toThrow();
  });

  it("a new chat follows the owner's config.toml: full access there is chosen here and started with no preset", async () => {
    const { fake, engine } = setup();
    fake.config = { sandbox_mode: 'danger-full-access', approval_policy: 'never' };
    expect((await engine.options()).mode).toBe('full-access');
    await engine.start({ provider: 'codex', cwd: '/work/demo', model: null, effort: null, mode: null, text: 'Hi', images: [] });
    expect(fake.requests('thread/start')).toEqual([{ cwd: '/work/demo', model: 'demo-mini' }]);
    expect(fake.requests('config/read')).toContainEqual({ cwd: '/work/demo' });
    const state = await engine.open(T, () => {});
    expect(state.mode).toBe('full-access');
  });

  it("the thinking level picked goes with the first turn/start and every one after; the config's level is the options' default", async () => {
    const { fake, engine } = setup();
    fake.config = { sandbox_mode: null, approval_policy: null, model_reasoning_effort: 'high' };
    expect((await engine.options()).effort).toBe('high');
    await engine.start({ provider: 'codex', cwd: '/work/demo', model: 'demo-large', effort: 'high', mode: null, text: 'Hi', images: [] });
    expect(fake.requests('turn/start')[0]).toMatchObject({ model: 'demo-large', effort: 'high' });
  });

  it('a preset picked against the config is sent: Auto over a full-access config asks again', async () => {
    const { fake, engine } = setup();
    fake.config = { sandbox_mode: 'danger-full-access', approval_policy: 'never' };
    await engine.start({ provider: 'codex', cwd: '/work/demo', model: null, effort: null, mode: 'auto', text: 'Hi', images: [] });
    expect(fake.requests('thread/start')).toEqual([{ cwd: '/work/demo', model: 'demo-mini', approvalPolicy: 'on-request', sandbox: 'workspace-write' }]);
  });

  it('a config that cannot be read leaves Auto chosen', async () => {
    const { fake, engine } = setup();
    delete fake.handlers['config/read'];
    expect((await engine.options()).mode).toBe('auto');
    expect((await engine.options()).model).toBe('demo-mini');
  });

  it("a new chat starts on config.toml's model when Codex lists it, not on Codex's own default", async () => {
    const { fake, engine } = setup();
    fake.config = { ...fake.config, model: 'demo-large' };
    expect((await engine.options()).model).toBe('demo-large');
    await engine.start({ provider: 'codex', cwd: '/work/demo', model: null, effort: null, mode: null, text: 'Hi', images: [] });
    expect(fake.requests('thread/start')).toEqual([{ cwd: '/work/demo', model: 'demo-large' }]);
    expect((await engine.open(T, () => {})).model).toBe('demo-large');
    // A model picked in the dialog still wins.
    const other = setup();
    other.fake.config = { ...other.fake.config, model: 'demo-large' };
    await other.engine.start({ provider: 'codex', cwd: '/work/demo', model: 'demo-mini', effort: null, mode: null, text: 'Hi', images: [] });
    expect(other.fake.requests('thread/start')).toEqual([{ cwd: '/work/demo', model: 'demo-mini' }]);
  });

  it("a config.toml model this Codex does not list is passed over for Codex's default", async () => {
    const { fake, engine } = setup();
    fake.config = { ...fake.config, model: 'gpt-from-a-newer-codex' };
    expect((await engine.options()).model).toBe('demo-mini');
    await engine.start({ provider: 'codex', cwd: '/work/demo', model: null, effort: null, mode: null, text: 'Hi', images: [] });
    expect(fake.requests('thread/start')).toEqual([{ cwd: '/work/demo', model: 'demo-mini' }]);
  });

  it("account() maps account/read + rateLimits/read: plan 'pro', windows from primary/secondary with windowDurationMins labels ('5 h', 'Weekly')", async () => {
    const { fake, engine } = setup();
    await expect(engine.account()).resolves.toEqual({
      provider: 'codex', signedIn: true, email: 'owner@example.com', plan: 'pro', note: null,
      windows: [
        { label: '5 h', usedPercent: 12, resetsAt: 1795003600000 },
        { label: 'Weekly', usedPercent: 40, resetsAt: 1795500000000 },
      ],
    });
    fake.rateLimits.rateLimits.primary = { usedPercent: 10, windowDurationMins: 10080, resetsAt: null };
    fake.rateLimits.rateLimits.secondary = null;
    expect((await engine.account()).windows).toEqual([{ label: 'Weekly', usedPercent: 10, resetsAt: null }]);
    fake.account = { account: null, requiresOpenaiAuth: true };
    await expect(engine.account()).resolves.toMatchObject({ signedIn: false, email: null, plan: null, windows: [], note: expect.stringContaining('codex login') });
  });

  it('reads the available reset count independently of permission to resume ordinary usage', async () => {
    const { fake, engine } = setup();
    fake.rateLimits.rateLimitResetCredits = { availableCount: 3, credits: [] };
    fake.rateLimits.ordinaryUsageAllowed = false;
    expect((await engine.account()).availableResets).toBe(3);
    expect(engine.usageAllowedAt).toBeNull();
    fake.rateLimits.rateLimitResetCredits = { availableCount: 0, credits: null };
    fake.rateLimits.ordinaryUsageAllowed = true;
    expect((await engine.account()).availableResets).toBe(0);
    expect(engine.usageAllowedAt).toBe(NOW);
    delete fake.rateLimits.ordinaryUsageAllowed;
    delete fake.rateLimits.rateLimitResetCredits;
    expect((await engine.account()).availableResets).toBeUndefined();
    expect(engine.usageAllowedAt).toBeNull();
  });

  it('options() before any chat: models from model/list (default isDefault), and the three presets with Auto first chosen', async () => {
    const { fake, engine } = setup();
    const options = await engine.options();
    expect(options).toEqual({
      models: [{ id: 'demo-large', label: 'Demo Large', isDefault: false, efforts: ['low', 'high'], defaultEffort: 'low' }, { id: 'demo-mini', label: 'Demo Mini', isDefault: true, efforts: ['medium', 'high'], defaultEffort: 'medium' }],
      model: 'demo-mini',
      effort: null,
      modes: [{ id: 'read-only', label: 'Read only' }, { id: 'auto', label: 'Auto' }, { id: 'full-access', label: 'Full access' }],
      mode: 'auto',
    });
    // Listed once: a second call reuses the list.
    await engine.options();
    expect(fake.requests('model/list')).toHaveLength(1);
    expect(fake.requests('thread/start')).toEqual([]);
  });

  it('account/rateLimits/updated fires onAccountChanged once, so an open profile page reads the usage again', async () => {
    const fake = new FakeAppServer();
    let hints = 0;
    const engine = new CodexEngine({ codexPath: '/fake/bin/codex', spawn: fake.spawn, now: () => NOW, onAccountChanged: () => { hints++; } });
    await engine.options();
    expect(hints).toBe(0);
    fake.write({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: null }, secondary: null } } });
    await new Promise((r) => setTimeout(r, 20));
    expect(hints).toBe(1);
    // Other notifications are not account changes.
    fake.write({ method: 'thread/name/updated', params: { threadId: T, threadName: 'x' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(hints).toBe(1);
    await engine.stop();
  });

  it('options() with codex missing rejects with "Codex not found"', async () => {
    await expect(new CodexEngine({ codexPath: null }).options()).rejects.toThrow('Codex not found');
  });

  it('missing codex → open() rejects and cards get banner "Codex not found"', async () => {
    const engine = new CodexEngine({ codexPath: null });
    await expect(engine.open(T, () => {})).rejects.toThrow('Codex not found');
    expect(engine.banner).toBe('Codex not found');
    await expect(engine.account()).resolves.toMatchObject({ signedIn: false, note: 'Codex not found' });

    // Found once, gone by the time it is started (spawn ENOENT): the same.
    const { engine: gone } = setup((f) => { f.missing = true; });
    await expect(gone.open(T, () => {})).rejects.toThrow('Codex not found');
    expect(gone.banner).toBe('Codex not found');
  });

  it('opens history and sends with a newer Codex release', async () => {
    const { engine, open, fake, current, hold } = setup((f) => { f.version = '0.171.0-alpha.13.2'; });
    expect((await open()).banner).toBeNull();
    await hold();
    expect(current().items.some((item) => item.kind === 'assistant')).toBe(true);
    expect(engine.banner).toBeNull();
    expect(fake.spawns).toEqual([['app-server']]);
    await engine.stop();
  });

  it('rediscovers Codex and the model catalog when a new server starts', async () => {
    const fake = new FakeAppServer();
    const spawn = vi.fn(fake.spawn);
    let installed = '/first/bin/codex';
    const resolveCodexPath = vi.fn(async () => installed);
    const engine = new CodexEngine({ codexPath: installed, resolveCodexPath, spawn });
    try {
      await engine.options();
      installed = '/updated/bin/codex';
      const before = await engine.options();
      expect(resolveCodexPath).toHaveBeenCalledTimes(1);
      fake.crash();
      await new Promise((resolve) => setImmediate(resolve));
      fake.models = [{ ...fake.models[0]!, id: 'updated-model', isDefault: true }];
      expect((await engine.options()).model).toBe('updated-model');
      expect(before.model).toBe('demo-mini');
      expect(spawn.mock.calls.map(([command]) => command)).toEqual(['/first/bin/codex', installed]);
    } finally {
      await engine.stop();
    }
  });

  it('an elsewhere chat re-reads history, and moveHere() resumes once it is free', async () => {
    const { fake, engine, open, current, item, until } = setup((f) => f.lockedElsewhere.add(T), 10);
    await open();
    const turns = fake.thread.turns as any[];
    fake.thread = { ...fake.thread, updatedAt: 1795000100, turns: [...turns, { ...turns[0], id: 'turn-new', items: [{ type: 'agentMessage', id: 'item-new', text: 'Written elsewhere', phase: 'final_answer', memoryCitation: null }] }] };
    await until(() => item('assistant', (a) => a.id === 'item-new'), 'polled item');

    await expect(engine.moveHere(T)).resolves.toBe(false);
    fake.lockedElsewhere.delete(T);
    await expect(engine.moveHere(T)).resolves.toBe(true);
    expect(current()).toMatchObject({ owner: 'here', banner: null });
    const reads = fake.requests('thread/read').length;
    await new Promise((r) => setTimeout(r, 40));
    expect(fake.requests('thread/read').length).toBe(reads);
  });

  describe('a read-only chat stays cheap while it is open', () => {
    const newTurn = (f: FakeAppServer) => {
      const turns = f.thread.turns as any[];
      f.thread = {
        ...f.thread, updatedAt: f.thread.updatedAt + 5,
        turns: [...turns, { ...turns[0], id: 'turn-new', items: [{ type: 'agentMessage', id: 'item-new', text: 'Written elsewhere', phase: 'final_answer', memoryCitation: null }] }],
      };
    };

    it('the poll issues no turn-bearing read when nothing changed', async () => {
      const { fake, open } = setup((f) => f.lockedElsewhere.add(T), 5);
      await open();
      const listed = fake.requests('thread/turns/list').length;
      await new Promise((r) => setTimeout(r, 60));
      expect(fake.requests('thread/read').length).toBeGreaterThan(3);
      expect(fake.requests('thread/read').every((p) => p.includeTurns === false)).toBe(true);
      expect(fake.requests('thread/turns/list')).toHaveLength(listed);
    });

    it('a change re-reads only the newest page', async () => {
      const { fake, open, item, until } = setup((f) => f.lockedElsewhere.add(T), 5);
      await open();
      const listed = fake.requests('thread/turns/list').length;
      newTurn(fake);
      await until(() => item('assistant', (a) => a.id === 'item-new'), 'polled item');
      await new Promise((r) => setTimeout(r, 40));
      const rereads = fake.requests('thread/turns/list').slice(listed);
      expect(rereads).toEqual([{ threadId: T, limit: 2, sortDirection: 'desc', itemsView: 'full' }]);
      expect(fake.requests('thread/read').every((p) => p.includeTurns === false)).toBe(true);
    });

    it('if the server will not list turns of a thread it does not hold: the whole thread once on open, again only on change', async () => {
      const { fake, open, item, until } = setup((f) => {
        f.lockedElsewhere.add(T);
        f.handlers['thread/turns/list'] = () => new RpcFailure(-32600, 'thread not loaded');
      }, 5);
      const state = await open();
      expect(state.items.map((i) => i.id)).toContain('item-a1');
      const whole = () => fake.requests('thread/read').filter((p) => p.includeTurns === true).length;
      expect(whole()).toBe(1);
      await new Promise((r) => setTimeout(r, 40));
      expect(whole()).toBe(1);
      newTurn(fake);
      await until(() => item('assistant', (a) => a.id === 'item-new'), 'polled item');
      expect(whole()).toBe(2);
    });
  });

  describe('images outside the shown page are never read', () => {
    afterEach(() => vi.restoreAllMocks());

    for (const where of ['here', 'elsewhere'] as const) {
      it(`(${where})`, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-img-'));
        const oldShot = path.join(dir, 'old.png');
        fs.writeFileSync(oldShot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        const stat = vi.spyOn(fsp, 'stat');
        const readFile = vi.spyOn(fsp, 'readFile');
        const touched = () => [...stat.mock.calls, ...readFile.mock.calls].some(([p]) => p === oldShot);
        const { engine, open, current } = setup((f) => {
          if (where === 'elsewhere') f.lockedElsewhere.add(T);
          f.thread = {
            ...f.thread,
            turns: Array.from({ length: 150 }, (_, n) => ({
              id: `turn-${n}`, itemsView: 'full', status: 'completed', error: null, startedAt: 1795000000 + n, completedAt: null, durationMs: null,
              items: [
                { type: 'userMessage', id: `u-${n}`, clientId: null, content: [{ type: 'text', text: `q${n}`, text_elements: [] }, ...(n === 60 ? [{ type: 'localImage', path: oldShot }] : [])] },
                { type: 'agentMessage', id: `c-${n}`, text: `c${n}`, phase: 'commentary', memoryCitation: null },
                { type: 'agentMessage', id: `a-${n}`, text: `a${n}`, phase: 'final_answer', memoryCitation: null },
              ],
            })),
          };
        });
        // Turns 50–149 are read (300 items) but only the newest 200 shown: turn 60 waits unshown.
        const state = await open();
        expect(state.items[0]?.id).toBe('c-83');
        expect(touched()).toBe(false);
        await engine.loadOlder(T);
        expect(touched()).toBe(true);
        expect(current().items.find((i) => i.id === 'u-60')).toMatchObject({ images: [{ dataUrl: 'data:image/png;base64,iVBORw==' }] });
        fs.rmSync(dir, { recursive: true, force: true });
      });
    }
  });

  it('history opens with the last 200 items and pages older', async () => {
    const { fake, engine, open, current } = setup((f) => {
      f.thread = {
        ...f.thread,
        turns: Array.from({ length: 150 }, (_, n) => ({
          id: `turn-${n}`, itemsView: 'full', status: 'completed', error: null, startedAt: 1795000000 + n, completedAt: null, durationMs: null,
          items: [
            { type: 'userMessage', id: `u-${n}`, clientId: null, content: [{ type: 'text', text: `q${n}`, text_elements: [] }] },
            { type: 'agentMessage', id: `a-${n}`, text: `a${n}`, phase: 'final_answer', memoryCitation: null },
          ],
        })),
      };
    });
    const state = await open();
    expect(state.items).toHaveLength(200);
    expect(state.items[0]?.id).toBe('u-50');
    expect(state.items.at(-1)?.id).toBe('a-149');
    expect(state.hasOlder).toBe(true);
    await engine.loadOlder(T);
    expect(current().items).toHaveLength(300);
    expect(current().items[0]?.id).toBe('u-0');
    expect(current().hasOlder).toBe(false);
    expect(fake.requests('thread/turns/list').every((p) => p.sortDirection === 'desc' && p.itemsView === 'full')).toBe(true);
  });

  it('history localImage files become data URLs (≤ 5 MB), else a notice', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-img-'));
    const small = path.join(dir, 'small.png');
    const big = path.join(dir, 'big.png');
    fs.writeFileSync(small, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1));
    const { open } = setup((f) => {
      const turn = f.thread.turns[0];
      turn.items[0].content = [
        { type: 'text', text: 'Two screenshots', text_elements: [] },
        { type: 'localImage', path: small },
        { type: 'localImage', path: big },
      ];
    });
    const state = await open();
    const user = state.items.find((i) => i.id === 'item-u1');
    expect(user).toMatchObject({ kind: 'user', images: [{ mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw==' }] });
    const at = state.items.findIndex((i) => i.id === 'item-u1');
    expect(state.items[at + 1]).toMatchObject({ kind: 'notice', level: 'warn', text: 'Image not shown (over 5 MB): big.png' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('close() of a chat only viewed sends nothing: it was never taken', async () => {
    const { fake, engine, open } = setup();
    await open();
    engine.close(T);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.requests('thread/resume')).toEqual([]);
    expect(fake.requests('thread/unsubscribe')).toEqual([]);
  });

  it('close() of an idle chat releases the thread; the engine never archives', async () => {
    const { fake, engine, open, until, hold } = setup();
    await open();
    await hold();
    engine.close(T);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.requests('thread/unsubscribe')).toEqual([{ threadId: T }]);
    // Still loaded (and still the writer) until the server unloads it, which it announces.
    expect(engine.owned().has(T)).toBe(true);
    fake.unload(T);
    await until(() => !engine.owned().has(T), 'owned() to drop the thread');
    await engine.stop();
    expect(fake.sent.some((m) => m.method === 'thread/archive')).toBe(false);
  });
  it("a hung app server (initialize never answered) → banner \"Codex didn't start\" and callers get an error; the next use tries again", async () => {
    const { fake, engine, open } = setup((f) => f.hangs.add('initialize'), 60_000, 30);
    await expect(engine.open(T, () => {})).rejects.toThrow("Codex didn't start");
    expect(engine.banner).toBe("Codex didn't start");
    await expect(engine.account()).resolves.toMatchObject({ signedIn: false, note: expect.stringContaining("Codex didn't start") });
    expect(fake.appServerSpawns).toBe(2);
    fake.hangs.clear();
    const state = await open();
    expect(state).toMatchObject({ owner: 'nobody', banner: null });
    expect(engine.banner).toBeNull();
  });

  it("a request the server never answers fails after the timeout with \"Codex didn't answer\" and sets the banner until it answers again", async () => {
    const fake = new FakeAppServer();
    fake.hangs.add('thread/read');
    const engine = new CodexEngine({ codexPath: '/fake/bin/codex', spawn: fake.spawn, now: () => NOW, requestTimeoutMs: 30 });
    await expect(engine.open(T, () => {})).rejects.toThrow("Codex didn't answer");
    expect(engine.banner).toBe("Codex didn't answer");
    fake.hangs.clear();
    await expect(engine.open(T, () => {})).resolves.toMatchObject({ owner: 'nobody' });
    expect(engine.banner).toBeNull();
    expect(fake.appServerSpawns).toBe(1);
    await engine.stop();
  });

  it('a thread let go here is "releasing" until the server unloads it', async () => {
    const { fake, engine, open, until, hold } = setup();
    await open();
    await hold();
    expect(engine.releasing().size).toBe(0);
    engine.close(T);
    await new Promise((r) => setTimeout(r, 10));
    expect(engine.owned().has(T)).toBe(true);
    expect(engine.releasing()).toEqual(new Set([T]));
    fake.unload(T);
    await until(() => !engine.owned().has(T), 'unload');
    expect(engine.releasing().size).toBe(0);
  });

  it('lost() releases the thread and queues messages until moveHere()', async () => {
    const { fake, engine, open, current, item, hold } = setup();
    await open();
    await hold();
    const started = fake.requests('turn/start').length;
    engine.lost(T);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.requests('thread/unsubscribe')).toEqual([{ threadId: T }]);
    expect(current()).toMatchObject({ owner: 'elsewhere', banner: null });
    await engine.send(T, 'hi', []);
    expect(fake.requests('thread/queue/add')).toHaveLength(1);
    expect(fake.requests('turn/start')).toHaveLength(started);
    await expect(engine.moveHere(T)).resolves.toBe(true);
    expect(current().owner).toBe('here');
  });
  describe('stopping (quit)', () => {
    it('stop() with a turn running and an approval pending leaves busy() empty and the chat idle', async () => {
      const { fake, engine, open, current, item, until } = setup();
      await open();
      await engine.send(T, 'Run the tests', []);
      void fake.replay('turn-approval.jsonl').catch(() => {});
      await until(() => item('approval'), 'approval');
      expect(engine.busy()).toEqual([{ sessionId: T, reason: 'approval' }]);
      await engine.stop();
      expect(engine.busy()).toEqual([]);
      expect(engine.owned().size).toBe(0);
      expect(current().turn).toBe('idle');
      expect(item('approval')?.status).toBe('expired');
      expect(fake.serverRunning).toBe(false);
    });

    it('after stop(), send, start and moveHere reject with "Agent canvas is quitting" and spawn nothing', async () => {
      const { fake, engine, open } = setup();
      await open();
      await engine.stop();
      const spawns = fake.appServerSpawns;
      await expect(engine.send(T, 'hi', [])).rejects.toThrow('Agent canvas is quitting');
      await expect(engine.start({ provider: 'codex', cwd: '/work/new', model: null, effort: null, mode: null, text: 'Hello', images: [] })).rejects.toThrow('Agent canvas is quitting');
      await expect(engine.moveHere(T)).rejects.toThrow('Agent canvas is quitting');
      expect(fake.appServerSpawns).toBe(spawns);
      expect(fake.requests('turn/start')).toEqual([]);
    });

    it('stop() during a launch still in flight ends that process too; nothing is left running', async () => {
      const { fake, engine } = setup((f) => f.hangs.add('initialize'), 60_000, 60_000);
      const opening = engine.open(T, () => {});
      opening.catch(() => {});
      await new Promise((r) => setTimeout(r, 10));
      expect(fake.appServerSpawns).toBe(1);
      expect(fake.serverRunning).toBe(true);
      await engine.stop();
      expect(fake.serverRunning).toBe(false);
      await expect(opening).rejects.toThrow();
      expect(engine.owned().size).toBe(0);
      expect(fake.appServerSpawns).toBe(1);
    });
  });
});
