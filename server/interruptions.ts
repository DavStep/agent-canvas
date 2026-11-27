// Tells from a provider's own records whether a session's last turn was cut off by something
// other than its owner: a usage or rate limit, an API or network error, or the process gone
// mid-turn (an app quit or relaunch, a crash). The owner's own Stop is never one: Claude writes
// "[Request interrupted by user]" for it, and Codex's interrupted turns are left alone.
import { resetFromText } from '../shared/resetTime.ts';
import type { SessionInterruption } from '../shared/types.ts';

const MAX_REASON = 300;
const LIMIT = /rate.?limit|usage.?limit|hit your .*limit|too many requests|quota|overloaded|at capacity|\b429\b|\b529\b/i;
const MANUAL_STOP = /^\[Request interrupted by user/;
/** User records that are the CLI's own (a local slash command, a `!` shell line): no reply follows them. */
const LOCAL = /^<(local-command|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr)/;
/** An assistant message that says its turn is over. */
const ENDED = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal', 'pause_turn']);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const cut = (s: string): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_REASON ? `${flat.slice(0, MAX_REASON - 1)}…` : flat;
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** When a limit resets, from a message's words (shared/resetTime.ts). */
export { resetFromText };

// ── Claude transcripts ──────────────────────────────────────────────────────────────────────

/** The fields of a transcript record read here. */
export interface ClaudeRecord {
  type?: unknown; subtype?: unknown; timestamp?: unknown; isSidechain?: unknown; isMeta?: unknown;
  isCompactSummary?: unknown; isVisibleInTranscriptOnly?: unknown;
  isApiErrorMessage?: unknown; error?: unknown; apiErrorStatus?: unknown;
  quotaLimits?: unknown; apiErrorParams?: unknown;
  message?: { content?: unknown; stop_reason?: unknown; model?: unknown };
}

type Block = { type?: unknown; text?: unknown; name?: unknown };
const blocksOf = (r: ClaudeRecord): Block[] =>
  Array.isArray(r.message?.content) ? (r.message.content as unknown[]).filter((b): b is Block => typeof b === 'object' && b !== null) : [];
const textOf = (r: ClaudeRecord): string => {
  const content = r.message?.content;
  if (typeof content === 'string') return content;
  return blocksOf(r).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n');
};
const timeOf = (r: ClaudeRecord): number | null => {
  const t = Date.parse(str(r.timestamp) ?? '');
  return Number.isFinite(t) ? t : null;
};

/** Claude's synthetic message for a failed API call: a limit (with its reset when given) or an error. */
export function claudeApiError(r: ClaudeRecord, fallbackAt: number): SessionInterruption {
  const at = timeOf(r) ?? fallbackAt;
  const text = textOf(r).trim();
  const code = str(r.error) ?? '';
  const limit = code === 'rate_limit' || r.apiErrorStatus === 429 || r.apiErrorStatus === 529 || LIMIT.test(code) || LIMIT.test(text);
  if (!limit) return { kind: 'error', reason: cut(text || `API error (${code || 'unknown'})`), at, resetsAt: null };
  const quota = r.quotaLimits as { resetsAt?: unknown } | null | undefined;
  const params = r.apiErrorParams as { rate_limit_info?: { resetsAt?: unknown } } | null | undefined;
  const seconds = num(quota?.resetsAt) ?? num(params?.rate_limit_info?.resetsAt);
  const resetsAt = seconds !== null ? seconds * 1000 : resetFromText(text, at);
  return { kind: 'limit', reason: cut(text.replace(/\|\d{9,11}$/, '') || 'Usage limit reached'), at, resetsAt };
}

/**
 * Follows a Claude transcript's main chain record by record, in order, and tells how its last
 * turn ended. A turn opens with a prompt or a tool call and closes with a final assistant message,
 * a turn-end record, or the owner's interrupt marker; an API error message closes it as failed.
 */
export class ClaudeTurnTracker {
  completedAt?: number;
  /** A turn began and nothing has closed it. */
  private open = false;
  /** The API error that ended the last turn. */
  private failure: SessionInterruption | null = null;
  /** An API error a later prompt has not got past yet (no reply came): what still holds the session. */
  private held: SessionInterruption | null = null;
  private lastAt: number | null = null;
  /** The tool call still waiting for its result, for the reason line. */
  private tool: string | null = null;
  private seen = 0;

  add(r: ClaudeRecord): void {
    if (typeof r !== 'object' || r === null || r.isSidechain === true) return;
    if (r.type === 'system') {
      if (r.subtype === 'stop_hook_summary' || r.subtype === 'turn_duration') this.open = false;
      return;
    }
    if (r.type !== 'assistant' && r.type !== 'user') return;
    // Injected context and a compaction's summary are no prompt: nothing answers them.
    if (r.isMeta === true || r.isCompactSummary === true || r.isVisibleInTranscriptOnly === true) return;
    const at = timeOf(r);
    if (r.type === 'assistant') {
      this.completedAt = undefined;
      this.seen++;
      this.lastAt = at ?? this.lastAt;
      if (r.isApiErrorMessage === true) {
        this.failure = claudeApiError(r, this.lastAt ?? 0);
        this.held = null;
        this.open = false;
        this.tool = null;
        return;
      }
      this.failure = null;
      this.held = null;
      const blocks = blocksOf(r);
      const call = blocks.findLast((b) => b.type === 'tool_use');
      if (call) {
        this.open = true;
        this.tool = str(call.name);
        return;
      }
      const stop = str(r.message?.stop_reason);
      // A text message with no stop reason is taken as the end too: older transcripts wrote none.
      if (stop !== null ? ENDED.has(stop) : blocks.some((b) => b.type === 'text')) this.open = false;
      else this.open = true;
      if (!this.open && at !== null) this.completedAt = at;
      this.tool = null;
      return;
    }
    const text = textOf(r).trimStart();
    if (MANUAL_STOP.test(text) || blocksOf(r).some((b) => b.type === 'text' && MANUAL_STOP.test(String(b.text ?? '')))) {
      this.completedAt = undefined;
      this.seen++;
      this.lastAt = at ?? this.lastAt;
      this.open = false;
      this.failure = null;
      this.held = null;
      this.tool = null;
      return;
    }
    const results = blocksOf(r).length > 0 && blocksOf(r).every((b) => b.type === 'tool_result');
    if (!results && LOCAL.test(text)) return;
    this.completedAt = undefined;
    this.seen++;
    this.lastAt = at ?? this.lastAt;
    if (results) {
      this.open = true;
      this.tool = null;
      return;
    }
    // A prompt (typed, queued or a task notification): a new turn begins.
    this.held = this.failure ?? this.held;
    this.failure = null;
    this.open = true;
    this.tool = null;
  }

  /**
   * The interruption the records show. `alive`: the session's process is running, so an open
   * turn is still going and only an API error counts.
   */
  result(alive: boolean): SessionInterruption | null {
    if (this.failure) return this.failure;
    if (!this.open || alive || this.seen === 0) return null;
    if (this.held) return this.held;
    const during = this.tool ? `, while running ${this.tool}` : '';
    return { kind: 'killed', reason: `Its process ended mid-turn${during}`, at: this.lastAt ?? 0, resetsAt: null };
  }
}

/** The interruption a list of transcript records shows (see ClaudeTurnTracker). */
export function claudeInterruption(records: ClaudeRecord[], alive: boolean): SessionInterruption | null {
  const t = new ClaudeTurnTracker();
  for (const r of records) t.add(r);
  return t.result(alive);
}

// ── Codex ───────────────────────────────────────────────────────────────────────────────────

/** A failed Codex turn's error (`thread_turns.error_json`, a turn/completed error): a limit, with
    its reset when the message gives one, or an error. */
export function codexFailure(error: unknown, at: number): SessionInterruption {
  const e = (typeof error === 'object' && error !== null ? error : { message: error }) as { message?: unknown; codexErrorInfo?: unknown };
  const message = unwrap(str(e.message) ?? '');
  const info = e.codexErrorInfo;
  const code = typeof info === 'string' ? info : typeof info === 'object' && info !== null ? Object.keys(info)[0] ?? '' : '';
  const status = typeof info === 'object' && info !== null
    ? Object.values(info).map((v) => num((v as { httpStatusCode?: unknown } | null)?.httpStatusCode)).find((v) => v !== null) ?? null
    : null;
  const accountLimit = code === 'usageLimitExceeded' || code === 'usage_limit_exceeded' || /you['’]ve hit your usage limit/i.test(message);
  const limit = accountLimit || code === 'serverOverloaded' || status === 429 || LIMIT.test(message);
  if (!limit) return { kind: 'error', reason: cut(message || `Turn failed (${code || 'unknown'})`), at, resetsAt: null };
  return { kind: 'limit', reason: cut(message || 'Usage limit reached'), at, resetsAt: resetFromText(message, at),
    ...(accountLimit ? { codexUsage: 'blocked' as const } : {}) };
}

/** Codex passes an upstream API error on as its JSON body: the message inside it. */
function unwrap(message: string): string {
  if (!message.startsWith('{')) return message;
  try {
    const inner = JSON.parse(message) as { error?: { message?: unknown }; message?: unknown };
    return str(inner.error?.message) ?? str(inner.message) ?? message;
  } catch {
    return message;
  }
}

/** A Codex turn still in progress whose rollout stopped being written: its process is gone. */
export const codexCutOff = (startedAt: number): SessionInterruption =>
  ({ kind: 'killed', reason: 'Codex stopped writing mid-turn: its process ended', at: startedAt, resetsAt: null });
