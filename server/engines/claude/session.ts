// One Claude Code process driving one session: the prompt queue it reads (streaming input), the
// canUseTool calls waiting on the owner (by approval id), and the idle timer that lets the process
// go after a quiet spell. The SDK does not expose the child's pid, so ownership by pid is left to
// the session files' ppid rule (Task 5).
import type {
  AccountInfo, EffortLevel, ModelInfo, Options, PermissionMode, PermissionResult, PermissionUpdate, QueryLike, SDKMessage, SDKUserMessage,
  SdkLike, UsageResponse,
} from './sdk.ts';
import { usage } from './sdk.ts';

/** A canUseTool call shown to the owner. */
export interface Ask {
  id: string;
  kind: 'approval' | 'question';
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
  suggestions: PermissionUpdate[];
  title: string | null;
  reason: string | null;
  blockedPath: string | null;
}

export interface SessionHooks {
  message(m: SDKMessage): void;
  ask(a: Ask): void;
  /** The SDK stopped waiting for an answer (its turn was cancelled). */
  askGone(id: string): void;
  /** The process is gone: `error` when it died on its own, null when this app closed it. */
  ended(error: Error | null): void;
}

export interface SessionOptions {
  cwd: string;
  resume: string | null;
  model: string | null;
  /** The thinking level; null: the model's own default. */
  effort?: EffortLevel | null;
  /** Always passed: with none, Claude Code starts in its own default (Ask), which asks for every
      command, also in a session the owner runs in Auto. */
  mode: PermissionMode;
  env: Record<string, string>;
  idleMs: number;
  /** False for a query that only answers account questions: no transcript is written. */
  persist?: boolean;
  /** More query options for this session (the canvas agent's MCP servers, system prompt and
      allowed tools). They never replace what this file sets itself: the folder, the environment,
      a mode that was picked, the approval path, the resume id or the model. */
  extras?: Partial<Options> | null;
  nextId(kind: Ask['kind']): string;
}

const CLOSED_MESSAGE = 'Agent canvas closed this session';

