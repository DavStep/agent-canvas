// The ACP engine against a real process speaking ACP over stdio: fixtures/acp/fake-agent.mjs.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AcpAgentConfig } from '../../../shared/acp.ts';
import type { ChatItem, ChatState, ChatUpdate } from '../../../shared/chat.ts';
import { applyUpdate } from '../chatLog.ts';
import { AcpEngine, type AcpTurnUsage, type AcpUsage } from './engine.ts';
import { AcpRecords } from './records.ts';

const STUB = fileURLToPath(new URL('../../../fixtures/acp/fake-agent.mjs', import.meta.url));
const agent = (env: Record<string, string> = {}): AcpAgentConfig =>
  ({ id: 'fake', name: 'Fake Agent', command: process.execPath, args: [STUB], env, icon: 'agent' });

let dir: string;
let engine: AcpEngine;
let usage: AcpUsage[];
let turns: AcpTurnUsage[];
let changes: number;

async function make(env: Record<string, string> = {}, records?: AcpRecords): Promise<AcpEngine> {
  usage = [];
  turns = [];
  changes = 0;
  engine = new AcpEngine({
    agents: () => [agent(env)], resolve: async (a) => a.command, env: { PATH: process.env.PATH ?? '' },
    records: records ?? await AcpRecords.load(null), onUsage: (u) => usage.push(u), onTurnUsage: (u) => turns.push(u), onChange: () => { changes++; },
    shell: '/bin/sh', idleMs: 60_000,
  });
  return engine;
}

