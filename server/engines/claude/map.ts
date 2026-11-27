// Claude → chat items, shared by history (transcript records) and the live engine (SDK messages):
// tool calls → tool kinds with targets and diffs, tool results → settled tools, and SDK messages →
// ChatUpdate ops. Pure: callers pass what is shown and the stream state, and get both back.
import type { ChatItem, ChatUpdate, FileDiff, ToolKind } from '../../../shared/chat.ts';
import { fileDiff, fromUnified, hunksBetween } from '../diffs.ts';
import type { PermissionMode, SDKMessage, SDKRateLimitInfo } from './sdk.ts';

type Input = Record<string, unknown>;
type Tool = Extract<ChatItem, { kind: 'tool' }>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const blocksOf = (content: unknown): Input[] =>
  Array.isArray(content) ? content.filter((b): b is Input => typeof b === 'object' && b !== null) : [];

export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksOf(content).map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : b.type === 'image' ? '[image]' : '')).join('\n');
}

/** Tools whose row shows their own input (the plan, the to-do list), not their result, which
    only says it was received. */
const OWN_OUTPUT = new Set(['ExitPlanMode', 'TodoWrite']);

/** A tool with its result: output, done / failed / denied, and a command's exit code. */
export function settleTool(tool: Tool, result: { content?: unknown; is_error?: unknown }): Tool {
  const text = resultText(result.content);
  const output = OWN_OUTPUT.has(tool.name) && tool.output !== null ? tool.output : text;
  const failed = result.is_error === true;
  const status = !failed ? 'done' : text.startsWith("The user doesn't want to proceed") ? 'denied' : 'failed';
  let exitCode = tool.exitCode;
  if (tool.tool === 'command') {
    // Bash results carry no exit code field; a failure's text starts "Exit code N".
    const code = /^Exit code (\d+)/.exec(text)?.[1];
    exitCode = failed ? (code === undefined ? null : Number(code)) : 0;
  }
  return { ...tool, output, status, exitCode };
}

/** Tools we know nothing about show their first string argument (a Task's description, say). */
function firstString(input: Input): string {
  const s = Object.values(input).find((v): v is string => typeof v === 'string' && v.trim() !== '') ?? '';
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/** Edit and MultiEdit carry snippets, not files, so hunk line numbers count within each snippet. */
function editsDiff(path: string, edits: unknown[]): FileDiff {
  const hunks = edits
    .filter((e): e is Input => typeof e === 'object' && e !== null)
    .map((e) => hunksBetween(str(e.old_string), str(e.new_string)))
    .join('');
  return fromUnified(path, hunks);
}

/** A plan's title: its first heading, else its first line. */
function planTitle(plan: string): string {
  const lines = plan.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const heading = lines.find((l) => /^#{1,6}\s/.test(l));
  return (heading ?? lines[0] ?? 'Plan').replace(/^#{1,6}\s+/, '');
}

const TODO_MARK: Record<string, string> = { completed: '✓', in_progress: '▸', pending: '○' };

/** TodoWrite's list as lines: ✓ done, ▸ in progress (as it is being done), ○ to do. */
function todoList(todos: unknown): { count: number; done: number; text: string } {
  const list = Array.isArray(todos) ? todos.filter((t): t is Input => typeof t === 'object' && t !== null) : [];
  const text = list.map((t) => {
    const status = str(t.status);
    const label = status === 'in_progress' && str(t.activeForm) !== '' ? str(t.activeForm) : str(t.content);
    return `${TODO_MARK[status] ?? '○'} ${label}`;
  }).join('\n');
  return { count: list.length, done: list.filter((t) => t.status === 'completed').length, text };
}

/** An MCP tool's name (`mcp__<server>__<tool>`) in words: the server, and the tool with spaces
    for its underscores; null for any other tool. */
export function mcpToolName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]!.replace(/_/g, ' ').trim() } : null;
}

const MAX_ARGUMENT = 600;

/** An MCP call's arguments for an approval card, one `name: value` paragraph each, long ones cut. */
export function mcpArguments(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return '';
  return Object.entries(input as Input).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => {
    const text = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
    return `${k}: ${text.length > MAX_ARGUMENT ? `${text.slice(0, MAX_ARGUMENT)}…` : text}`;
  }).join('\n\n');
}

const firstLine = (s: string): string => s.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';

export interface ClaudeToolShape {
  tool: ToolKind;
  target: string;
  diffs: FileDiff[];
  /** The call's own content, shown as its output (a plan, a to-do list); absent for most tools. */
  output?: string | null;
}

