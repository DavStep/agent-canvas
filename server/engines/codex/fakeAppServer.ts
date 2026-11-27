// Test helper: a `spawn` stand-in that plays `codex app-server` over
// in-memory pipes. It answers client requests from a table, replays fixture turns line by line
// (pausing at each server request until the client answers it), and records what the client sent.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';

export type Msg = { id?: number | string; method?: string; params?: any; result?: any; error?: any };
type Handler = (params: any, fake: FakeAppServer) => unknown;

const FIXTURES = path.resolve(import.meta.dirname, '../../../fixtures/codex');

export const THREAD_ID = 'cccccccc-0000-4000-8000-0000000000a1';
export const TURN_ID = 'turn-a1';

export class RpcFailure {
  constructor(readonly code: number, readonly message: string) {}
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exited = false;
  constructor() {
    super();
    // Like the real server: end of stdin means the client is done.
    this.stdin.on('finish', () => this.exit(0));
  }
  kill(): boolean {
    this.exit(null, 'SIGTERM');
    return true;
  }
  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('exit', code, signal));
  }
}

const historyThread = (): any => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'thread-read-basic.json'), 'utf8')).thread;

/** The sandbox policy a thread/start reports for each sandbox mode. */
const SANDBOXES: Record<string, unknown> = {
  'read-only': { type: 'readOnly', networkAccess: false },
  'workspace-write': { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  'danger-full-access': { type: 'dangerFullAccess' },
};

export class FakeAppServer {
  /** Every message the client wrote, in order, across all app-server processes. */
  readonly sent: Msg[] = [];
  /** Argument lists of every spawn, e.g. ['app-server']. */
  readonly spawns: string[][] = [];
  version = '0.154.0';
  /** When set, spawning fails as if the program were missing. */
  missing = false;
  /** Requests with these methods are never answered, as by a hung (not exited) server. */
  readonly hangs = new Set<string>();
  /** The thread `thread/read` and `thread/turns/list` serve (thread-read-basic.json by default). */
  thread: any = { updatedAt: 1795000000, ...historyThread() };
  /** Threads that another process writes: `thread/resume` on them fails. */
  readonly lockedElsewhere = new Set<string>();
  /** The thread's own sandbox, as thread/resume reports it. */
  resumeSandbox: { type: 'readOnly'; networkAccess: boolean } | { type: 'dangerFullAccess' } = { type: 'readOnly', networkAccess: false };
  readonly loaded = new Set<string>();
  account: any = { account: { type: 'chatgpt', email: 'owner@example.com', planType: 'pro' }, requiresOpenaiAuth: true };
  rateLimits: any = {
    rateLimits: {
      limitId: 'codex', limitName: null, normalModelSlug: null,
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1795003600 },
      secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1795500000 },
      credits: { hasCredits: false, unlimited: false, balance: null }, planType: 'pro',
    },
    rateLimitsByLimitId: null,
  };
  models = [
    { id: 'demo-large', model: 'demo-large', displayName: 'Demo Large', isDefault: false, hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'low' },
    { id: 'demo-mini', model: 'demo-mini', displayName: 'Demo Mini', isDefault: true, hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'medium' },
  ];

  /** What config/read answers: the owner's config.toml. */
  config: { sandbox_mode: string | null; approval_policy: string | null; model?: string | null; model_reasoning_effort?: string | null } = { sandbox_mode: null, approval_policy: null, model: null };

  readonly handlers: Record<string, Handler> = {
    'config/read': () => ({ config: this.config, origins: {}, layers: null }),
    initialize: () => ({ userAgent: `agent-canvas/${this.version}`, codexHome: '/fake/.codex', platformFamily: 'unix', platformOs: 'macos' }),
    'model/list': () => ({ data: this.models, nextCursor: null }),
    'thread/loaded/list': () => ({ data: [...this.loaded], nextCursor: null }),
    'thread/resume': (p) => {
      if (this.lockedElsewhere.has(p.threadId)) return new RpcFailure(-32600, `thread ${p.threadId} already has an active writer`);
      this.loaded.add(p.threadId);
      return {
        thread: { ...this.thread, id: p.threadId, turns: [], status: { type: 'idle' } },
        model: 'demo-large', modelProvider: 'openai', serviceTier: null, cwd: this.thread.cwd, instructionSources: [],
        approvalPolicy: this.resumeSandbox.type === 'dangerFullAccess' ? 'never' : 'on-request', approvalsReviewer: 'user', sandbox: this.resumeSandbox,
        reasoningEffort: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null,
      };
    },
    'thread/read': (p) => ({ thread: { ...this.thread, id: p.threadId, status: { type: 'notLoaded' }, turns: p.includeTurns ? this.thread.turns : [] } }),
    'thread/turns/list': (p) => {
      const desc = [...this.thread.turns].reverse();
      const start = p.cursor ? Number(p.cursor) : 0;
      const end = start + (p.limit ?? 25);
      return { data: desc.slice(start, end), nextCursor: end < desc.length ? String(end) : null, backwardsCursor: null };
    },
    'thread/start': (p) => {
      this.loaded.add(THREAD_ID);
      return {
        thread: { ...this.thread, id: THREAD_ID, cwd: p.cwd, preview: '', name: null, turns: [], status: { type: 'idle' } },
        model: p.model, modelProvider: 'openai', serviceTier: null, cwd: p.cwd, instructionSources: [],
        approvalPolicy: p.approvalPolicy ?? this.config.approval_policy ?? 'on-request', approvalsReviewer: 'user',
        sandbox: SANDBOXES[p.sandbox ?? this.config.sandbox_mode ?? 'workspace-write'], reasoningEffort: null,
      };
    },
    // As live: the thread stays loaded (and its writer lock held) until the server unloads it
    // later; unload() plays that.
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
    'thread/queue/add': (p) => ({ queuedSubmission: { id: 'submission', clientUserMessageId: p.clientUserMessageId, input: p.input } }),
    'turn/start': () => ({ turn: { id: TURN_ID, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null } }),
    'turn/steer': (p) => ({ turnId: p.expectedTurnId }),
    'turn/interrupt': () => ({}),
    'account/read': () => this.account,
    'account/rateLimits/read': () => this.rateLimits,
  };

  private child: FakeChild | null = null;
  private readonly replies = new Map<string, (m: Msg) => void>();

  /** The `spawn` to hand to CodexEngine. */
  readonly spawn = (_command: string, args: readonly string[]): FakeChild => {
    this.spawns.push([...args]);
    const child = new FakeChild();
    if (this.missing) {
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })));
      return child;
    }
    this.child = child;
    readline.createInterface({ input: child.stdin }).on('line', (line) => this.receive(child, JSON.parse(line) as Msg));
    return child;
  };

  /** Whether the newest app-server process is still running. */
  get serverRunning(): boolean {
    return this.child !== null && !this.child.exited;
  }

  get appServerSpawns(): number {
    return this.spawns.filter((a) => a[0] === 'app-server').length;
  }

  /** Client requests with this method (params only). */
  requests(method: string): any[] {
    return this.sent.filter((m) => m.method === method && m.id !== undefined).map((m) => m.params);
  }

  /** The client's reply to the server request with this id. */
  replyTo(id: number | string): Msg | undefined {
    return this.sent.find((m) => m.id === id && m.method === undefined);
  }

  /** Writes one server message to the current process. */
  write(msg: Msg): void {
    if (!this.child || this.child.exited) throw new Error('no app server running');
    this.child.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  /** Plays a fixture: notifications go out in order; each server request waits for its reply.
      `__CLIENT_ID__` becomes the clientUserMessageId of the last turn/start or turn/steer. */
  async replay(name: string, transform: (m: Msg) => Msg = (m) => m): Promise<void> {
    const lines = fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter((l) => l.trim() !== '');
    for (const line of lines) {
      const clientId = [...this.sent].reverse().find((m) => m.method === 'turn/start' || m.method === 'turn/steer')?.params?.clientUserMessageId ?? null;
      const msg = transform(JSON.parse(line.replaceAll('"__CLIENT_ID__"', JSON.stringify(clientId))) as Msg);
      if (msg.id !== undefined && msg.method !== undefined) {
        const replied = new Promise<Msg>((resolve) => this.replies.set(String(msg.id), resolve));
        this.write(msg);
        await replied;
      } else {
        this.write(msg);
        await new Promise((r) => setImmediate(r));
      }
    }
  }

  /** The server unloads an unsubscribed thread (live: about 60 s after the last unsubscribe). */
  unload(threadId: string): void {
    this.loaded.delete(threadId);
    this.write({ method: 'thread/status/changed', params: { threadId, status: { type: 'notLoaded' } } });
    this.write({ method: 'thread/closed', params: { threadId } });
  }

  /** The app server dies, as in a crash. */
  crash(code = 1): void {
    this.child?.exit(code);
    this.loaded.clear();
  }

  private receive(child: FakeChild, msg: Msg): void {
    this.sent.push(msg);
    if (msg.method === undefined) {
      this.replies.get(String(msg.id))?.(msg);
      this.replies.delete(String(msg.id));
      return;
    }
    if (msg.id === undefined) return; // a notification such as `initialized`
    if (this.hangs.has(msg.method)) return;
    const handler = this.handlers[msg.method];
    const out = handler ? handler(msg.params, this) : new RpcFailure(-32601, `unknown method ${msg.method}`);
    const reply = out instanceof RpcFailure ? { id: msg.id, error: { code: out.code, message: out.message } } : { id: msg.id, result: out };
    if (!child.exited) child.stdout.write(`${JSON.stringify(reply)}\n`);
  }
}
