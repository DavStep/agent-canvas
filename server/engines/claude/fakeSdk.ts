// Test helper: an `SdkLike` that plays the Agent SDK in memory. Each query() records its options
// and the prompts it is sent, emits a system/init on the first prompt (as Claude Code does), and
// replays fixture message lists, pausing at each `canUseTool` entry until the engine answers it.
import fs from 'node:fs';
import path from 'node:path';
import type {
  AccountInfo, ModelInfo, Options, PermissionResult, QueryLike, SDKMessage, SDKUserMessage, SdkLike, UsageResponse,
} from './sdk.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../../../fixtures/claude');

/** The session of fixtures/claude/history-basic.jsonl (cwd /work/demo). */
export const SESSION_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
/** The id a query without `resume` gets. */
export const NEW_SESSION_ID = 'bbbbbbbb-0000-4000-8000-0000000000c2';

type Entry = SDKMessage | { fake: 'canUseTool'; toolName: string; input: Record<string, unknown>; options: Record<string, unknown> };

export function fixture(name: string): Entry[] {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Entry[];
}

export function usageWith(rateLimits: UsageResponse['rate_limits'], subscription: string | null = 'max'): UsageResponse {
  return {
    session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
    subscription_type: subscription, rate_limits_available: rateLimits !== null, rate_limits: rateLimits, behaviors: null,
  } as UsageResponse;
}

export class FakeSdk implements SdkLike {
  readonly queries: FakeQuery[] = [];
  accountInfo: AccountInfo = { email: 'owner@example.com', subscriptionType: 'max', tokenSource: 'claude.ai', apiProvider: 'firstParty' };
  usage: UsageResponse | Error = usageWith({
    five_hour: { utilization: 12, resets_at: '2026-11-23T18:00:00.000Z' },
    seven_day: { utilization: 40, resets_at: '2026-11-27T09:00:00.000Z' },
    seven_day_opus: { utilization: 55, resets_at: '2026-11-27T09:00:00.000Z' },
  });
  /** When false, a new query never sends its init message (a process that hangs at start). */
  sendsInit = true;
  /** When set, close() ends a query's messages only a tick later, as a real process takes a moment to exit. */
  slowClose = false;
  /** When set, close() ends a query's messages only when the test calls finishClose(). */
  holdClose = false;
  /** When set, setPermissionMode('bypassPermissions') fails, as on a process not started for it. */
  refuseBypass = false;
  /** The mode a process reports at init when none is passed: Claude Code's own default. */
  defaultMode: NonNullable<Options['permissionMode']> = 'auto';
  /** When set, the mode every process reports at init whatever was passed (Claude Code lowering it). */
  startsIn: NonNullable<Options['permissionMode']> | null = null;
  models: ModelInfo[] = [
    { value: 'default', displayName: 'Default (recommended)', description: 'Use the default model' },
    { value: 'opus', displayName: 'Opus', description: 'Most capable', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'] },
  ];

  query = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): FakeQuery => {
    const q = new FakeQuery(this, params.prompt, params.options);
    this.queries.push(q);
    return q;
  };

  get last(): FakeQuery {
    const q = this.queries.at(-1);
    if (!q) throw new Error('no query started');
    return q;
  }
}

export class FakeQuery implements QueryLike {
  readonly prompts: SDKUserMessage[] = [];
  readonly calls: unknown[][] = [];
  /** Every canUseTool call and what the engine answered. */
  readonly permissions: { toolName: string; result: PermissionResult; signal: AbortSignal }[] = [];
  closed = false;
  private readonly queue: SDKMessage[] = [];
  private wake: (() => void) | null = null;
  private failure: Error | null = null;
  private ended = false;
  private aborts: AbortController[] = [];

  constructor(private readonly sdk: FakeSdk, prompt: AsyncIterable<SDKUserMessage>, readonly options: Options) {
    void this.read(prompt);
  }

  get sessionId(): string {
    return this.options.resume ?? NEW_SESSION_ID;
  }

  private async read(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const m of prompt) {
      this.prompts.push(m);
      if (this.prompts.length === 1 && this.sdk.sendsInit) this.emit(this.init());
    }
  }

  init(): SDKMessage {
    return {
      type: 'system', subtype: 'init', session_id: this.sessionId, cwd: this.options.cwd ?? '/', model: 'claude-demo-large',
      permissionMode: this.sdk.startsIn ?? this.options.permissionMode ?? this.sdk.defaultMode, plugins: [{ name: 'superpowers', path: '/fake/plugins/superpowers' }],
      tools: ['Bash', 'Read', 'AskUserQuestion'], mcp_servers: [], slash_commands: [], apiKeySource: 'none',
      claude_code_version: '2.1.330', output_style: 'default', skills: [], uuid: 'eeeeeeee-0000-4000-8000-000000000001',
    } as SDKMessage;
  }

  emit(msg: SDKMessage): void {
    this.queue.push(msg);
    this.wake?.();
  }

  /** The child dies: the iterator throws. */
  crash(message = 'Claude Code process exited with code 1'): void {
    this.failure = new Error(message);
    for (const a of this.aborts) a.abort();
    this.wake?.();
  }

  /** Calls the engine's canUseTool as the SDK would. */
  async ask(toolName: string, input: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<PermissionResult> {
    const canUseTool = this.options.canUseTool;
    if (!canUseTool) throw new Error('no canUseTool');
    const abort = new AbortController();
    this.aborts.push(abort);
    const result = await canUseTool(toolName, input, {
      signal: abort.signal, toolUseID: 'toolu_x', requestId: `req-${this.permissions.length + 1}`, ...options,
    } as Parameters<typeof canUseTool>[2]);
    if (!result) throw new Error('canUseTool answered null');
    this.permissions.push({ toolName, result, signal: abort.signal });
    return result;
  }

  /** Plays a fixture's messages in order; `edit` may change or drop (null) an entry. */
  async replay(name: string, edit: (e: Entry) => Entry | null = (e) => e): Promise<void> {
    for (const raw of fixture(name)) {
      const entry = edit(raw);
      if (entry === null) continue;
      if ('fake' in entry) await this.ask(entry.toolName, entry.input, entry.options);
      else this.emit({ ...entry, session_id: this.sessionId } as SDKMessage);
      await new Promise((r) => setImmediate(r));
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }

  async interrupt(): Promise<undefined> {
    this.calls.push(['interrupt']);
    return undefined;
  }

  async setModel(model?: string): Promise<void> {
    this.calls.push(['setModel', model]);
  }

  async setPermissionMode(mode: NonNullable<Options['permissionMode']>): Promise<void> {
    this.calls.push(['setPermissionMode', mode]);
    if (mode === 'bypassPermissions' && this.sdk.refuseBypass && !this.options.allowDangerouslySkipPermissions) {
      throw new Error('Cannot set permission mode to bypassPermissions');
    }
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return this.sdk.models;
  }

  async accountInfo(): Promise<AccountInfo> {
    this.calls.push(['accountInfo']);
    return this.sdk.accountInfo;
  }

  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<UsageResponse> {
    this.calls.push(['usage']);
    if (this.sdk.usage instanceof Error) throw this.sdk.usage;
    return this.sdk.usage;
  }

  close(): void {
    this.closed = true;
    for (const a of this.aborts) a.abort();
    if (this.sdk.holdClose) return;
    if (this.sdk.slowClose) setImmediate(() => this.finishClose());
    else this.finishClose();
  }

  /** The process has exited: its messages end. */
  finishClose(): void {
    this.ended = true;
    this.wake?.();
  }
}
