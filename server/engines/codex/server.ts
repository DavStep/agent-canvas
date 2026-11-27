// The one `codex app-server` process: spawned on first use with the allowlisted environment,
// handshaken, and spawned again on the next use after it exits.
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import pkg from '../../../package.json' with { type: 'json' };
import { childEnv } from '../../../electron/paths.ts';
import { RpcClient, type RpcChild } from './rpc.ts';

export interface ChildLike extends RpcChild {
  stderr: NodeJS.ReadableStream | null;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnLike = (command: string, args: readonly string[], options: { env: Record<string, string>; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildLike;

export const defaultSpawn: SpawnLike = (command, args, options) => nodeSpawn(command, args, options);

export class CodexMissingError extends Error {
  constructor() {
    super('Codex not found');
    this.name = 'CodexMissingError';
  }
}

/** The app server was spawned but did not finish its handshake in time (hung, not exited). */
export class CodexStartError extends Error {
  constructor() {
    super("Codex didn't start");
    this.name = 'CodexStartError';
  }
}

const STOP_GRACE_MS = 2_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

export interface CodexServerOptions {
  codexPath: string | null | (() => Promise<string | null>);
  spawn: SpawnLike;
  /** Called with each new client before its handshake, to register handlers. */
  setup(rpc: RpcClient): void;
  /** A live process went away without stop(). */
  onExit(rpc: RpcClient, reason: Error): void;
  /** How long `initialize` may take before the process is given up on (15 s by default). */
  handshakeMs?: number;
  /** The allowlisted environment (childEnv of this process by default). */
  env?: Record<string, string>;
  /** How long each request may wait for its answer (rpc.ts REQUEST_TIMEOUT_MS by default). */
  requestTimeoutMs?: number;
}

export class CodexServer {
  private live: { rpc: RpcClient; child: ChildLike } | null = null;
  /** The process whose handshake is under way, so stop() can end it too. */
  private launching: { rpc: RpcClient; child: ChildLike } | null = null;
  private starting: Promise<RpcClient> | null = null;
  private stopping = false;

  constructor(private readonly opts: CodexServerOptions) {}

  /** The running server's client, starting one if there is none. */
  client(): Promise<RpcClient> {
    if (this.live && !this.live.rpc.closed) return Promise.resolve(this.live.rpc);
    this.stopping = false;
    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Ends the server, and one still in its handshake, and waits for it to exit (at most a few
      seconds). A launch under way fails rather than leaving a process behind. */
  async stop(): Promise<void> {
    this.stopping = true;
    const launching = this.launching;
    if (launching) {
      const exited = this.exited(launching.child);
      launching.rpc.close(new Error('Agent canvas is quitting'));
      launching.child.kill('SIGTERM');
      await exited;
    }
    await this.starting?.catch(() => {});
    const live = this.live;
    this.live = null;
    if (!live) return;
    const exited = this.exited(live.child);
    live.rpc.close();
    const timer = setTimeout(() => live.child.kill('SIGTERM'), STOP_GRACE_MS);
    timer.unref?.();
    await exited;
    clearTimeout(timer);
  }

  /** Resolves when the child exits, or after a grace period if it never says so. */
  private exited(child: ChildLike): Promise<void> {
    return Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((r) => setTimeout(r, STOP_GRACE_MS * 2).unref?.()),
    ]);
  }

  /** The child sees only the allowlisted variables. Its own folder leads PATH so an npm-installed
      `codex` (a node script) finds the `node` beside it even when the app came from the Dock. */
  private env(codexPath: string): Record<string, string> {
    const env = { ...(this.opts.env ?? childEnv(process.env)) };
    env.PATH = [path.dirname(codexPath), env.PATH].filter(Boolean).join(':');
    return env;
  }

  private async launch(): Promise<RpcClient> {
    const path = this.opts.codexPath;
    const codexPath = typeof path === 'function' ? await path() : path;
    if (this.stopping) throw new Error('Agent canvas is quitting');
    if (!codexPath) throw new CodexMissingError();
    const child = this.opts.spawn(codexPath, ['app-server'], { env: this.env(codexPath), stdio: ['pipe', 'pipe', 'pipe'] });
    const rpc = new RpcClient(child, this.opts.requestTimeoutMs === undefined ? {} : { timeoutMs: this.opts.requestTimeoutMs });
    // Codex logs MCP chatter to stderr; it must be drained or the pipe fills and the server stalls.
    child.stderr?.resume();
    const failed = new Promise<never>((_, reject) => {
      child.on('error', (err: NodeJS.ErrnoException) => {
        const reason = err.code === 'ENOENT' || err.code === 'EACCES' ? new CodexMissingError() : err;
        reject(reason);
        rpc.close(reason);
      });
    });
    failed.catch(() => {});
    this.opts.setup(rpc);
    this.launching = { rpc, child };
    // A server that hangs (rather than exits) would otherwise hold every call forever.
    let timer: NodeJS.Timeout | undefined;
    const hung = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CodexStartError()), this.opts.handshakeMs ?? HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([
        rpc.request('initialize', {
          clientInfo: { name: 'agent-canvas', title: 'Agent canvas', version: pkg.version },
          capabilities: { experimentalApi: true },
        }),
        failed,
        hung,
      ]);
    } catch (err) {
      rpc.close(err instanceof Error ? err : undefined);
      child.kill('SIGTERM');
      throw err;
    } finally {
      clearTimeout(timer);
      if (this.launching?.rpc === rpc) this.launching = null;
    }
    if (this.stopping) {
      // stop() came during the handshake: this process is not kept.
      rpc.close(new Error('Agent canvas is quitting'));
      child.kill('SIGTERM');
      throw new Error('Agent canvas is quitting');
    }
    rpc.notify('initialized');
    this.live = { rpc, child };
    rpc.onClose((reason) => {
      if (this.live?.rpc === rpc) this.live = null;
      if (!this.stopping) this.opts.onExit(rpc, reason);
    });
    return rpc;
  }
}
