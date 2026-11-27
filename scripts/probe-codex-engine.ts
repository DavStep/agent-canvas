// `node --import tsx scripts/probe-codex-engine.ts`: a live check of CodexEngine against the
// installed `codex`. It starts one read-only thread in the probe folder, sends "Reply with ok",
// denies anything it is asked, prints what the chat holds, checks how a second app server sees
// the thread while the first holds it (metadata reads, thread/turns/list, read-only chat), whether
// close() lets go of the writer lock, then archives its own probe thread. It touches no other thread.
import type { ChatState, ChatUpdate } from '../shared/chat.ts';
import { findCodex } from '../electron/paths.ts';
import { applyUpdate } from '../server/engines/chatLog.ts';
import { CodexEngine } from '../server/engines/codex/engine.ts';
import { CodexServer, defaultSpawn } from '../server/engines/codex/server.ts';
import { RpcError } from '../server/engines/codex/rpc.ts';
import type { ThreadReadResponse } from '../server/engines/codex/protocol/v2/ThreadReadResponse.ts';
import type { ThreadTurnsListResponse } from '../server/engines/codex/protocol/v2/ThreadTurnsListResponse.ts';

const PROBE_DIR = '/private/tmp/claude-501/agent-canvas-probes';
const TIMEOUT_MS = 120_000;

const codexPath = await findCodex();
console.log('codex:', codexPath);
if (!codexPath) process.exit(1);

async function until(what: string, cond: () => boolean): Promise<void> {
  const end = Date.now() + TIMEOUT_MS;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const kinds = (s: ChatState) => s.items.map((i) => (i.kind === 'notice' ? `notice(${i.level}: ${i.text})` : i.kind)).join(', ');

const a = new CodexEngine({ codexPath });
const b = new CodexEngine({ codexPath });
// A third, raw app server for observations the engines do not print.
const c = new CodexServer({ codexPath, spawn: defaultSpawn, setup: () => {}, onExit: () => {} });
const crpc = await c.client();
const rpcError = (e: unknown) => (e instanceof RpcError ? `error ${e.code}: ${e.message}` : `error: ${String(e)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let threadId: string | null = null;
try {
  threadId = await a.start({ provider: 'codex', cwd: PROBE_DIR, model: null, effort: null, mode: 'read-only', text: 'Reply with ok', images: [] });
  console.log('thread:', threadId, '| owned here:', a.owned().has(threadId), '| banner:', a.banner);
  // What a cheap metadata read shows while another process writes the thread.
  const watched: string[] = [];
  const watcher = setInterval(() => {
    void crpc.request<ThreadReadResponse>('thread/read', { threadId, includeTurns: false }).then(
      ({ thread }) => watched.push(`updatedAt=${thread.updatedAt} status=${thread.status.type}`),
      (e) => watched.push(rpcError(e)),
    );
  }, 250);
  let state: ChatState | null = null;
  let sawRunning = false;
  const emit = (u: ChatUpdate) => {
    if (!state) return;
    state = applyUpdate(state, u);
    sawRunning ||= state.turn === 'running';
    // Accept nothing: any approval or question is turned down.
    const id = threadId!;
    for (const i of state.items) {
      if (i.kind === 'approval' && i.status === 'pending') void a.answerApproval(id, i.id, 'deny').catch(() => {});
    }
  };
  state = await a.open(threadId, emit);
  sawRunning ||= state.turn === 'running';
  console.log('A open:', { owner: state.owner, model: state.model, mode: state.mode, turn: state.turn });
  await until('turn idle', () => state!.turn === 'idle' && (sawRunning || state!.items.some((i) => i.kind === 'assistant')));
  await sleep(1500);
  clearInterval(watcher);
  const answer = state!.items.find((i) => i.kind === 'assistant');
  console.log('A final kinds:', kinds(state!), '| turn:', state!.turn, '| assistant:', JSON.stringify(answer?.kind === 'assistant' ? answer.text : null));
  console.log('C thread/read (no turns) during and after the turn:', watched.filter((w, n) => w !== watched[n - 1]));

  // Can a second server list turns of a thread another process holds?
  try {
    const listed = await crpc.request<ThreadTurnsListResponse>('thread/turns/list', { threadId, limit: 2, sortDirection: 'desc', itemsView: 'full' });
    console.log('C thread/turns/list while A holds it: ok,', listed.data.map((t) => `${t.status}[${t.items.map((i) => i.type).join(',')}]`).join(' '));
  } catch (e) {
    console.log('C thread/turns/list while A holds it:', rpcError(e));
  }

  // A second engine: the thread is held by A, so B sees it read-only.
  const elsewhere = await b.open(threadId, () => {});
  console.log('B open:', { owner: elsewhere.owner, banner: elsewhere.banner, kinds: kinds(elsewhere) });
  console.log('B moveHere while A holds it:', await b.moveHere(threadId));

  // Does close() (thread/unsubscribe) let go of the writer lock while A's server keeps running?
  // (An earlier run saw -32600 one second after close(); an empty thread unloaded ~60 s after its
  // unsubscribe.) Try every 5 s for up to 90 s.
  a.close(threadId);
  const closedAt = Date.now();
  let resumed = false;
  while (!resumed && Date.now() - closedAt < 90_000) {
    await sleep(5000);
    const at = `${((Date.now() - closedAt) / 1000).toFixed(0)} s after close()`;
    try {
      await crpc.request('thread/resume', { threadId, excludeTurns: true });
      resumed = true;
      console.log(`C thread/resume ${at}: ok | A owned(): ${a.owned().has(threadId)}`);
    } catch (e) {
      console.log(`C thread/resume ${at}: ${rpcError(e)} | A owned(): ${a.owned().has(threadId)}`);
    }
  }
  if (resumed) console.log('B moveHere while C holds it:', await b.moveHere(threadId));
} finally {
  await a.stop();
  await b.stop();
  if (threadId) {
    // The engine never archives; this probe cleans up the one thread it created.
    console.log('archive:', JSON.stringify(await crpc.request('thread/archive', { threadId })));
  }
  await c.stop();
}
