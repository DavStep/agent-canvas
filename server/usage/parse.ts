// Token usage read from the providers' own transcripts, one line at a time and incrementally: each
// parser keeps a small JSON state per file, so a later read continues where the last one stopped.
// Lines are Buffers, and only the few kinds that carry usage, a turn or a model are decoded, as the
// transcripts run to gigabytes (tool results, file contents).
//
// Claude Code (~/.claude/projects/<folder>/<session>.jsonl, and <session>/subagents/*.jsonl): an
// assistant line carries message.usage for its API call. One call written as several lines (one
// per content block) repeats the same message id and usage, so a repeated id adds only what grew.
// A user line's promptId names the turn.
//
// Codex (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl): an event_msg token_count carries the last
// call's usage (last_token_usage) and the thread's running total; a repeated total is the same call
// told twice. input_tokens includes the cached and cache-write tokens. task_started and turn_context
// name the turn; turn_context and thread_settings_applied name the model.
import { isLong } from './pricing.ts';

export type UsageProvider = 'claude' | 'codex' | 'acp';

/** One model call's tokens (or what grew of one), with what it belongs to. */
export interface UsageDelta {
  provider: UsageProvider;
  /** The card id of the chat: a Claude session id, or `codex:<thread id>`. */
  session: string;
  cwd: string;
  model: string;
  /** The turn (prompt) it belongs to; `sub:…` for a Claude subagent's own transcript. */
  turn: string;
  at: number;
  /** The call's prompt was over the model's long-prompt threshold (pricing.ts). */
  long: boolean;
  /** Uncached input. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Of cacheWrite, written to Anthropic's 1-hour cache. */
  cacheWrite1h: number;
  calls: number;
  /** Set by a direct record (an internal model call); transcripts leave it out. */
  kind?: 'internal';
  label?: string;
}

type Counts = [input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number];

export interface ClaudeFileState {
  session: string;
  cwd: string;
  turn: string | null;
  /** Set for a subagent's transcript: its usage is the parent session's, in a turn of its own. */
  sub: string | null;
  /** The last few calls' ids and counts, as one call's lines can repeat it. */
  recent: [string, Counts][];
}

export interface CodexFileState {
  session: string;
  cwd: string;
  model: string;
  turn: string | null;
  lastTotal: number | null;
}

const RECENT = 16;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (line: Buffer, needle: string, end = line.length): boolean => line.subarray(0, end).indexOf(needle) !== -1;
const time = (v: unknown, fallback: number): number => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : fallback;
};
const parse = (line: Buffer): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(line.toString('utf8'));
    return isRecord(v) ? v : null;
  } catch { return null; }
};

export function claudeState(session: string, cwd: string, sub: string | null = null): ClaudeFileState {
  return { session, cwd, turn: null, sub, recent: [] };
}

const PROMPT_ID = /"promptId":"([^"]+)"/;

/** One line of a Claude Code transcript: the usage it adds, if any. Updates `s`. */
export function claudeLine(line: Buffer, s: ClaudeFileState, now: number): UsageDelta | null {
  // The turn: user lines start with their promptId.
  if (has(line, '"promptId":"', 600)) {
    const m = PROMPT_ID.exec(line.subarray(0, 600).toString('utf8'));
    if (m && !s.sub) s.turn = m[1]!;
  }
  if (!has(line, '"usage":{')) return null;
  const d = parse(line);
  if (!d || d.type !== 'assistant' || !isRecord(d.message) || !isRecord(d.message.usage)) return null;
  const msg = d.message;
  const u = msg.usage as Record<string, unknown>;
  const model = typeof msg.model === 'string' ? msg.model : '';
  if (!model || model === '<synthetic>') return null;
  if (typeof d.sessionId === 'string' && d.sessionId && !s.sub) s.session = d.sessionId;
  if (typeof d.cwd === 'string' && d.cwd) s.cwd = d.cwd;
  const split = isRecord(u.cache_creation) ? u.cache_creation : {};
  const counts: Counts = [num(u.input_tokens), num(u.output_tokens), num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens),
    num(split.ephemeral_1h_input_tokens)];
  const id = typeof msg.id === 'string' ? msg.id : typeof d.requestId === 'string' ? d.requestId : null;
  let add = counts;
  let calls = 1;
  if (id !== null) {
    const i = s.recent.findIndex(([k]) => k === id);
    if (i !== -1) {
      const before = s.recent[i]![1];
      add = counts.map((c, j) => Math.max(0, c - before[j]!)) as Counts;
      s.recent[i] = [id, counts.map((c, j) => Math.max(c, before[j]!)) as Counts];
      calls = 0;
    } else {
      s.recent.push([id, counts]);
      if (s.recent.length > RECENT) s.recent.shift();
    }
  }
  if (add.every(c => c === 0)) return null;
  const turn = s.sub ? `sub:${s.sub}` : s.turn ?? `session:${s.session}`;
  return {
    provider: 'claude', session: s.session, cwd: s.cwd, model, turn, at: time(d.timestamp, now),
    long: isLong(model, counts[0] + counts[2] + counts[3]),
    input: add[0], output: add[1], cacheRead: add[2], cacheWrite: add[3], cacheWrite1h: Math.min(add[4], add[3]), calls,
  };
}

