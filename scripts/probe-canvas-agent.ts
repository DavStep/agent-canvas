// `node --import tsx scripts/probe-canvas-agent.ts`: a live check of the canvas agent's query
// options against the real Agent SDK and Claude Code, outside the app. It runs one short session
// (no transcript is kept) with the `canvas` MCP server over a fake CanvasApi, and reports: whether
// "make a zone called Probe" calls create_zone without asking, and what an approval for
// start_task looks like (it is denied).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childEnv } from '../electron/paths.ts';
import { agentExtras } from '../server/agent/agent.ts';
import type { CanvasApi } from '../server/agent/tools.ts';
import { realSdk, type SDKMessage, type SDKUserMessage } from '../server/engines/claude/sdk.ts';
import { applyLayoutOp } from '../server/layoutOps.ts';
import type { Layout, LayoutOp } from '../shared/types.ts';

const TIMEOUT_MS = 180_000;
// A folder the canvas files under "No folder", so a running Agent canvas makes no zone for it.
const cwd = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-probe-')), 'scratch-workspaces', 'agent');
fs.mkdirSync(cwd, { recursive: true });

let layout: Layout = { version: 1, zones: [], assignments: {} };
const ops: LayoutOp[] = [];
const started: unknown[] = [];
const api: CanvasApi = {
  snapshot: () => ({ generatedAt: Date.now(), demo: false, sessions: [], layout, banners: { claude: null, codex: null } }),
  applyLayout: (op) => { ops.push(op); layout = applyLayoutOp(layout, op); },
  startSession: async (req) => { started.push(req); return 'probe-session'; },
  findFolders: async () => [],
  folderKind: async () => 'dir',
  openSession: () => {},
  keepAttachments: async () => [],
  now: Date.now,
};

const extras = agentExtras({ cwd, api })(cwd)!;

const prompts: SDKUserMessage[] = [];
const waiter: { wake: (() => void) | null } = { wake: null };
let done = false;
const queue: AsyncIterable<SDKUserMessage> = {
  async *[Symbol.asyncIterator]() {
    for (;;) {
      const next = prompts.shift();
      if (next) { yield next; continue; }
      if (done) return;
      await new Promise<void>((r) => { waiter.wake = r; });
    }
  },
};
const say = (text: string): void => {
  prompts.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  waiter.wake?.();
};

const asks: { toolName: string; title: string | undefined; input: unknown; mcpServer: unknown }[] = [];
const toolCalls: string[] = [];
let results = 0;

const q = realSdk.query({
  prompt: queue,
  options: {
    ...extras, cwd, env: childEnv(process.env), model: 'haiku', persistSession: false,
    canUseTool: async (toolName, input, o) => {
      asks.push({ toolName, title: o.title, input, mcpServer: o.mcpServer });
      return { behavior: 'deny', message: 'Denied by the probe' };
    },
  },
});

const timer = setTimeout(() => { console.error('timed out'); q.close(); process.exit(1); }, TIMEOUT_MS);
say('Make a zone called Probe.');
for await (const m of q as AsyncIterable<SDKMessage>) {
  if (m.type === 'system' && m.subtype === 'init') {
    console.log('init: mode', m.permissionMode, '| mcp servers', JSON.stringify(m.mcp_servers));
    console.log('canvas tools listed:', m.tools.filter((t) => t.startsWith('mcp__canvas__')).length);
  }
  if (m.type === 'assistant' && m.parent_tool_use_id === null) {
    for (const b of m.message.content) {
      if (b.type === 'tool_use') toolCalls.push(`${b.name} ${JSON.stringify(b.input)}`);
      if (b.type === 'text' && b.text.trim() !== '') console.log('assistant:', b.text.trim().slice(0, 300));
    }
  }
  if (m.type === 'result') {
    results++;
    console.log(`turn ${results}: ${m.subtype}`);
    if (results === 1) say(`Start a task in the folder ${cwd} with the prompt "say hi". Do not ask me anything first.`);
    else { done = true; waiter.wake?.(); q.close(); break; }
  }
}
clearTimeout(timer);

console.log('\ntool calls:', toolCalls);
console.log('layout ops applied:', JSON.stringify(ops));
console.log('approvals asked:', JSON.stringify(asks, null, 1));
console.log('sessions started (expected none: the probe denies):', started.length);
const zoneMade = ops.some((o) => o.type === 'createZone' && /probe/i.test(o.name));
const askedForZone = asks.some((a) => a.toolName === 'mcp__canvas__create_zone');
const askedForTask = asks.some((a) => a.toolName === 'mcp__canvas__start_task');
console.log(`\ncreate_zone ran without asking: ${zoneMade && !askedForZone}`);
console.log(`start_task asked the owner: ${askedForTask}`);
fs.rmSync(path.dirname(path.dirname(cwd)), { recursive: true, force: true });
process.exit(zoneMade && !askedForZone && askedForTask ? 0 : 1);