export function classifyClaudeTool(name: string, input: unknown): ClaudeToolShape {
  const i: Input = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Input) : {};
  const file = str(i.file_path);
  switch (name) {
    case 'Bash':
      return { tool: 'command', target: str(i.command), diffs: [] };
    case 'Edit':
      return { tool: 'edit', target: file, diffs: [editsDiff(file, [i])] };
    case 'MultiEdit':
      return { tool: 'edit', target: file, diffs: [editsDiff(file, Array.isArray(i.edits) ? i.edits : [])] };
    case 'Write':
      return { tool: 'edit', target: file, diffs: [fileDiff(file, '', str(i.content))] };
    case 'NotebookEdit':
      return { tool: 'edit', target: str(i.notebook_path), diffs: [] };
    case 'Read':
      return { tool: 'read', target: file, diffs: [] };
    case 'Grep':
    case 'Glob':
      return { tool: 'search', target: str(i.pattern), diffs: [] };
    case 'WebFetch':
      return { tool: 'web', target: str(i.url), diffs: [] };
    case 'WebSearch':
      return { tool: 'web', target: str(i.query), diffs: [] };
    case 'ExitPlanMode': {
      // The whole plan, never cut: the owner approves it from this.
      const plan = str(i.plan);
      return { tool: 'other', target: plan === '' ? 'Plan' : planTitle(plan), diffs: [], output: plan === '' ? null : plan };
    }
    case 'TodoWrite': {
      const todos = todoList(i.todos);
      return { tool: 'other', target: `${todos.count} ${todos.count === 1 ? 'to-do' : 'to-dos'}, ${todos.done} done`, diffs: [], output: todos.text };
    }
    case 'Task':
    case 'Agent': {
      const head = firstLine(str(i.prompt));
      const shortHead = head.length > 120 ? `${head.slice(0, 120)}…` : head;
      return { tool: 'other', target: [str(i.description), shortHead].filter((s) => s !== '').join(' — '), diffs: [] };
    }
  }
  return { tool: name.startsWith('mcp__') ? 'mcp' : 'other', target: firstString(i), diffs: [] };
}

// ── SDK messages → ChatUpdate ops ───────────────────────────────────────────────────────────

/** What the mapper remembers between messages of one query. */
export interface StreamState {
  /** The assistant message being streamed, and the item each of its content blocks feeds. */
  messageId: string | null;
  blocks: Record<number, string>;
  /** Finished block texts of one message, by item id: blocks join as history joins them. */
  finishedFor: string | null;
  finished: Record<string, string[]>;
  /** When each reasoning item began streaming. */
  thinkingSince: Record<string, number>;
}

export const freshStream = (): StreamState => ({ messageId: null, blocks: {}, finishedFor: null, finished: {}, thinkingSince: {} });

/** What the engine acts on besides chat items. */
export type ClaudeSignal =
  | { kind: 'init'; sessionId: string; cwd: string; model: string; mode: PermissionMode; plugins: { name: string; path: string; version?: string }[] }
  | { kind: 'turnEnd'; queued: number; failed: boolean; signedOut: boolean }
  | { kind: 'rateLimit'; info: SDKRateLimitInfo }
  | { kind: 'signedOut' }
  /** Claude Code changed the permission mode itself (an approved plan leaves plan mode). */
  | { kind: 'mode'; mode: PermissionMode };

export interface MapContext { find(id: string): ChatItem | undefined; now: number; stream: StreamState }
export interface Mapped { updates: ChatUpdate[]; stream: StreamState; signal: ClaudeSignal | null }

/** A failed turn whose text says the CLI has no working login (live: "Failed to authenticate: …"). */
const SIGNED_OUT_TEXT = /failed to authenticate|not logged in|please run \/login|invalid api key/i;

type Text = Extract<ChatItem, { kind: 'assistant' | 'reasoning' }>;

function newTool(id: string, name: string, input: unknown, at: number): Tool {
  const { tool, target, diffs, output } = classifyClaudeTool(name, input);
  return { kind: 'tool', id, at, tool, name, target, status: 'running', output: output ?? null, exitCode: null, diffs };
}