export function codexState(session: string, cwd = ''): CodexFileState {
  return { session, cwd, model: '', turn: null, lastTotal: null };
}

export const CODEX_PREFIX = 'codex:';

/** One line of a Codex rollout: the usage it adds, if any. Updates `s`. */
export function codexLine(line: Buffer, s: CodexFileState, now: number): UsageDelta | null {
  const head = 240;
  if (has(line, '"type":"session_meta"', head)) {
    const p = parse(line)?.payload;
    if (isRecord(p)) {
      const source = isRecord(p.source) && isRecord(p.source.subagent) && isRecord(p.source.subagent.thread_spawn) ? p.source.subagent.thread_spawn : null;
      // A subagent's thread is shown within its parent's chat.
      const id = typeof source?.parent_thread_id === 'string' ? source.parent_thread_id : typeof p.id === 'string' ? p.id : null;
      if (id) s.session = CODEX_PREFIX + id;
      if (typeof p.cwd === 'string') s.cwd = p.cwd;
    }
    return null;
  }
  if (has(line, '"type":"turn_context"', head)) {
    const p = parse(line)?.payload;
    if (isRecord(p)) {
      if (typeof p.model === 'string' && p.model) s.model = p.model;
      if (typeof p.cwd === 'string' && p.cwd) s.cwd = p.cwd;
      if (typeof p.turn_id === 'string' && p.turn_id) s.turn = p.turn_id;
    }
    return null;
  }
  if (!has(line, '"type":"event_msg"', head)) return null;
  if (has(line, '"type":"task_started"', head)) {
    const p = parse(line)?.payload;
    if (isRecord(p) && typeof p.turn_id === 'string') s.turn = p.turn_id;
    return null;
  }
  if (has(line, '"type":"thread_settings_applied"', head)) {
    const p = parse(line)?.payload;
    const settings = isRecord(p) && isRecord(p.thread_settings) ? p.thread_settings : null;
    if (settings && typeof settings.model === 'string' && settings.model) s.model = settings.model;
    return null;
  }
  if (!has(line, '"type":"token_count"', head)) return null;
  const d = parse(line);
  const info = isRecord(d?.payload) && isRecord(d.payload.info) ? d.payload.info : null;
  if (!info || !isRecord(info.last_token_usage)) return null;
  const total = isRecord(info.total_token_usage) && typeof info.total_token_usage.total_tokens === 'number' ? info.total_token_usage.total_tokens : null;
  if (total !== null && total === s.lastTotal) return null;
  s.lastTotal = total;
  const last = info.last_token_usage;
  const prompt = num(last.input_tokens);
  const cacheRead = Math.min(num(last.cached_input_tokens), prompt);
  const cacheWrite = Math.min(num(last.cache_write_input_tokens), prompt - cacheRead);
  const input = prompt - cacheRead - cacheWrite;
  const output = num(last.output_tokens);
  if (prompt + output === 0) return null;
  const model = s.model || 'codex';
  return {
    provider: 'codex', session: s.session, cwd: s.cwd, model, turn: s.turn ?? `session:${s.session}`, at: time(d?.timestamp, now),
    long: isLong(model, prompt), input, output, cacheRead, cacheWrite, cacheWrite1h: 0, calls: 1,
  };
}
