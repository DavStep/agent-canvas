// One ACP agent process and the SDK connection over its stdio: spawned, initialised (the app's
// client capabilities offered, the agent's read back), and stopped. The engine handles what the
// agent sends; this only carries it.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { AcpAgentConfig } from '../../../shared/acp.ts';

export const HANDSHAKE_MS = 60_000;
const STOP_GRACE_MS = 3_000;
const STDERR_KEEP = 4096;

/** What the engine answers for the agent. Each gets the request's params. */
export interface ClientHandlers {
  update(n: acp.SessionNotification): void;
  permission(p: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>;
  readTextFile(p: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  writeTextFile(p: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse>;
  createTerminal(p: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse>;
  terminalOutput(p: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse>;
  waitForTerminalExit(p: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse>;
  killTerminal(p: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse>;
  releaseTerminal(p: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse>;
}

export type SpawnLike = (command: string, args: string[], opts: { env: Record<string, string>; cwd: string }) => ChildProcess;

export const defaultSpawn: SpawnLike = (command, args, opts) =>
  nodeSpawn(command, args, { env: opts.env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });

export class AcpStartError extends Error {}

/** A handler's failure as the agent should read it: the SDK sends a plain Error only as
    "Internal error", so its message goes in a RequestError. */
function answered<A extends unknown[], R>(fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  return async (...a) => {
    try {
      return await fn(...a);
    } catch (err) {
      if (err instanceof acp.RequestError) throw err;
      throw new acp.RequestError(-32603, err instanceof Error ? err.message : String(err));
    }
  };
}

export class AcpConnection {
  readonly agent: AcpAgentConfig;
  private readonly child: ChildProcess;
  private readonly conn: acp.ClientConnection;
  private stderr = '';
  private exitInfo: { code: number | null; signal: string | null } | null = null;
  private readonly exitListeners = new Set<(reason: string) => void>();
  init: acp.InitializeResponse | null = null;

  private constructor(agent: AcpAgentConfig, child: ChildProcess, handlers: ClientHandlers) {
    this.agent = agent;
    this.child = child;
    child.stderr?.on('data', (d: Buffer) => { this.stderr = (this.stderr + d.toString('utf8')).slice(-STDERR_KEEP); });
    child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      const reason = this.exitReason();
      for (const l of [...this.exitListeners]) l(reason);
    });
    // A write to a dead pipe must not throw from a stream; the exit is reported instead.
    child.stdin?.on('error', () => {});
    const app = acp.client({ name: 'Agent canvas' })
      .onNotification(acp.methods.client.session.update, ({ params }) => handlers.update(params))
      .onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) => handlers.permission(params, signal))
      .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => answered(handlers.readTextFile)(params))
      .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => answered(handlers.writeTextFile)(params))
      .onRequest(acp.methods.client.terminal.create, ({ params }) => answered(handlers.createTerminal)(params))
      .onRequest(acp.methods.client.terminal.output, ({ params }) => answered(handlers.terminalOutput)(params))
      .onRequest(acp.methods.client.terminal.waitForExit, ({ params }) => answered(handlers.waitForTerminalExit)(params))
      .onRequest(acp.methods.client.terminal.kill, ({ params }) => answered(handlers.killTerminal)(params))
      .onRequest(acp.methods.client.terminal.release, ({ params }) => answered(handlers.releaseTerminal)(params));
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    this.conn = app.connect(stream);
    // A connection that ends without the process (stdout closed) ends the process too, so the
    // exit is what the engine hears either way.
    this.conn.signal.addEventListener('abort', () => { if (!this.closed) this.child.kill('SIGTERM'); }, { once: true });
  }

  /** The connection or the process has ended (or is ending). */
  get ending(): boolean { return this.closed || this.conn.signal.aborted; }

  /** Spawns `program` (the agent's resolved command) and initialises it. */
  static async open(opts: {
    agent: AcpAgentConfig; program: string; env: Record<string, string>; cwd: string; handlers: ClientHandlers;
    spawn?: SpawnLike; handshakeMs?: number; version?: string;
  }): Promise<AcpConnection> {
    let child: ChildProcess;
    try {
      child = (opts.spawn ?? defaultSpawn)(opts.program, opts.agent.args, { env: { ...opts.env, ...opts.agent.env }, cwd: opts.cwd });
    } catch (err) {
      throw new AcpStartError(`${opts.agent.name} did not start: ${(err as Error).message}`);
    }
    const spawnError = new Promise<never>((_, reject) => {
      child.once('error', (err) => reject(new AcpStartError(`${opts.agent.name} did not start: ${err.message}`)));
    });
    const c = new AcpConnection(opts.agent, child, opts.handlers);
    const exited = new Promise<never>((_, reject) => c.onExit((reason) => reject(new AcpStartError(`${opts.agent.name} exited while starting (${reason})`))));
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AcpStartError(`${opts.agent.name} did not answer within ${Math.round((opts.handshakeMs ?? HANDSHAKE_MS) / 1000)} s`)), opts.handshakeMs ?? HANDSHAKE_MS);
    });
    try {
      c.init = await Promise.race([
        c.conn.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
          clientInfo: { name: 'agent-canvas', title: 'Agent canvas', version: opts.version ?? '0' },
        }),
        spawnError, exited, late,
      ]);
    } catch (err) {
      c.kill();
      throw err instanceof AcpStartError ? err : new AcpStartError(`${opts.agent.name} did not start: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    return c;
  }

  get agentContext(): acp.ClientContext { return this.conn.agent; }
  get closed(): boolean { return this.exitInfo !== null; }
  get canLoad(): boolean { return this.init?.agentCapabilities?.loadSession === true; }
  get canResume(): boolean { return !!this.init?.agentCapabilities?.sessionCapabilities?.resume; }
  get canImage(): boolean { return this.init?.agentCapabilities?.promptCapabilities?.image === true; }

  onExit(cb: (reason: string) => void): () => void {
    if (this.exitInfo) { cb(this.exitReason()); return () => {}; }
    this.exitListeners.add(cb);
    return () => { this.exitListeners.delete(cb); };
  }

  /** "exit code 1: <the last line it printed on stderr>". */
  exitReason(): string {
    const e = this.exitInfo;
    const how = e === null ? 'still running' : e.signal ? `signal ${e.signal}` : `exit code ${e.code}`;
    const last = this.stderr.trim().split('\n').at(-1)?.trim();
    return last ? `${how}: ${last.slice(0, 300)}` : how;
  }

  request<M extends Parameters<acp.ClientContext['request']>[0] & keyof acp.AgentRequestParamsByMethod>(
    method: M, params: acp.AgentRequestParamsByMethod[M],
  ): Promise<acp.AgentRequestResponsesByMethod[M]> {
    if (this.closed) return Promise.reject(new Error(`${this.agent.name} is not running (${this.exitReason()})`));
    return this.conn.agent.request(method, params);
  }

  cancel(sessionId: string): void {
    if (!this.closed) void this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {});
  }

  /** Stops the process: closes its stdin and asks it to end, then kills it if it lingers. */
  async stop(): Promise<void> {
    if (this.closed) return;
    const done = new Promise<void>((resolve) => this.onExit(() => resolve()));
    try { this.conn.close(); } catch { /* closed already */ }
    try { this.child.stdin?.end(); } catch { /* gone */ }
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.kill(), STOP_GRACE_MS);
    timer.unref();
    await done;
    clearTimeout(timer);
  }

  kill(): void {
    try { this.conn.close(); } catch { /* closed already */ }
    if (!this.closed) this.child.kill('SIGKILL');
  }
}