/** Messages for the CLI, in order; iterating waits for the next one until the queue ends. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private done = false;

  push(m: SDKUserMessage): void {
    this.items.push(m);
    this.wake?.();
  }

  end(): void {
    this.done = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

export class ClaudeSession {
  /** A turn is running (or queued) from a send until a result with nothing queued after it. */
  turn = false;
  readonly allowsBypass: boolean;
  private readonly prompts = new PromptQueue();
  private readonly q: QueryLike;
  private readonly waiting = new Map<string, { ask: Ask; resolve: (r: PermissionResult) => void }>();
  private idle: NodeJS.Timeout | null = null;
  private closing = false;
  private over = false;
  readonly done: Promise<void>;

  constructor(sdk: SdkLike, private readonly opts: SessionOptions, private readonly hooks: SessionHooks) {
    this.allowsBypass = opts.mode === 'bypassPermissions';
    const pinned = opts.model?.startsWith('claude-') && opts.effort != null;
    const options: Options = {
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      ...(opts.extras ?? {}),
      cwd: opts.cwd,
      // Force the exact model even when a resumed child kept an explicit alias.
      env: pinned ? {
        ...opts.env,
        CLAUDE_CODE_SUBAGENT_MODEL: opts.model!,
        CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
        CLAUDE_CODE_EFFORT_LEVEL: opts.effort!,
      } : opts.env,
      includePartialMessages: true,
      permissionMode: opts.mode,
      canUseTool: (toolName, input, o) => this.canUseTool(toolName, input, o),
      ...(opts.resume !== null ? { resume: opts.resume } : {}),
      ...(opts.model !== null ? { model: opts.model } : {}),
      ...(opts.effort != null ? { effort: opts.effort } : {}),
      ...(this.allowsBypass ? { allowDangerouslySkipPermissions: true } : {}),
      ...(opts.persist === false ? { persistSession: false } : {}),
    };
    this.q = sdk.query({ prompt: this.prompts, options });
    this.done = this.run();
  }

  get ended(): boolean {
    return this.over;
  }

  /** Neither ended nor closing: it still reads prompts. A closing process takes a moment to exit,
      and a message pushed meanwhile would never be read. */
  get live(): boolean {
    return !this.over && !this.closing;
  }

  /** Waiting canUseTool calls, oldest first. */
  get asks(): Ask[] {
    return [...this.waiting.values()].map((w) => w.ask);
  }

  ask(id: string): Ask | null {
    return this.waiting.get(id)?.ask ?? null;
  }

  send(m: SDKUserMessage): void {
    if (!this.live) throw new Error('This Claude Code process has ended');
    this.turn = true;
    this.stopIdle();
    this.prompts.push(m);
  }

  /** Answers a waiting canUseTool call; false if it no longer waits. */
  answer(id: string, result: PermissionResult): boolean {
    const w = this.waiting.get(id);
    if (!w) return false;
    this.waiting.delete(id);
    w.resolve(result);
    return true;
  }

  /** Chat use: the idle countdown starts again. */
  touch(): void {
    if (!this.turn && this.live) this.startIdle();
  }

  interrupt(): Promise<unknown> {
    return this.q.interrupt();
  }

  setModel(model: string): Promise<void> {
    return this.q.setModel(model);
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    return this.q.setPermissionMode(mode);
  }

  supportedModels(): Promise<ModelInfo[]> {
    return this.q.supportedModels();
  }

  accountInfo(): Promise<AccountInfo> {
    return this.q.accountInfo();
  }

  usage(): Promise<UsageResponse> {
    return usage(this.q);
  }

  /** Ends the process on purpose (idle, chat gone, quit); whatever waits is denied. */
  close(): void {
    if (this.over || this.closing) return;
    this.closing = true;
    this.prompts.end();
    this.q.close();
  }

  private async run(): Promise<void> {
    let error: Error | null = null;
    try {
      for await (const m of this.q) {
        if (m.type === 'result' && (m.queued_turn_count ?? 0) === 0) {
          this.turn = false;
          this.startIdle();
        } else if (!this.turn && (m.type === 'stream_event' || m.type === 'assistant' || m.type === 'user')) {
          // A turn nobody sent began (queued_turn_count leaves out system-queued work, such as a
          // background task finishing, and a send the CLI had not queued yet): running again.
          this.turn = true;
          this.stopIdle();
        }
        this.hooks.message(m);
      }
      if (!this.closing) error = new Error('Claude Code exited');
    } catch (err) {
      if (!this.closing) error = err instanceof Error ? err : new Error(String(err));
    }
    this.over = true;
    this.turn = false;
    this.stopIdle();
    this.prompts.end();
    for (const [id, w] of this.waiting) {
      this.waiting.delete(id);
      w.resolve({ behavior: 'deny', message: CLOSED_MESSAGE });
    }
    this.hooks.ended(error);
  }

  private canUseTool(
    toolName: string, input: Record<string, unknown>,
    o: { signal: AbortSignal; suggestions?: PermissionUpdate[]; toolUseID: string; title?: string; decisionReason?: string; blockedPath?: string; suppressAlwaysAllowRule?: boolean },
  ): Promise<PermissionResult> {
    if (this.over || this.closing) return Promise.resolve({ behavior: 'deny', message: CLOSED_MESSAGE });
    const kind = toolName === 'AskUserQuestion' ? 'question' : 'approval';
    const ask: Ask = {
      id: this.opts.nextId(kind), kind, toolName, input, toolUseID: o.toolUseID,
      // A rule that would grant more than this call (or a plugin's call) offers no "Always allow".
      suggestions: o.suppressAlwaysAllowRule ? [] : o.suggestions ?? [],
      title: o.title ?? null, reason: o.decisionReason ?? null, blockedPath: o.blockedPath ?? null,
    };
    return new Promise((resolve) => {
      this.waiting.set(ask.id, { ask, resolve });
      o.signal.addEventListener('abort', () => {
        if (this.answer(ask.id, { behavior: 'deny', message: CLOSED_MESSAGE })) this.hooks.askGone(ask.id);
      }, { once: true });
      this.hooks.ask(ask);
    });
  }

  private startIdle(): void {
    this.stopIdle();
    if (this.opts.persist === false) return; // an account query is closed by its caller
    this.idle = setTimeout(() => {
      if (!this.turn && this.waiting.size === 0) this.close();
    }, this.opts.idleMs);
    this.idle.unref?.();
  }

  private stopIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }
}