export function claudeUpdates(msg: SDKMessage, ctx: MapContext): Mapped {
  const { now } = ctx;
  const stream: StreamState = {
    ...ctx.stream, blocks: { ...ctx.stream.blocks }, finished: { ...ctx.stream.finished }, thinkingSince: { ...ctx.stream.thinkingSince },
  };
  const updates: ChatUpdate[] = [];
  const local = new Map<string, ChatItem>();
  const shown = (id: string): ChatItem | undefined => local.get(id) ?? ctx.find(id);
  const upsert = (item: ChatItem): void => {
    local.set(item.id, item);
    updates.push({ op: 'upsert', item });
  };
  const notice = (id: string, level: 'info' | 'error', text: string): void =>
    upsert({ kind: 'notice', id: `notice-${id}`, at: now, level, text });
  const done = (signal: ClaudeSignal | null = null): Mapped => ({ updates, stream, signal });

  /** A content block starts streaming into item `id` (a message's later block continues its item). */
  const openText = (id: string, kind: Text['kind']): void => {
    const cur = shown(id);
    if (cur?.kind === kind) upsert({ ...cur, text: cur.text === '' ? '' : `${cur.text}\n\n`, streaming: true });
    else upsert(kind === 'assistant' ? { kind, id, at: now, text: '', streaming: true } : { kind, id, at: now, text: '', streaming: true, durationMs: null });
  };
  /** A finished block: its message's finished texts, joined, replace what streamed. */
  const finishText = (id: string, kind: Text['kind'], text: string): void => {
    const texts = [...(stream.finished[id] ?? []), text];
    stream.finished[id] = texts;
    const cur = shown(id);
    const at = cur?.at ?? now;
    if (kind === 'assistant') {
      upsert({ kind, id, at, text: texts.join('\n\n'), streaming: false });
    } else {
      const since = stream.thinkingSince[id];
      const durationMs = since !== undefined ? now - since : cur?.kind === 'reasoning' ? cur.durationMs : null;
      upsert({ kind, id, at, text: texts.join('\n\n'), streaming: false, durationMs });
    }
  };

  switch (msg.type) {
    case 'stream_event': {
      if (msg.parent_tool_use_id !== null) return done(); // a subagent's own work: history skips it too
      const ev = msg.event;
      if (ev.type === 'message_start') {
        stream.messageId = ev.message.id;
        stream.blocks = {};
      } else if (ev.type === 'content_block_start' && stream.messageId !== null) {
        const b = ev.content_block;
        if (b.type === 'text') {
          stream.blocks[ev.index] = stream.messageId;
          openText(stream.messageId, 'assistant');
        } else if (b.type === 'thinking') {
          const id = `${stream.messageId}:thinking`;
          stream.blocks[ev.index] = id;
          if (stream.thinkingSince[id] === undefined) stream.thinkingSince[id] = now;
          openText(id, 'reasoning');
        } else if (b.type === 'tool_use') {
          // Shown at once; its input (and so its target) arrives with the finished block.
          if (!shown(b.id)) upsert(newTool(b.id, b.name, {}, now));
        }
      } else if (ev.type === 'content_block_delta') {
        const id = stream.blocks[ev.index];
        if (id === undefined) return done();
        if (ev.delta.type === 'text_delta') updates.push({ op: 'append', id, field: 'text', chunk: ev.delta.text });
        else if (ev.delta.type === 'thinking_delta') updates.push({ op: 'append', id, field: 'text', chunk: ev.delta.thinking });
      }
      return done();
    }
    case 'assistant': {
      if (msg.parent_tool_use_id !== null) return done();
      // An API error arrives as a synthetic message whose text the turn's result repeats: the
      // result's notice shows it once.
      if (msg.error !== undefined && msg.message.model === '<synthetic>') {
        return done(msg.error === 'authentication_failed' ? { kind: 'signedOut' } : null);
      }
      const messageId = msg.message.id;
      if (stream.finishedFor !== messageId) {
        stream.finishedFor = messageId;
        stream.finished = {};
      }
      for (const b of msg.message.content) {
        if (b.type === 'text' && b.text !== '') finishText(messageId, 'assistant', b.text);
        else if (b.type === 'thinking' && b.thinking !== '') finishText(`${messageId}:thinking`, 'reasoning', b.thinking);
        else if (b.type === 'tool_use') {
          const cur = shown(b.id);
          const full = newTool(b.id, b.name, b.input, cur?.at ?? now);
          // A tool already waiting on the owner, or settled, keeps that state.
          upsert(cur?.kind === 'tool' ? { ...full, status: cur.status, output: cur.output ?? full.output, exitCode: cur.exitCode } : full);
        }
      }
      return done(msg.error === 'authentication_failed' ? { kind: 'signedOut' } : null);
    }
    case 'user': {
      if (msg.parent_tool_use_id !== null) return done();
      // Prompts are shown when sent; only tool results come back here.
      for (const b of blocksOf(msg.message.content)) {
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        const cur = shown(b.tool_use_id);
        if (cur?.kind === 'tool') upsert(settleTool(cur, b));
      }
      return done();
    }
    case 'result': {
      const failed = msg.is_error || msg.subtype !== 'success';
      const text = msg.subtype === 'success' ? msg.result : msg.errors.join('\n');
      const signedOut = failed && SIGNED_OUT_TEXT.test(text);
      if (msg.terminal_reason?.startsWith('aborted')) notice(msg.uuid, 'info', 'Stopped');
      else if (failed) notice(msg.uuid, 'error', text || `The turn ended early (${msg.subtype})`);
      return done({ kind: 'turnEnd', queued: msg.queued_turn_count ?? 0, failed, signedOut });
    }
    case 'system':
      if (msg.subtype === 'init') {
        return done({ kind: 'init', sessionId: msg.session_id, cwd: msg.cwd, model: msg.model, mode: msg.permissionMode, plugins: msg.plugins });
      }
      if (msg.subtype === 'compact_boundary') notice(msg.uuid, 'info', 'Earlier conversation compacted');
      if (msg.subtype === 'status' && msg.permissionMode !== undefined) return done({ kind: 'mode', mode: msg.permissionMode });
      return done();
    case 'rate_limit_event':
      return done({ kind: 'rateLimit', info: msg.rate_limit_info });
  }
  return done();
}
