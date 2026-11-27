// ACP terminals (terminal/*): commands an agent asks the app to run, each in its own process
// group so kill and release stop what it started too. A command line runs through the shell, as
// Zed (the reference client) does: agents send whole command lines as `command`. Output is kept
// to the agent's byte limit from the end, cut on a character boundary.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** Kept when the agent names no limit: enough for any build log an agent reads back. */
export const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const KILL_GRACE_MS = 2_000;

export interface TerminalExit { exitCode: number | null; signal: string | null }

export interface CreateTerminal {
  sessionId: string;
  command: string;
  args?: string[];
  env?: { name: string; value: string }[];
  /** Already checked against the session's folder by the engine. */
  cwd: string;
  outputByteLimit?: number | null;
}

interface Term {
  id: string;
  sessionId: string;
  child: ChildProcess;
  output: string;
  bytes: number;
  truncated: boolean;
  limit: number;
  exit: TerminalExit | null;
  exited: Promise<TerminalExit>;
  listeners: Set<(chunk: string) => void>;
  exitListeners: Set<(exit: TerminalExit) => void>;
}

export type SpawnFn = typeof nodeSpawn;

/** POSIX shell quoting for one argument. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/.,:@%+=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `text` kept to its last `limit` bytes, never starting inside a character. */
export function keepTail(text: string, limit: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return { text, truncated: false };
  let start = buf.length - limit;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return { text: buf.subarray(start).toString('utf8'), truncated: true };
}

export class Terminals {
  private readonly terms = new Map<string, Term>();

  constructor(private readonly opts: { env: () => Record<string, string>; shell?: string; spawn?: SpawnFn }) {}

  create(req: CreateTerminal): string {
    const id = `term-${randomUUID()}`;
    const shell = this.opts.shell ?? '/bin/zsh';
    const line = [req.command, ...(req.args ?? []).map(shellQuote)].join(' ');
    const env = { ...this.opts.env(), ...Object.fromEntries((req.env ?? []).map((e) => [e.name, e.value])) };
    const child = (this.opts.spawn ?? nodeSpawn)(shell, ['-c', line], { cwd: req.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let settle!: (e: TerminalExit) => void;
    const exited = new Promise<TerminalExit>((resolve) => { settle = resolve; });
    const term: Term = {
      id, sessionId: req.sessionId, child, output: '', bytes: 0, truncated: false,
      limit: req.outputByteLimit != null && req.outputByteLimit > 0 ? req.outputByteLimit : DEFAULT_OUTPUT_LIMIT,
      exit: null, exited, listeners: new Set(), exitListeners: new Set(),
    };
    const onData = (data: Buffer) => {
      const chunk = data.toString('utf8');
      const kept = keepTail(term.output + chunk, term.limit);
      term.output = kept.text;
      term.truncated ||= kept.truncated;
      for (const l of term.listeners) l(chunk);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const finish = (exit: TerminalExit) => {
      if (term.exit) return;
      term.exit = exit;
      settle(exit);
      for (const l of term.exitListeners) l(exit);
    };
    child.on('error', (err) => {
      onData(Buffer.from(`${err.message}\n`));
      finish({ exitCode: 127, signal: null });
    });
    child.on('close', (code, signal) => finish({ exitCode: code, signal }));
    this.terms.set(id, term);
    return id;
  }

  private term(sessionId: string, id: string): Term {
    const t = this.terms.get(id);
    if (!t || t.sessionId !== sessionId) throw new Error(`No terminal ${id} in this session`);
    return t;
  }

  output(sessionId: string, id: string): { output: string; truncated: boolean; exitStatus: TerminalExit | null } {
    const t = this.term(sessionId, id);
    return { output: t.output, truncated: t.truncated, exitStatus: t.exit };
  }

  waitForExit(sessionId: string, id: string): Promise<TerminalExit> {
    return this.term(sessionId, id).exited;
  }

  kill(sessionId: string, id: string): void {
    this.stopProcess(this.term(sessionId, id));
  }

  release(sessionId: string, id: string): void {
    const t = this.term(sessionId, id);
    this.stopProcess(t);
    t.listeners.clear();
    t.exitListeners.clear();
    this.terms.delete(id);
  }

  /** Follows a terminal's output and exit (a tool row embedding it); returns the output so far. */
  follow(id: string, onChunk: (chunk: string) => void, onExit: (exit: TerminalExit) => void): { output: string; exit: TerminalExit | null } | null {
    const t = this.terms.get(id);
    if (!t) return null;
    t.listeners.add(onChunk);
    t.exitListeners.add(onExit);
    return { output: t.output, exit: t.exit };
  }

  /** Every terminal of a session (or of all, without one) is killed and forgotten. */
  releaseAll(sessionId?: string): void {
    for (const t of [...this.terms.values()]) if (sessionId === undefined || t.sessionId === sessionId) this.release(t.sessionId, t.id);
  }

  get size(): number {
    return this.terms.size;
  }

  private stopProcess(t: Term): void {
    if (t.exit || t.child.pid === undefined) return;
    const signal = (s: NodeJS.Signals) => {
      try {
        process.kill(-t.child.pid!, s);
      } catch {
        try { t.child.kill(s); } catch { /* gone already */ }
      }
    };
    signal('SIGTERM');
    const timer = setTimeout(() => { if (!t.exit) signal('SIGKILL'); }, KILL_GRACE_MS);
    timer.unref();
  }
}