/** Follows one chat as the page does: the state kept current from the updates. */
async function watch(e: AcpEngine, id: string): Promise<{ state: () => ChatState }> {
  let state: ChatState | null = null;
  const queued: ChatUpdate[] = [];
  const s = await e.open(id, (u) => { if (state) state = applyUpdate(state, u); else queued.push(u); });
  state = queued.reduce(applyUpdate, s);
  return { state: () => state! };
}

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const kinds = (items: ChatItem[]) => items.map((i) => i.kind);

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'acp-engine-')));
  await fs.writeFile(path.join(dir, 'README.md'), '# Fake readme\n');
});
afterEach(async () => {
  await engine?.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

const start = (e: AcpEngine, text: string) =>
  e.start({ provider: 'acp', agent: 'fake', cwd: dir, model: null, effort: null, mode: null, text, images: [] });

describe('AcpEngine with a stdio ACP agent', () => {
  it('streams a turn: thought, message, tool calls, plan; a permission card runs a client terminal when allowed', async () => {
    const e = await make();
    const id = await start(e, 'Check the project');
    const chat = await watch(e, id);
    await until(() => chat.state().items.some((i) => i.kind === 'approval'));
    expect(e.busy()).toEqual([{ sessionId: id, reason: 'approval' }]);
    const card = e.views().find((v) => v.id === `acp:${id}`)!;
    expect(card).toMatchObject({ provider: 'acp', state: 'needs_you', need: 'permission', owner: 'here', acp: { id: 'fake', name: 'Fake Agent', icon: 'agent' } });
    const approval = chat.state().items.find((i) => i.kind === 'approval')!;
    expect(approval).toMatchObject({ title: 'Allow this command?', toolItemId: 'tool-run-1', status: 'pending' });
    expect(chat.state().items.find((i) => i.id === 'tool-run-1')).toMatchObject({ status: 'waiting', tool: 'command', target: 'echo fake-ok' });

    await e.answerApproval(id, approval.id, 'allow');
    await until(() => chat.state().turn === 'idle');
    const items = chat.state().items;
    expect(kinds(items)).toEqual(['user', 'reasoning', 'assistant', 'tool', 'tool', 'approval', 'assistant']);
    expect(items[2]).toMatchObject({ kind: 'assistant', text: 'Hello from the fake agent.', streaming: false });
    expect(items[1]).toMatchObject({ kind: 'reasoning', text: 'Thinking it over.', streaming: false });
    expect(items[3]).toMatchObject({ kind: 'tool', tool: 'read', status: 'done', output: '# Fake readme', action: { name: 'Read', target: 'README.md' } });
    expect(items[4]).toMatchObject({ kind: 'tool', tool: 'command', status: 'done', exitCode: 0 });
    expect((items[4] as Extract<ChatItem, { kind: 'tool' }>).output).toContain('fake-ok');
    expect(items[5]).toMatchObject({ status: 'allowed' });
    expect(items[6]).toMatchObject({ kind: 'assistant', text: ' Done. The command printed fake-ok.' });
    expect(chat.state().plan).toEqual([{ step: 'Read the readme', status: 'completed' }, { step: 'Run the check', status: 'completed' }]);
    expect(chat.state().modes.map((m) => m.id)).toEqual(['ask', 'auto']);
    expect(chat.state().models.map((m) => m.id)).toEqual(['fake-fast', 'fake-smart']);
    expect(usage).toMatchObject([{ sessionId: id, agent: 'fake', used: 1200, size: 200000 }]);
    expect(turns).toMatchObject([{ sessionId: id, agent: 'fake', cwd: dir, model: 'fake-fast', turn: items[0]!.id, input: 1000, output: 450, cacheRead: 50, cacheWrite: 0 }]);
    expect(e.views()[0]).toMatchObject({ state: 'idle', lastPrompt: 'Check the project', lastAnswer: ' Done. The command printed fake-ok.' });
    expect(changes).toBeGreaterThan(0);
  });

  it('a denied permission fails the tool; Stop answers a waiting permission cancelled and ends the turn', async () => {
    const e = await make();
    const id = await start(e, 'Check');
    const chat = await watch(e, id);
    await until(() => chat.state().items.some((i) => i.kind === 'approval'));
    const first = chat.state().items.find((i) => i.kind === 'approval')!;
    await e.answerApproval(id, first.id, 'deny');
    await until(() => chat.state().turn === 'idle');
    expect(chat.state().items.find((i) => i.id === 'tool-run-1')).toMatchObject({ status: 'denied' });

    await e.send(id, 'Again', []);
    await until(() => chat.state().items.filter((i) => i.kind === 'approval').length === 2);
    await e.interrupt(id);
    await until(() => chat.state().turn === 'idle');
    const items = chat.state().items;
    expect(items.filter((i) => i.kind === 'approval').at(-1)).toMatchObject({ status: 'expired' });
    expect(items.at(-1)).toMatchObject({ kind: 'notice', text: 'Stopped' });
    expect(e.busy()).toEqual([]);
  });

  it('a message during a turn is queued and goes out when the turn ends; modes and models are set over ACP', async () => {
    const e = await make();
    const id = await start(e, 'wait');
    const chat = await watch(e, id);
    await until(() => chat.state().items.some((i) => i.kind === 'assistant'));
    await e.send(id, 'read /nonexistent-for-sure', []);
    expect(chat.state().items.at(-1)).toMatchObject({ kind: 'user', queued: true });
    await e.setMode(id, 'auto');
    expect(chat.state().mode).toBe('auto');
    await e.setModel(id, 'fake-smart');
    expect(chat.state().model).toBe('fake-smart');
    await e.interrupt(id);
    await until(() => chat.state().items.some((i) => i.kind === 'approval'));
    // The queued message reads a path outside the folder: the owner is asked first.
    const ask = chat.state().items.filter((i) => i.kind === 'approval').at(-1)!;
    expect(ask).toMatchObject({ title: 'Allow Fake Agent to read a file outside the project folder?' });
    await e.answerApproval(id, ask.id, 'deny');
    await until(() => chat.state().turn === 'idle' && chat.state().items.at(-1)?.kind === 'assistant');
    expect(chat.state().items.at(-1)).toMatchObject({ kind: 'assistant', text: expect.stringContaining('Could not read: The owner did not allow reading') });
    expect((await e.options('fake')).modes.map((m) => m.id)).toEqual(['ask', 'auto']);
  });

  it('a turn cut off by a limit or an error sends no queued message: it is held, the chat says so, the card is interrupted', async () => {
    const e = await make();
    const gate = path.join(dir, 'gate-1');
    const id = await start(e, `limit when ${gate}`);
    const chat = await watch(e, id);
    await until(() => chat.state().items.some((i) => i.kind === 'assistant'));
    await e.send(id, 'write queued.txt', []);
    expect(chat.state().items.at(-1)).toMatchObject({ kind: 'user', queued: true });
    await fs.writeFile(gate, '');
    await until(() => chat.state().turn === 'idle');
    // Give a wrongly dispatched message time to reach the agent.
    await new Promise((r) => setTimeout(r, 200));
    expect(chat.state().turn).toBe('idle');
    await expect(fs.access(path.join(dir, 'queued.txt'))).rejects.toThrow();
    const tail = chat.state().items.slice(-3);
    expect(tail[0]).toMatchObject({ kind: 'user', text: 'write queued.txt', queued: false });
    expect(tail[1]).toMatchObject({ kind: 'notice', level: 'warn', text: 'Fake Agent stopped: the reply reached its length limit.' });
    expect(tail[2]).toMatchObject({ kind: 'notice', level: 'warn', text: 'Your queued message was not sent. Send again when you are ready.' });
    expect(e.interruptions.get(id)).toMatchObject({ kind: 'limit', reason: 'Fake Agent stopped: the reply reached its length limit.' });

    // An error ending the prompt (a usage limit the agent names) holds the queue the same way.
    const gate2 = path.join(dir, 'gate-2');
    await e.send(id, `fail when ${gate2}`, []);
    expect(e.interruptions.has(id)).toBe(false);
    await until(() => chat.state().turn === 'running' && chat.state().items.at(-1)?.kind === 'assistant');
    await e.send(id, 'write queued2.txt', []);
    await e.send(id, 'write queued3.txt', []);
    await fs.writeFile(gate2, '');
    await until(() => chat.state().turn === 'idle');
    await new Promise((r) => setTimeout(r, 200));
    await expect(fs.access(path.join(dir, 'queued2.txt'))).rejects.toThrow();
    const notices = chat.state().items.filter((i) => i.kind === 'notice').slice(-2);
    expect(notices[0]).toMatchObject({ level: 'error', text: expect.stringContaining('Usage limit reached') });
    expect(notices[1]).toMatchObject({ text: 'Your 2 queued messages were not sent. Send again when you are ready.' });
    expect(e.interruptions.get(id)).toMatchObject({ kind: 'limit', reason: expect.stringContaining('Usage limit reached') });
    expect(chat.state().items.filter((i) => i.kind === 'user' && i.queued)).toEqual([]);

    // Sending again goes out at once, and the interruption clears.
    await e.send(id, 'write again.txt', []);
    await until(() => chat.state().turn === 'idle' && chat.state().items.at(-1)?.kind === 'assistant');
    expect(chat.state().items.at(-1)).toMatchObject({ text: 'Wrote again.txt' });
    expect(e.interruptions.has(id)).toBe(false);
  });

  it('the agent crashing mid-turn holds a queued message too, after saying it stopped', async () => {
    const e = await make();
    const id = await start(e, 'wait');
    const chat = await watch(e, id);
    await until(() => chat.state().items.some((i) => i.kind === 'assistant'));
    await e.send(id, 'wait', []);
    const { execSync } = await import('node:child_process');
    execSync(`pkill -f ${JSON.stringify(STUB)}`);
    await until(() => chat.state().owner === 'nobody');
    const tail = chat.state().items.slice(-2);
    expect(tail[0]).toMatchObject({ kind: 'notice', level: 'error', text: expect.stringContaining('stopped unexpectedly') });
    expect(tail[1]).toMatchObject({ kind: 'notice', text: 'Your queued message was not sent. Send again when you are ready.' });
    expect(e.interruptions.get(id)).toMatchObject({ kind: 'killed' });
  });

  it('fs requests inside the folder need no approval, through a symlink out they do', async () => {
    const e = await make();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret\n');
    await fs.symlink(outside, path.join(dir, 'link'));
    const id = await start(e, 'write notes.txt');
    const chat = await watch(e, id);
    await until(() => chat.state().turn === 'idle');
    expect(await fs.readFile(path.join(dir, 'notes.txt'), 'utf8')).toBe('written by the fake agent\n');
    expect(chat.state().items.some((i) => i.kind === 'approval')).toBe(false);
    await e.send(id, `read ${path.join(dir, 'link', 'secret.txt')}`, []);
    await until(() => chat.state().items.some((i) => i.kind === 'approval'));
    const ask = chat.state().items.find((i) => i.kind === 'approval')!;
    expect(ask.kind === 'approval' && ask.detail).toContain(await fs.realpath(path.join(outside, 'secret.txt')));
    await e.answerApproval(id, ask.id, 'allow');
    await until(() => chat.state().turn === 'idle');
    expect(chat.state().items.at(-1)).toMatchObject({ kind: 'assistant', text: 'Read: secret' });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('a past session loads its history into the chat; an agent without session/load opens read-only and says so', async () => {
    const records = await AcpRecords.load(null);
    const e = await make({}, records);
    const id = await start(e, 'write a.txt');
    const chat = await watch(e, id);
    await until(() => chat.state().turn === 'idle');
    await e.stop();

    // The app again: a new engine over the same records loads the session from the agent.
    const again = await make({}, records);
    expect(again.views()[0]).toMatchObject({ id: `acp:${id}`, owner: 'nobody', state: 'idle' });
    const reopened = await watch(again, id);
    expect(kinds(reopened.state().items)).toEqual(['user', 'assistant']);
    expect(reopened.state()).toMatchObject({ owner: 'here', banner: null });
    await again.stop();

    const noLoad = await make({ FAKE_ACP_NO_LOAD: '1' }, records);
    const ro = await watch(noLoad, id);
    expect(ro.state()).toMatchObject({ owner: 'nobody', banner: expect.stringContaining("Fake Agent can't reopen past conversations") });
    await expect(noLoad.send(id, 'hello', [])).rejects.toThrow("can't reopen past conversations");
  });

  it('a session reopened after a relaunch keeps the mode picked for it, not the agent\'s default', async () => {
    const records = await AcpRecords.load(null);
    const e = await make({}, records);
    const id = await start(e, 'write a.txt');
    const chat = await watch(e, id);
    await until(() => chat.state().turn === 'idle');
    await e.setMode(id, 'auto');
    await e.stop();
    // The new process loads it in its own default (ask); the picked Auto is put back.
    const again = await make({}, records);
    const reopened = await watch(again, id);
    await until(() => reopened.state().owner === 'here');
    expect(reopened.state().mode).toBe('auto');
  });

  it('an agent hidden from New session starts nothing new, while its existing sessions still render, open and continue', async () => {
    let config: AcpAgentConfig = { ...agent(), id: 'claude-acp', name: 'Claude Code (ACP)', icon: 'claude', showInNewSession: true };
    const e = new AcpEngine({
      agents: () => [config], resolve: async (a) => a.command, env: { PATH: process.env.PATH ?? '' },
      records: await AcpRecords.load(null), shell: '/bin/sh', idleMs: 60_000,
    });
    engine = e;
    const id = await e.start({ provider: 'acp', agent: 'claude-acp', cwd: dir, model: null, effort: null, mode: null, text: 'write a.txt', images: [] });
    const chat = await watch(e, id);
    await until(() => chat.state().turn === 'idle');

    config = { ...config, showInNewSession: undefined }; // the Claude adapter's default: hidden
    await expect(e.start({ provider: 'acp', agent: 'claude-acp', cwd: dir, model: null, effort: null, mode: null, text: 'hi', images: [] }))
      .rejects.toThrow('Claude Code (ACP) is hidden from New session. Turn on "Show in New session"');
    expect(e.views()).toMatchObject([{ id: `acp:${id}`, provider: 'acp', acp: { id: 'claude-acp', name: 'Claude Code (ACP)', icon: 'claude' } }]);
    await e.send(id, 'write b.txt', []);
    await until(() => chat.state().turn === 'idle' && chat.state().items.at(-1)?.kind === 'assistant');
    expect(chat.state().items.at(-1)).toMatchObject({ text: 'Wrote b.txt' });
  });

  it('a missing command says it is not installed; an unknown agent is refused', async () => {
    const e = new AcpEngine({ agents: () => [agent()], resolve: async () => null, env: {}, records: await AcpRecords.load(null) });
    engine = e;
    await expect(start(e, 'hi')).rejects.toThrow('Fake Agent is not installed');
    await expect(e.start({ provider: 'acp', agent: 'nope', cwd: dir, model: null, effort: null, mode: null, text: 'hi', images: [] }))
      .rejects.toThrow('No ACP agent "nope" in Settings');
  });

  it('the agent dying mid-turn fails what ran, says so, and the next message starts it again', async () => {
    const e = await make();
    const id = await start(e, 'wait');
    const chat = await watch(e, id);
    await until(() => chat.state().items.some((i) => i.kind === 'assistant'));
    // The fake agent is the only child process of this test with the stub's path.
    const { execSync } = await import('node:child_process');
    execSync(`pkill -f ${JSON.stringify(STUB)}`);
    await until(() => chat.state().turn === 'idle' && chat.state().owner === 'nobody');
    expect(chat.state().items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: expect.stringContaining('Fake Agent stopped unexpectedly') });
    await e.send(id, 'write b.txt', []);
    await until(() => chat.state().turn === 'idle' && chat.state().items.at(-1)?.kind === 'assistant');
    expect(chat.state().items.at(-1)).toMatchObject({ text: 'Wrote b.txt' });
  });
});
