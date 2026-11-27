// JSON-RPC over a child's stdio, as `codex app-server` speaks it: one JSON object per line, no
// "jsonrpc" field, integer ids counting up from 1. Carries our requests, the server's
// notifications, and the server's own requests (approvals, questions), which we answer.
import readline from 'node:readline';

export interface RpcChild {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}

/** A request the server never answered (a wedged app server): later requests may still work. */
export class RpcTimeoutError extends Error {
  constructor(readonly method: string) {
    super("Codex didn't answer");
    this.name = 'RpcTimeoutError';
  }
}

/** How long a request may wait for its answer. Every request the app makes answers at once or
    within seconds (turn/start returns as the turn begins; the turn itself comes as notifications). */
export const REQUEST_TIMEOUT_MS = 60_000;

type Id = number | string;
interface Message { id?: Id; method?: string; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } }
type NotificationHandler = (params: any, method: string) => void;
type RequestHandler = (params: any, id: Id, method: string) => unknown;

const isObject = (v: unknown): v is Message => typeof v === 'object' && v !== null && !Array.isArray(v);

export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<Id, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null }>();
  private readonly healthHandlers: ((answering: boolean) => void)[] = [];
  private answering = true;
  private readonly timeoutMs: number | null;
  private readonly notificationHandlers = new Map<string, NotificationHandler[]>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly closeHandlers: ((reason: Error) => void)[] = [];
  private closeReason: Error | null = null;

  constructor(private readonly child: RpcChild, opts: { timeoutMs?: number | null } = {}) {
    this.timeoutMs = opts.timeoutMs === undefined ? REQUEST_TIMEOUT_MS : opts.timeoutMs;
    // A write after the child is gone fails with EPIPE; the exit handler reports it instead.
    child.stdin?.on('error', () => {});
    if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', (line) => this.receive(line));
    child.once('exit', (code, signal) => this.fail(new Error(`codex app-server exited (${signal ?? `code ${code}`})`)));
  }

  get closed(): boolean {
    return this.closeReason !== null;
  }

  /** `timeoutMs: null` lets a request wait for ever; by default it fails after the client's timeout. */
  request<T = unknown>(method: string, params?: unknown, opts: { timeoutMs?: number | null } = {}): Promise<T> {
    if (this.closeReason) return Promise.reject(this.closeReason);
    const id = this.nextId++;
    const ms = opts.timeoutMs === undefined ? this.timeoutMs : opts.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = ms === null ? null : setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.setAnswering(false);
        reject(new RpcTimeoutError(method));
      }, ms);
      timer?.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write(params === undefined ? { id, method } : { id, method, params });
    });
  }

  /** Told false when a request timed out, and true when the server answers again afterwards. */
  onHealth(fn: (answering: boolean) => void): void {
    this.healthHandlers.push(fn);
  }

  private setAnswering(value: boolean): void {
    if (this.answering === value) return;
    this.answering = value;
    for (const fn of this.healthHandlers) fn(value);
  }

  notify(method: string, params?: unknown): void {
    if (!this.closeReason) this.write(params === undefined ? { method } : { method, params });
  }

  /** `'*'` receives every notification. */
  onNotification(method: string, fn: NotificationHandler): void {
    this.notificationHandlers.set(method, [...(this.notificationHandlers.get(method) ?? []), fn]);
  }

  /** The handler's result (or promise of one) is the reply; `'*'` catches methods with no handler. */
  onRequest(method: string, fn: RequestHandler): void {
    this.requestHandlers.set(method, fn);
  }

  onClose(fn: (reason: Error) => void): void {
    this.closeHandlers.push(fn);
  }

  /** Stops reading and rejects whatever is still waiting; the caller ends the process. */
  close(reason = new Error('codex app-server closed')): void {
    this.fail(reason);
    this.child.stdin?.end();
  }

  private write(msg: Message): void {
    this.child.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  private fail(reason: Error): void {
    if (this.closeReason) return;
    this.closeReason = reason;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
    for (const fn of this.closeHandlers) fn(reason);
  }

  private receive(line: string): void {
    if (this.closeReason) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Not ours to understand (a stray log line); the next line may well be.
    }
    if (!isObject(msg)) return;
    if (typeof msg.method === 'string' && msg.id !== undefined) this.answer(msg.id, msg.method, msg.params);
    else if (typeof msg.method === 'string') this.dispatch(msg.method, msg.params);
    else if (msg.id !== undefined) this.settle(msg);
  }

  private dispatch(method: string, params: unknown): void {
    for (const fn of [...(this.notificationHandlers.get(method) ?? []), ...(this.notificationHandlers.get('*') ?? [])]) fn(params, method);
  }

  private settle(msg: Message): void {
    const waiter = this.pending.get(msg.id!);
    if (!waiter) return; // unknown, or answered after it timed out
    this.pending.delete(msg.id!);
    if (waiter.timer) clearTimeout(waiter.timer);
    this.setAnswering(true);
    if (msg.error) {
      const code = typeof msg.error.code === 'number' ? msg.error.code : -32603;
      waiter.reject(new RpcError(code, typeof msg.error.message === 'string' ? msg.error.message : 'error', msg.error.data));
    } else {
      waiter.resolve(msg.result);
    }
  }

  private answer(id: Id, method: string, params: unknown): void {
    const handler = this.requestHandlers.get(method) ?? this.requestHandlers.get('*');
    if (!handler) {
      this.write({ id, error: { code: -32601, message: `Agent canvas does not handle ${method}` } });
      return;
    }
    Promise.resolve()
      .then(() => handler(params, id, method))
      .then(
        (result) => {
          if (!this.closeReason) this.write({ id, result });
        },
        (err: unknown) => {
          if (this.closeReason) return;
          const code = err instanceof RpcError ? err.code : -32603;
          this.write({ id, error: { code, message: err instanceof Error ? err.message : String(err) } });
        },
      );
  }
}
