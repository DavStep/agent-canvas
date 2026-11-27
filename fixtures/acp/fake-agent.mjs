#!/usr/bin/env node
// A tiny ACP agent for tests: newline-delimited JSON-RPC 2.0 over stdio, no SDK. What a prompt
// does depends on its words:
//   "wait"            streams a little, then waits until session/cancel (stop reason cancelled)
//   "read <abs path>" asks the client to read that file (fs/read_text_file) and says what it got
//   "write <name>"    writes <cwd>/<name> through the client (fs/write_text_file)
//   "limit when <abs path>" / "fail when <abs path>"
//                     streams a little, waits until that file exists, then ends with stop reason
//                     max_tokens, or fails the prompt with a usage-limit error
//   anything else     thinks, streams "Hello from the fake agent.", reads a file (a tool call),
//                     asks permission to run `echo fake-ok`, runs it in a client terminal when
//                     allowed (tool call failed when denied), posts a plan, and ends "Done."
// FAKE_ACP_NO_LOAD=1 makes it offer no session/load.
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
let nextId = 1;
const waiting = new Map();
const request = (method, params) => new Promise((resolve, reject) => {
  const id = `a${nextId++}`;
  waiting.set(id, { resolve, reject });
  out({ id, method, params });
});
const notify = (method, params) => out({ method, params });
const update = (sessionId, u) => notify('session/update', { sessionId, update: u });

const sessions = new Map(); // id → { cwd, history: [{role, text}], cancel: null | () => void, mode, model }
let n = 0;

const modes = (current) => ({ currentModeId: current, availableModes: [{ id: 'ask', name: 'Ask first' }, { id: 'auto', name: 'Auto' }] });
const config = (model) => [{
  id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
  options: [{ value: 'fake-fast', name: 'Fake Fast' }, { value: 'fake-smart', name: 'Fake Smart' }],
}];

async function prompt(sessionId, blocks) {
  const s = sessions.get(sessionId);
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  s.history.push({ role: 'user', text });
  const say = (t) => { update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } }); s.history.push({ role: 'agent', text: t }); };
  if (/\bwait\b/.test(text)) {
    say('Waiting…');
    await new Promise((resolve) => { s.cancel = resolve; });
    s.cancel = null;
    return 'cancelled';
  }
  const stop = /\b(limit|fail) when (\/\S+)/.exec(text);
  if (stop) {
    say('Working on it…');
    while (!existsSync(stop[2])) await new Promise((r) => setTimeout(r, 10));
    if (stop[1] === 'fail') throw new Error('Usage limit reached for this account');
    return 'max_tokens';
  }
  const read = /\bread (\/\S+)/.exec(text);
  if (read) {
    try {
      const r = await request('fs/read_text_file', { sessionId, path: read[1], limit: 1 });
      say(`Read: ${r.content}`);
    } catch (e) { say(`Could not read: ${e.message}`); }
    return 'end_turn';
  }
  const write = /\bwrite (\S+)/.exec(text);
  if (write) {
    await request('fs/write_text_file', { sessionId, path: path.join(s.cwd, write[1]), content: 'written by the fake agent\n' });
    say(`Wrote ${write[1]}`);
    return 'end_turn';
  }
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking it over.' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
  say('from the fake agent.');
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read README.md', kind: 'read', status: 'in_progress', locations: [{ path: path.join(s.cwd, 'README.md') }] });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '# Fake readme' } }] });
  update(sessionId, { sessionUpdate: 'plan', entries: [
    { content: 'Read the readme', priority: 'high', status: 'completed' },
    { content: 'Run the check', priority: 'high', status: 'in_progress' },
  ] });
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'run-1', title: '`echo fake-ok`', kind: 'execute', status: 'pending', rawInput: { command: 'echo fake-ok' } });
  const answer = await request('session/request_permission', {
    sessionId, toolCall: { toolCallId: 'run-1', title: '`echo fake-ok`', kind: 'execute', rawInput: { command: 'echo fake-ok' } },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  });
  if (answer.outcome.outcome === 'cancelled') return 'cancelled';
  if (answer.outcome.optionId === 'reject') {
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'run-1', status: 'failed' });
    say(' Not allowed, so I stopped.');
    return 'end_turn';
  }
  const { terminalId } = await request('terminal/create', { sessionId, command: 'echo', args: ['fake-ok'], cwd: s.cwd });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'run-1', status: 'in_progress', content: [{ type: 'terminal', terminalId }] });
  const exit = await request('terminal/wait_for_exit', { sessionId, terminalId });
  const output = await request('terminal/output', { sessionId, terminalId });
  await request('terminal/release', { sessionId, terminalId });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'run-1', status: exit.exitCode === 0 ? 'completed' : 'failed', rawOutput: { exit_code: exit.exitCode } });
  update(sessionId, { sessionUpdate: 'plan', entries: [
    { content: 'Read the readme', priority: 'high', status: 'completed' },
    { content: 'Run the check', priority: 'high', status: 'completed' },
  ] });
  update(sessionId, { sessionUpdate: 'usage_update', used: 1200, size: 200000 });
  say(` Done. The command printed ${output.output.trim()}.`);
  return 'end_turn';
}

const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: process.env.FAKE_ACP_NO_LOAD !== '1', promptCapabilities: { image: false } },
    agentInfo: { name: 'fake-agent', version: '1.0.0' }, authMethods: [],
  }),
  'session/new': ({ cwd }) => {
    const sessionId = `fake-${++n}`;
    sessions.set(sessionId, { cwd, history: [], cancel: null, mode: 'ask', model: 'fake-fast' });
    return { sessionId, modes: modes('ask'), configOptions: config('fake-fast') };
  },
  'session/load': ({ sessionId, cwd }) => {
    const s = sessions.get(sessionId) ?? { cwd, history: [{ role: 'user', text: 'An earlier question' }, { role: 'agent', text: 'An earlier answer' }], cancel: null, mode: 'ask', model: 'fake-fast' };
    sessions.set(sessionId, s);
    for (const h of s.history) {
      update(sessionId, { sessionUpdate: h.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: h.text } });
    }
    return { modes: modes(s.mode), configOptions: config(s.model) };
  },
  'session/set_mode': ({ sessionId, modeId }) => {
    sessions.get(sessionId).mode = modeId;
    update(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: modeId });
    return {};
  },
  'session/set_config_option': ({ sessionId, value }) => {
    sessions.get(sessionId).model = value;
    return { configOptions: config(value) };
  },
  'session/prompt': async ({ sessionId, prompt: blocks }) => ({
    stopReason: await prompt(sessionId, blocks),
    usage: { totalTokens: 1500, inputTokens: 1000, outputTokens: 400, thoughtTokens: 50, cachedReadTokens: 50 },
  }),
};

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (line.trim() === '') return;
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) w?.reject(new Error(msg.error.message)); else w?.resolve(msg.result);
    return;
  }
  if (msg.method === 'session/cancel') { sessions.get(msg.params.sessionId)?.cancel?.(); return; }
  if (msg.id === undefined) return;
  const handler = handlers[msg.method];
  if (!handler) { out({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }); return; }
  try {
    out({ id: msg.id, result: await handler(msg.params) });
  } catch (e) {
    out({ id: msg.id, error: { code: -32603, message: e.message } });
  }
});
