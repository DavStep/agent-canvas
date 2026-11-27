// ClaudeEngine: Claude Code sessions driven through the Agent SDK. Each open chat keeps its
// ChatState (changed only through applyUpdate), the history paging cursor, and, while this app
// runs it, one ClaudeSession (the SDK process). Session ids are Claude session ids; a session not
// running here is resumed (`resume: <id>`) on the next message.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { childEnv } from '../../../electron/paths.ts';
import type { ProviderAccount, UsageWindow } from '../../../shared/account.ts';
import { BUSY_ELSEWHERE, READ_ONLY_BANNER, SIGNED_OUT_BANNER, WRITING_ALONGSIDE } from '../../../shared/banners.ts';
import type { NewSessionRequest, ProviderOptions } from '../../../shared/bridge.ts';
import type {
  ApprovalAnswer, ChatItem, ChatState, ChatUpdate, ImageRef, ModelOption, ModeOption, Owner, Question,
} from '../../../shared/chat.ts';
import { findTranscript, readWindow } from '../../adapter/transcript.ts';
import { applyUpdate } from '../chatLog.ts';
import type { ProjectProfile } from '../../agent/project.ts';
import type { BusySession, Engine, StartOptions } from '../engine.ts';
import { foreignSessionFile, OPENED_ELSEWHERE } from '../ownership.ts';
import type { SessionInterruption } from '../../../shared/types.ts';
import { claudeHistory } from './history.ts';
import { claudeUpdates, classifyClaudeTool, freshStream, mcpArguments, mcpToolName, type ClaudeSignal, type StreamState } from './map.ts';
import {
  realSdk, type AccountInfo, type EffortLevel, type Options, type PermissionMode, type PermissionResult, type PermissionUpdate, type PermissionUpdateDestination,
  type SDKMessage, type SDKRateLimitInfo, type SDKUserMessage, type SdkLike, type UsageResponse,
} from './sdk.ts';
import { ClaudeSession, type Ask } from './session.ts';

export { READ_ONLY_BANNER, SIGNED_OUT_BANNER } from '../../../shared/banners.ts';
const DENIED = 'Denied in Agent canvas';
const PAGE = 200;
const IDLE_MS = 600_000;
const ACCOUNT_TIMEOUT_MS = 15_000;
/** How long a new session's process may take to say which session it is. */
const START_TIMEOUT_MS = 30_000;
export const NOT_STARTED = "Claude didn't start";
export const QUITTING = 'Agent canvas is quitting';
const TAIL_BYTES = 64 * 1024;
/** The newest prompt's mode is looked for backwards this many bytes at a time, at most so far. */
const MODE_CHUNK = 256 * 1024;
const MODE_SCAN_BYTES = 64 * 1024 * 1024;
/** How often a chat open in another app looks for new writes to its transcript. */
const FOLLOW_MS = 2_000;

type ModeId = 'auto' | 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
/** Auto first: Claude Code's own default where the account has it (a classifier approves routine
    calls and asks only when it cannot decide), and what the owner's other sessions run in. */
const MODES: ModeOption[] = [
  { id: 'auto', label: 'Auto' }, { id: 'default', label: 'Ask' }, { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'plan', label: 'Plan' }, { id: 'bypassPermissions', label: 'Bypass' },
];
const isMode = (m: string): m is ModeId => MODES.some((x) => x.id === m);
const modeLabel = (m: ModeId): string => MODES.find((x) => x.id === m)!.label;
/** The mode a chat resumes in when nothing names one. Never none: Claude Code's own default (Ask)
    would ask for every command, also in a session the owner runs in Auto. */
const FALLBACK_MODE: ModeId = 'auto';
/** What the New session dialog offers before Claude Code has listed its own models: its aliases. */
const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const FALLBACK_MODELS: ModelOption[] = [
  { id: 'default', label: 'Default (recommended)', isDefault: true }, { id: 'opus', label: 'Opus', isDefault: false },
  { id: 'sonnet', label: 'Sonnet', isDefault: false }, { id: 'haiku', label: 'Haiku', isDefault: false },
].map((m) => ({ ...m, efforts: FALLBACK_EFFORTS }));
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const isEffort = (e: string | null): e is EffortLevel => e !== null && EFFORTS.has(e);

/** Where an "Always allow" rule is written, as the approval card names it. */
const DESTINATIONS: Record<PermissionUpdateDestination, string> = {
  localSettings: "this project's local settings",
  projectSettings: "this project's shared settings",
  userSettings: 'your user settings',
  session: 'this session',
  cliArg: 'this session',
};

export function alwaysLabel(suggestions: PermissionUpdate[]): string | null {
  const names = [...new Set(suggestions.map((s) => DESTINATIONS[s.destination] ?? s.destination))];
  return names.length > 0 ? names.join(' and ') : null;
}

/** Plan usage windows → labels: the usage call's keys, and a rate_limit_event's rateLimitType. */
const WINDOWS: [key: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet', label: string][] = [
  ['five_hour', '5 h'], ['seven_day', 'Weekly'], ['seven_day_opus', 'Weekly Opus'], ['seven_day_sonnet', 'Weekly Sonnet'],
];

const TITLES: Record<string, string> = {
  Bash: 'Allow this command?', Edit: 'Allow this edit?', MultiEdit: 'Allow these edits?', Write: 'Allow writing this file?',
  ExitPlanMode: 'Approve this plan?',
  // The canvas agent's own tools that ask (server/agent/tools.ts).
  mcp__canvas__start_task: 'Start this task?', mcp__canvas__delete_zone: 'Delete this zone?',
};

/** The card's title when Claude Code gives none: the tool's own, else an MCP tool in words
    ("Allow tickets: create ticket?"), else the tool's name. */
function approvalTitle(toolName: string): string {
  const mcp = mcpToolName(toolName);
  return TITLES[toolName] ?? (mcp ? `Allow ${mcp.server}: ${mcp.tool}?` : `Allow ${toolName}?`);
}

interface Chat {
  project?: ProjectProfile;
  id: string;
  state: ChatState;
  emit: ((u: ChatUpdate) => void) | null;
  /** The SDK process, while this app runs the session. */
  session: ClaudeSession | null;
  stream: StreamState;
  /** History paging: the transcript, the next older page's cursor, and the records shown. */
  file: string | null;
  cursor: string | null;
  taken: Set<string>;
  /** Of `taken`, the records the newest page shows: a re-read of that page may show them again. */
  newestTaken: Set<string>;
  /** The transcript as last read (size, mtime, inode), and the poll that follows it while another
      program has the session open. */
  seen: { size: number; mtimeMs: number; ino: number } | null;
  follow: NodeJS.Timeout | null;
  /** A model the owner picked, passed when the next process starts. */
  chosenModel: string | null;
  /** The thinking level the session started with here, passed again when a process resumes it. */
  chosenEffort?: string | null;
  /** The running process cannot switch to the chosen mode: start a new one when the turn is over. */
  restart: boolean;
  plugins: { name: string; path: string; version?: string }[];
  /** The owner sent a message while another program had the session open: this app writes to it
      alongside that program, so its process is not stopped when the other one is seen. */
  shared?: boolean;
}


export interface ClaudeEngineOptions {
  projectFor?(id: string): ProjectProfile | undefined;
  agentKey?: { cwd: string; read(): Promise<string> };
  sdk?: SdkLike;
  now?: () => number;
  idleMs?: number;
  claudeHome: string;
  /** Rate limits changed (a rate_limit_event): the profile page may want account() again. */
  onAccountChanged?: () => void;
  /** How often a chat open in another app re-checks its transcript (2 s by default). */
  followMs?: number;
  /** How long start() waits for the new process's init message (30 s by default). */
  startTimeoutMs?: number;
  /** Whether another program has the session open now (ownership.ts, via the store). Such a
      session is read-only here: never resumed, and its open tool calls are not marked lost. */
  elsewhere?: (sessionId: string) => boolean;
  /** Whether another program is in the middle of a turn in the session now (the store's card). */
  workingElsewhere?: (sessionId: string) => boolean;
  /** The environment Claude Code runs with (childEnv of this process by default). */
  env?: Record<string, string>;
  /** Whether another program has the session open, read from the session files right now (the
      store's answer is up to a poll old). Asked before a resume; ownership.ts by default. */
  foreignFile?: (sessionId: string) => Promise<boolean>;
  /** More query options for a session in this folder, or null: asked each time a process is
      started for a chat (a new session and a resume alike). The canvas agent's folder gets its
      MCP servers, system prompt and allowed tools this way (server/agent/agent.ts). */
  extras?: (cwd: string, project?: ProjectProfile) => Partial<Options> | null;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** The session's folder and model, from the transcript's last records. */
async function tailFacts(file: string): Promise<{ cwd: string; model: string | null; mode: string | null }> {
  let cwd = '';
  let model: string | null = null;
  let mode: string | null = null;
  try {
    for (const line of (await readWindow(file, TAIL_BYTES)).split('\n')) {
      try {
        const r = JSON.parse(line) as { cwd?: unknown; type?: unknown; message?: { model?: unknown }; permissionMode?: unknown };
        if (typeof r.cwd === 'string' && r.cwd !== '') cwd = r.cwd;
        // Claude Code stamps each prompt with the mode it ran under.
        if (r.type === 'user' && typeof r.permissionMode === 'string') mode = r.permissionMode;
        const m = r.type === 'assistant' ? r.message?.model : undefined;
        if (typeof m === 'string' && m !== '<synthetic>') model = m;
      } catch {
        // a torn line
      }
    }
    // A long last turn (big tool output) can push its prompt out of the tail: without this the
    // session would resume with no mode at all, and Claude Code's own default asks for everything.
    if (mode === null) mode = await lastPromptMode(file);
  } catch {
    // unreadable: the chat still opens
  }
  return { cwd, model, mode };
}

/** The mode the transcript's newest stamped prompt ran under, read backwards from the end in
    chunks (at most MODE_SCAN_BYTES), or null if no prompt names one. */
export async function lastPromptMode(file: string): Promise<string | null> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const floor = Math.max(0, size - MODE_SCAN_BYTES);
    // The start of the last chunk read, up to its first newline: the end of a line read next.
    let carry = Buffer.alloc(0);
    for (let end = size; end > floor;) {
      const start = Math.max(floor, end - MODE_CHUNK);
      const chunk = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
      const data = Buffer.concat([chunk.subarray(0, bytesRead), carry]);
      // Before the first newline the line may begin in an earlier chunk (none: the whole is torn).
      const first = start === 0 ? 0 : data.indexOf(0x0a) + 1;
      if (first > 0 || start === 0) {
        const lines = data.subarray(first).toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i]!;
          if (!line.includes('"permissionMode"')) continue;
          try {
            const r = JSON.parse(line) as { type?: unknown; permissionMode?: unknown };
            if (r.type === 'user' && typeof r.permissionMode === 'string') return r.permissionMode;
          } catch {
            // a torn line
          }
        }
      }
      carry = data.subarray(0, first === 0 && start > 0 ? data.length : first);
      end = start;
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function statOf(file: string): Promise<{ size: number; mtimeMs: number; ino: number } | null> {
  try {
    const { size, mtimeMs, ino } = await fs.stat(file);
    return { size, mtimeMs, ino };
  } catch {
    return null;
  }
}

/** A tool call with no result, in a session not running here, will never get one. What it shows
    of its own (a plan, a to-do list) stays. */
function settleLost(items: ChatItem[]): ChatItem[] {
  return items.map((i) => (i.kind === 'tool' && (i.status === 'running' || i.status === 'waiting') ? { ...i, status: 'failed' } : i));
}

function content(text: string, images: ImageRef[]): SDKUserMessage['message']['content'] {
  if (images.length === 0) return text;
  const blocks = images.map((img) => {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(img.dataUrl);
    if (!m) throw new Error('Images must be data: URLs');
    return { type: 'image' as const, source: { type: 'base64' as const, media_type: m[1] as 'image/png', data: m[2]! } };
  });
  return [...blocks, ...(text !== '' ? [{ type: 'text' as const, text }] : [])];
}

export class ClaudeEngine implements Engine {
  readonly provider = 'claude' as const;
  readonly interruptions = new Map<string, SessionInterruption>();
  private readonly sdk: SdkLike;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly projectsDir: string;
  private readonly onAccountChanged: (() => void) | null;
  private readonly elsewhere: (sessionId: string) => boolean;
  private readonly workingElsewhere: (sessionId: string) => boolean;
  private readonly followMs: number;
  private readonly startTimeoutMs: number;
  private readonly env: Record<string, string>;
  private readonly agentKey?: ClaudeEngineOptions['agentKey'];
  private readonly foreignFile: (sessionId: string) => Promise<boolean>;
  private readonly projectFor: ClaudeEngineOptions['projectFor'];
  private readonly extras: (cwd: string, project?: ProjectProfile) => Partial<Options> | null;
  private readonly chats = new Map<string, Chat>();
  /** Every Claude Code process this engine started, until it has exited: running chats, starts
      still waiting for their init, processes replaced (Bypass restart) or let go (lost), and
      account queries. stop() waits for all of them. */
  private readonly processes = new Set<ClaudeSession>();
  /** Set by stop(): nothing new is started from then on. */
  private stopping = false;
  private models: ModelOption[] | null = null;
  private signedOut = false;
  /** The last rate_limit_event of each window: the account's usage when the usage call fails. */
  private readonly rateLimits = new Map<string, SDKRateLimitInfo>();
  private seq = 0;

  constructor(opts: ClaudeEngineOptions) {
    this.sdk = opts.sdk ?? realSdk;
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.projectsDir = path.join(opts.claudeHome, 'projects');
    this.onAccountChanged = opts.onAccountChanged ?? null;
    this.elsewhere = opts.elsewhere ?? (() => false);
    this.workingElsewhere = opts.workingElsewhere ?? (() => false);
    this.followMs = opts.followMs ?? FOLLOW_MS;
    this.startTimeoutMs = opts.startTimeoutMs ?? START_TIMEOUT_MS;
    this.agentKey = opts.agentKey;
    this.env = opts.env ?? childEnv(process.env);
    const sessionsDir = path.join(opts.claudeHome, 'sessions');
    this.foreignFile = opts.foreignFile ?? ((id) => foreignSessionFile(sessionsDir, id, process.pid));
    this.projectFor = opts.projectFor;
    this.extras = opts.extras ?? (() => null);
  }

  /** Why Claude cards cannot work right now (signed out), or null. */
  get banner(): string | null {
    return this.signedOut ? SIGNED_OUT_BANNER : null;
  }

  // ── Engine ──────────────────────────────────────────────────────────────────────────────

  async open(sessionId: string, emit: (u: ChatUpdate) => void): Promise<ChatState> {
    const known = this.chats.get(sessionId);
    if (known?.session) {
      known.emit = emit;
      known.session.touch();
      return known.state;
    }
    if (known) this.unfollow(known);
    const chat = await this.readFresh(sessionId, known);
    chat.emit = emit;
    this.chats.set(sessionId, chat);
    this.followIfElsewhere(chat);
    return chat.state;
  }

  close(sessionId: string): void {
    const chat = this.chats.get(sessionId);
    if (!chat) return;
    chat.emit = null;
    this.unfollow(chat);
    // A running process keeps going until its idle close; an idle chat is forgotten now.
    if (!chat.session) this.chats.delete(sessionId);
  }

  async loadOlder(sessionId: string): Promise<void> {
    const chat = this.chat(sessionId);
    chat.session?.touch();
    if (!chat.file || !chat.state.hasOlder) return;
    const page = await claudeHistory(chat.file, { limit: PAGE, before: chat.cursor, taken: chat.taken });
    chat.cursor = page.cursor;
    // Older pages hold only turns from before this chat opened: a call without a result there is
    // lost, unless another program still has the session open.
    this.apply(chat, { op: 'older', items: chat.state.owner === 'elsewhere' ? page.items : settleLost(page.items), hasOlder: page.hasOlder });
  }

  async send(sessionId: string, text: string, images: ImageRef[]): Promise<void> {
    this.refuseIfStopping();
    const chat = this.chat(sessionId);
    const message = content(text, images);
    // A process that is closing (idle) reads no more prompts: this message starts a new one.
    if (chat.session && !chat.session.live) chat.session = null;
    if (chat.restart && chat.session && !chat.session.turn && chat.session.asks.length === 0) {
      const old = chat.session;
      chat.session = null;
      chat.restart = false;
      old.close();
    }
    const env = chat.session ? this.env : await this.sessionEnv(chat.state.cwd, chat.project);
    let alongside = false;
    if (!chat.session) {
      // A session another program has open is resumed here too, at the owner's word: both write
      // to it. Never in the middle of the other program's turn, though. The store's answer is up
      // to a poll old, so the session files are read again first.
      alongside = chat.state.owner === 'elsewhere' || this.elsewhere(chat.id) || await this.foreignFile(chat.id).catch(() => true);
      if (alongside && this.workingElsewhere(chat.id)) throw new Error(BUSY_ELSEWHERE);
    }
    // Another send may have started the process while the files were read.
    if (chat.session && !chat.session.live) chat.session = null;
    if (!chat.session) {
      this.refuseIfStopping();
      chat.restart = false;
      if (chat.state.cwd === '') throw new Error("Agent canvas cannot find this session's folder");
      // A resumed session keeps the exact model it ran on (the transcript's, shown in the picker)
      // unless the owner picked another here; Claude Code's default would quietly swap it.
      chat.session = this.launch(chat, env, { cwd: chat.state.cwd, resume: chat.id, model: chat.chosenModel ?? chat.state.model, effort: chat.chosenEffort ?? null, mode: chat.state.mode });
      chat.stream = freshStream();
      if (alongside) {
        this.unfollow(chat);
        if (!chat.shared) this.notice(chat, 'info', WRITING_ALONGSIDE);
        chat.shared = true;
      }
      this.apply(chat, { op: 'meta', patch: { owner: 'here', banner: this.bannerFor('here', chat.state.cwd, chat.project) } });
    }
    const uuid = randomUUID();
    // Shown at once, also mid-turn: the CLI queues it (or folds it into the running turn).
    this.apply(chat, { op: 'upsert', item: { kind: 'user', id: uuid, at: this.now(), text, images } });
    chat.session.send({ type: 'user', message: { role: 'user', content: message }, parent_tool_use_id: null, uuid, session_id: chat.id });
    if (chat.state.turn !== 'running') this.apply(chat, { op: 'meta', patch: { turn: 'running' } });
  }

  async interrupt(sessionId: string): Promise<void> {
    const chat = this.chat(sessionId);
    chat.session?.touch();
    if (chat.session?.live && chat.session.turn) await chat.session.interrupt();
  }

  async answerApproval(sessionId: string, approvalId: string, answer: ApprovalAnswer): Promise<void> {
    const chat = this.chat(sessionId);
    const ask = chat.session?.ask(approvalId);
    if (!ask || ask.kind !== 'approval') throw new Error('This approval is no longer waiting');
    if (answer === 'allowAlways' && ask.suggestions.length === 0) throw new Error('"Always allow" is not offered for this request');
    const result: PermissionResult = answer === 'deny' ? { behavior: 'deny', message: DENIED }
      : answer === 'allowAlways' ? { behavior: 'allow', updatedInput: ask.input, updatedPermissions: ask.suggestions }
        : { behavior: 'allow', updatedInput: ask.input };
    chat.session!.answer(approvalId, result);
    chat.session!.touch();
    this.patch(chat, approvalId, { status: answer === 'allow' ? 'allowed' : answer === 'allowAlways' ? 'allowedAlways' : 'denied' });
    this.patch(chat, ask.toolUseID, { status: answer === 'deny' ? 'denied' : 'running' }, 'waiting');
  }

  async answerQuestion(sessionId: string, questionId: string, answers: Record<string, string>): Promise<void> {
    const chat = this.chat(sessionId);
    const ask = chat.session?.ask(questionId);
    if (!ask || ask.kind !== 'question') throw new Error('This question is no longer waiting');
    // AskUserQuestion reads its answers keyed by question text (our question ids).
    chat.session!.answer(questionId, { behavior: 'allow', updatedInput: { questions: ask.input.questions, answers } });
    chat.session!.touch();
    this.patch(chat, questionId, { status: 'answered', answers });
    this.patch(chat, ask.toolUseID, { status: 'running' }, 'waiting');
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const chat = this.chat(sessionId);
    if (chat.state.models.length > 0 && !chat.state.models.some((m) => m.id === model)) throw new Error(`Unknown Claude model: ${model}`);
    if (chat.session?.live) {
      await chat.session.setModel(model);
      chat.session.touch();
    }
    chat.chosenModel = model;
    this.apply(chat, { op: 'meta', patch: { model } });
  }

  async setModelProfile(sessionId: string, model: string, effort: string): Promise<void> {
    const chat = this.chat(sessionId);
    if (!isEffort(effort)) throw new Error(`Unknown Claude thinking level: ${effort}`);
    if (chat.chosenModel === model && chat.chosenEffort === effort) return;
    if (chat.session?.turn || chat.session?.asks.length) throw new Error('Wait for this turn to finish before changing models.');
    chat.chosenModel = model;
    chat.chosenEffort = effort;
    // Start the next turn with both explicit CLI flags instead of switching just the model live.
    chat.restart = true;
    this.apply(chat, { op: 'meta', patch: { model, effort } });
  }

  async setMode(sessionId: string, mode: string): Promise<void> {
    const chat = this.chat(sessionId);
    if (!isMode(mode)) throw new Error(`Unknown Claude permission mode: ${mode}`);
    const session = chat.session?.live ? chat.session : null;
    if (session) {
      try {
        await session.setPermissionMode(mode);
      } catch (err) {
        // Bypass needs a process started for it; others failing is a real error.
        if (mode !== 'bypassPermissions' || session.allowsBypass) throw err;
        chat.restart = true;
      }
      session.touch();
    }
    this.apply(chat, { op: 'meta', patch: { mode } });
  }

  /** Succeeds once no other program has the session open (session files, via the store); the
      chat is then read afresh, as what the other program wrote was not followed here. */
  async moveHere(sessionId: string): Promise<boolean> {
    this.refuseIfStopping();
    const chat = this.chat(sessionId);
    if (this.elsewhere(sessionId)) return false;
    if (chat.state.owner !== 'elsewhere' || chat.session) return true;
    if (await this.foreignFile(sessionId).catch(() => true)) return false;
    const fresh = await this.readFresh(sessionId, chat);
    // Taken again meanwhile, or the chat was closed or started here while it read.
    if (fresh.state.owner === 'elsewhere') return false;
    if (this.chats.get(sessionId) !== chat || chat.session) return true;
    this.unfollow(chat);
    Object.assign(chat, { ...fresh, emit: chat.emit });
    chat.emit?.({ op: 'reset', state: chat.state });
    return true;
  }

  /** The models Claude Code listed when a process last started, else the built-in aliases. No
      process is started for this. */
  async options(): Promise<ProviderOptions> {
    const models = this.models && this.models.length > 0 ? this.models : FALLBACK_MODELS;
    return { models, model: models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? null, effort: null, modes: MODES, mode: 'auto' };
  }

  lost(sessionId: string): void {
    const chat = this.chats.get(sessionId);
    if (!chat) return;
    // The owner chose to write alongside the other program: this app's process keeps running.
    if (chat.shared && chat.session) return;
    const session = chat.session;
    if (session) {
      // Its `ended` is ignored from here on (chat.session !== session); what waits is denied.
      chat.session = null;
      session.close();
      for (const i of chat.state.items) {
        if ((i.kind === 'approval' || i.kind === 'question') && i.status === 'pending') this.apply(chat, { op: 'upsert', item: { ...i, status: 'expired' } });
      }
      this.settleOpen(chat);
    }
    const already = chat.state.owner === 'elsewhere';
    this.apply(chat, { op: 'meta', patch: { owner: 'elsewhere', turn: 'idle', banner: this.bannerFor('elsewhere', chat.state.cwd, chat.project) } });
    if (!already) this.notice(chat, 'warn', OPENED_ELSEWHERE);
    if (!chat.emit) this.chats.delete(chat.id); // nobody is looking: the next open reads it afresh
    else this.followIfElsewhere(chat);
  }

  async rename(id: string, title: string): Promise<void> {
    if (!this.sdk.renameSession) throw new Error('Claude cannot rename this session.');
    await this.sdk.renameSession(id, title);
    const chat = this.chats.get(id);
    if (chat) this.apply(chat, { op: 'meta', patch: { title } });
  }

  async start(req: NewSessionRequest, options: StartOptions = {}): Promise<string> {
    this.refuseIfStopping();
    const mode = req.mode ?? 'auto';
    if (!isMode(mode)) throw new Error(`Unknown Claude permission mode: ${mode}`);
    if (req.effort !== null && !isEffort(req.effort)) throw new Error(`Unknown Claude thinking level: ${req.effort}`);
    const env = await this.sessionEnv(req.cwd, options.project);
    this.refuseIfStopping();
    const message = content(req.text, req.images);
    const uuid = randomUUID();
    const user: ChatItem = { kind: 'user', id: uuid, at: this.now(), text: req.text, images: req.images };
    let resolveId!: (id: string) => void;
    let rejectId!: (e: Error) => void;
    const started = new Promise<string>((res, rej) => {
      resolveId = res;
      rejectId = rej;
    });
    // The session id is known only from the init message: until then the chat has no key.
    const chat: Chat = {
      project: options.project, id: '', emit: null, session: null, stream: freshStream(), file: null, cursor: null, taken: new Set(), newestTaken: new Set(), seen: null, follow: null,
      chosenModel: req.model, chosenEffort: req.effort, restart: false, plugins: [],
      state: {
        sessionId: '', provider: 'claude', owner: 'here', title: options.title ?? '', cwd: req.cwd, items: [user], hasOlder: false, turn: 'running',
        model: req.model, effort: req.effort, models: this.models ?? [], mode, modes: MODES, banner: this.bannerFor('here', req.cwd, options.project), apiKeyAuth: this.agentKey?.cwd === req.cwd || options.project?.connection === 'claude-api',
      },
    };
    // A process that never says which session it is would leave the start waiting for ever: it is
    // closed after a while, and the start fails.
    const timer = setTimeout(() => {
      const session = chat.session;
      chat.session = null;
      session?.close();
      rejectId(new Error(NOT_STARTED));
    }, this.startTimeoutMs);
    timer.unref?.();
    chat.session = this.launch(chat, env, { cwd: req.cwd, resume: null, model: req.model, effort: req.effort, mode, title: options.title }, {
      init: (id) => {
        clearTimeout(timer);
        chat.id = id;
        chat.state = { ...chat.state, sessionId: id };
        this.chats.set(id, chat);
        resolveId(id);
      },
      failed: (e) => { clearTimeout(timer); rejectId(e); },
    });
    chat.session.send({ type: 'user', message: { role: 'user', content: message }, parent_tool_use_id: null, uuid });
    return started;
  }

  /** Sessions this engine runs alongside another program, at the owner's word: not taken away. */
  shared(): Set<string> {
    return new Set([...this.chats.values()].filter((c) => c.shared && c.session?.live).map((c) => c.id));
  }

  owned(): Set<string> {
    return new Set([...this.chats.values()].filter((c) => c.session && !c.session.ended).map((c) => c.id));
  }

  /** A closed Claude process lets go of its session at once. */
  releasing(): Set<string> {
    return new Set();
  }

  busy(): BusySession[] {
    return [...this.chats.values()].flatMap((c): BusySession[] => {
      if (!c.session || c.id === '') return [];
      const asks = c.session.asks;
      if (asks.some((a) => a.kind === 'approval')) return [{ sessionId: c.id, reason: 'approval' }];
      if (asks.length > 0) return [{ sessionId: c.id, reason: 'question' }];
      return c.session.turn ? [{ sessionId: c.id, reason: 'turn' }] : [];
    });
  }

  async account(): Promise<ProviderAccount> {
    const none: ProviderAccount = { provider: 'claude', signedIn: false, email: null, plan: null, windows: [], note: null };
    if (this.stopping) return { ...none, note: QUITTING };
    // A running process answers; otherwise a short one that sends nothing and writes no transcript.
    const live = [...this.chats.values()].find((c) => c.session?.live)?.session ?? null;
    const session = live ?? this.spawn({
      cwd: os.homedir(), resume: null, model: null, mode: 'default', env: { ...this.env }, idleMs: this.idleMs,
      persist: false, nextId: (kind) => this.nextId(kind),
    }, { message: () => {}, ask: () => {}, askGone: () => {}, ended: () => {} });
    try {
      let info: AccountInfo;
      try {
        info = await withTimeout(session.accountInfo(), ACCOUNT_TIMEOUT_MS, 'Claude Code');
      } catch (err) {
        return { ...none, note: `Claude Code could not read the account: ${errText(err)}` };
      }
      let usage: UsageResponse | null = null;
      try {
        usage = await withTimeout(session.usage(), ACCOUNT_TIMEOUT_MS, 'Claude Code');
      } catch {
        // Usage is extra (and an experimental call): the last rate_limit_events stand in.
      }
      // Signed out reads {tokenSource:'none', apiProvider:'firstParty'} with nothing else.
      const signedIn = Boolean(info.email) || (info.tokenSource !== undefined && info.tokenSource !== 'none')
        || (info.apiKeySource !== undefined && info.apiKeySource !== 'none')
        || (info.apiProvider !== undefined && info.apiProvider !== 'firstParty') || Boolean(usage?.subscription_type);
      this.setSignedOut(!signedIn);
      if (!signedIn) return { ...none, note: SIGNED_OUT_BANNER };
      return {
        ...none, signedIn: true, email: info.email ?? null,
        plan: info.subscriptionType ?? usage?.subscription_type ?? (info.apiKeySource && info.apiKeySource !== 'none' ? 'API key' : null),
        windows: usage?.rate_limits ? this.usageWindows(usage.rate_limits) : this.eventWindows(),
      };
    } finally {
      if (!live) session.close();
    }
  }

  /** Quit: from now on nothing new starts (send, start and moveHere reject), every process this
      engine started is closed, and this resolves once all of them have exited, so busy() and
      owned() are empty. What waits on the owner is denied as each process ends. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const chat of this.chats.values()) this.unfollow(chat);
    for (const s of this.processes) s.close();
    while (this.processes.size > 0) await Promise.all([...this.processes].map((s) => s.done));
  }

  private async sessionEnv(cwd: string, project?: ProjectProfile): Promise<Record<string, string>> {
    if (this.agentKey?.cwd !== cwd && project?.connection !== 'claude-api') return this.env;
    const key = await this.agentKey?.read();
    if (!key) throw new Error('Set the Claude API key in Profile to continue.');
    return { ...this.env, ANTHROPIC_API_KEY: key };
  }

  private refuseIfStopping(): void {
    if (this.stopping) throw new Error(QUITTING);
  }

  /** Every process is started here, so stop() knows of it until it has exited. */
  private spawn(opts: ConstructorParameters<typeof ClaudeSession>[1], hooks: ConstructorParameters<typeof ClaudeSession>[2]): ClaudeSession {
    const session = new ClaudeSession(this.sdk, opts, hooks);
    this.processes.add(session);
    void session.done.finally(() => this.processes.delete(session));
    return session;
  }

  // ── Processes ───────────────────────────────────────────────────────────────────────────

  private launch(
    chat: Chat, env: Record<string, string>, s: { title?: string; cwd: string; resume: string | null; model: string | null; effort?: string | null; mode: string },
    first?: { init(id: string): void; failed(e: Error): void },
  ): ClaudeSession {
    let initialized = false;
    const session: ClaudeSession = this.spawn({
      cwd: s.cwd, resume: s.resume, model: s.model, effort: isEffort(s.effort ?? null) ? s.effort as EffortLevel : null, mode: isMode(s.mode) ? s.mode : FALLBACK_MODE,
      env: { ...env }, idleMs: this.idleMs, extras: { ...this.extras(s.cwd, chat.project), ...(s.title ? { title: s.title } : {}) }, nextId: (kind) => this.nextId(kind),
    }, {
      message: (m) => {
        if (chat.session !== session) return;
        if (!initialized && m.type === 'system' && m.subtype === 'init') {
          initialized = true;
          first?.init(m.session_id);
          void this.loadModels(session);
        }
        if (chat.id === '') return; // nothing to show before the session has an id
        if (session.turn && chat.state.turn === 'idle') this.apply(chat, { op: 'meta', patch: { turn: 'running' } });
        this.onMessage(chat, m);
      },
      ask: (a) => {
        if (chat.session === session) this.showAsk(chat, a);
      },
      askGone: (id) => {
        if (chat.session === session) this.patch(chat, id, { status: 'expired' }, 'pending');
      },
      ended: (error) => {
        if (!initialized) first?.failed(error ?? new Error('Claude Code ended before the session started'));
        if (chat.session === session) this.ended(chat, error);
      },
    });
    return session;
  }

  private async loadModels(session: ClaudeSession): Promise<void> {
    if (this.models) return;
    try {
      const models = (await session.supportedModels()).map((m): ModelOption => ({
        id: m.value, label: m.displayName || m.value, isDefault: m.value === 'default',
        efforts: m.supportsEffort === false ? [] : (m.supportedEffortLevels ?? []).filter((e) => EFFORTS.has(e)),
      }));
      this.models = models;
      for (const chat of this.chats.values()) if (chat.state.models.length === 0) this.apply(chat, { op: 'meta', patch: { models } });
    } catch {
      // The picker stays empty; the session works without it.
    }
  }

  private onMessage(chat: Chat, m: SDKMessage): void {
    const out = claudeUpdates(m, { find: (id) => chat.state.items.find((i) => i.id === id), now: this.now(), stream: chat.stream });
    chat.stream = out.stream;
    for (const u of out.updates) this.apply(chat, u);
    if (out.signal) this.onSignal(chat, out.signal);
  }

  private onSignal(chat: Chat, signal: ClaudeSignal): void {
    const keyed = chat.state.apiKeyAuth === true;
    switch (signal.kind) {
      case 'init':
        chat.plugins = signal.plugins;
        // The mode the process really started in, which Claude Code may lower (Auto where the
        // account cannot have it): the picker shows it, and the chat says so.
        if (isMode(signal.mode) && signal.mode !== chat.state.mode) {
          if (isMode(chat.state.mode)) this.notice(chat, 'warn', `Claude Code started in ${modeLabel(signal.mode)}, not ${modeLabel(chat.state.mode)}.`);
          this.apply(chat, { op: 'meta', patch: { mode: signal.mode } });
        }
        if (chat.state.model === null || chat.chosenModel === null) this.apply(chat, { op: 'meta', patch: { model: chat.chosenModel ?? signal.model } });
        if (chat.state.cwd === '') this.apply(chat, { op: 'meta', patch: { cwd: signal.cwd } });
        return;
      case 'signedOut':
        if (!keyed) this.setSignedOut(true);
        return;
      case 'mode':
        // Claude Code moved on by itself (an approved plan leaves plan mode): the picker follows.
        if (isMode(signal.mode) && signal.mode !== chat.state.mode) this.apply(chat, { op: 'meta', patch: { mode: signal.mode } });
        return;
      case 'rateLimit':
        if (keyed) return;
        if (signal.info.rateLimitType) this.rateLimits.set(signal.info.rateLimitType, signal.info);
        this.onAccountChanged?.();
        return;
      case 'turnEnd':
        if (!keyed && (signal.signedOut || !signal.failed)) this.setSignedOut(!!signal.signedOut);
        if (signal.queued === 0) {
          // The turn is over: whatever still streams or runs in it has stopped.
          this.settleOpen(chat);
          this.apply(chat, { op: 'meta', patch: { turn: 'idle' } });
        }
    }
  }

  /** Review Focus 4 for a crash; a quiet close (idle, stop) for the rest. */
  private ended(chat: Chat, error: Error | null): void {
    const wasBusy = chat.state.turn === 'running' || chat.state.items.some((i) => (i.kind === 'approval' || i.kind === 'question') && i.status === 'pending');
    chat.session = null;
    for (const i of chat.state.items) {
      if ((i.kind === 'approval' || i.kind === 'question') && i.status === 'pending') this.apply(chat, { op: 'upsert', item: { ...i, status: 'expired' } });
    }
    this.settleOpen(chat);
    if (error && wasBusy) this.notice(chat, 'error', `Claude Code stopped unexpectedly (${error.message}). Your next message starts it again.`);
    // A crash mid-turn (not the app's own quit): the card says so until a new turn starts.
    if (error && wasBusy && !this.stopping) {
      this.interruptions.set(chat.id, { kind: 'error', reason: `Claude Code stopped unexpectedly (${error.message})`, at: this.now(), resetsAt: null });
    }
    // Written alongside another program that still has it open: back to following its writes.
    const owner: Owner = chat.shared && this.elsewhere(chat.id) ? 'elsewhere' : 'nobody';
    this.apply(chat, { op: 'meta', patch: { turn: 'idle', owner, banner: this.bannerFor(owner, chat.state.cwd, chat.project) } });
    if (!chat.emit) this.chats.delete(chat.id); // nobody is looking: the next open reads it afresh
    else this.followIfElsewhere(chat);
  }

  private settleOpen(chat: Chat): void {
    for (const i of chat.state.items) {
      if (i.kind === 'tool' && (i.status === 'running' || i.status === 'waiting')) this.apply(chat, { op: 'upsert', item: { ...i, status: 'failed' } });
      if ((i.kind === 'assistant' || i.kind === 'reasoning') && i.streaming) this.apply(chat, { op: 'upsert', item: { ...i, streaming: false } });
    }
  }

  private showAsk(chat: Chat, a: Ask): void {
    if (a.kind === 'question') {
      const raw = Array.isArray(a.input.questions) ? (a.input.questions as Record<string, unknown>[]) : [];
      const questions: Question[] = raw.map((q) => {
        const text = typeof q.question === 'string' ? q.question : '';
        const options = Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : [];
        return {
          id: text, header: typeof q.header === 'string' ? q.header : '', text, multiSelect: q.multiSelect === true, allowOther: true,
          options: options.map((o) => ({ label: String(o.label ?? ''), description: String(o.description ?? '') })),
        };
      });
      this.apply(chat, { op: 'upsert', item: { kind: 'question', id: a.id, at: this.now(), questions, status: 'pending', answers: null } });
      // Its call waits on the owner as an approval's does, and runs again once answered.
      this.patch(chat, a.toolUseID, { status: 'waiting' }, 'running');
      return;
    }
    const { target, output } = classifyClaudeTool(a.toolName, a.input);
    const description = typeof a.input.description === 'string' ? a.input.description : '';
    // A plan is approved from the card: all of it, never only its first line.
    // An MCP call is approved from all of its arguments, not only the first one.
    const detail = a.toolName === 'ExitPlanMode'
      ? output ?? 'Claude has a plan ready.'
      : [mcpToolName(a.toolName) ? mcpArguments(a.input) : target, mcpToolName(a.toolName) ? '' : description, a.reason ?? '', a.blockedPath ? `Outside the allowed folders: ${a.blockedPath}` : ''].filter((s) => s !== '').join('\n\n');
    this.apply(chat, { op: 'upsert', item: {
      kind: 'approval', id: a.id, at: this.now(), toolItemId: a.toolUseID, title: a.title ?? approvalTitle(a.toolName),
      detail, alwaysLabel: alwaysLabel(a.suggestions), status: 'pending',
    } });
    this.patch(chat, a.toolUseID, { status: 'waiting' }, 'running');
  }

  private usageWindows(limits: NonNullable<UsageResponse['rate_limits']>): UsageWindow[] {
    const out: UsageWindow[] = [];
    for (const [key, label] of WINDOWS) {
      const w = limits[key];
      if (!w) continue;
      out.push({ label, usedPercent: w.utilization, resetsAt: w.resets_at === null ? null : Date.parse(w.resets_at) });
    }
    return out;
  }

  /** rate_limit_event utilization is a fraction (0–1) and resetsAt is in seconds. */
  private eventWindows(): UsageWindow[] {
    return WINDOWS.flatMap(([key, label]) => {
      const info = this.rateLimits.get(key);
      if (!info) return [];
      return [{
        label, usedPercent: info.utilization === undefined ? null : Math.round(info.utilization * 1000) / 10,
        resetsAt: info.resetsAt === undefined ? null : info.resetsAt * 1000,
      }];
    });
  }

  private setSignedOut(out: boolean): void {
    if (this.signedOut === out) return;
    this.signedOut = out;
    for (const chat of this.chats.values()) {
      const banner = this.bannerFor(chat.state.owner, chat.state.cwd, chat.project);
      if (chat.state.banner !== banner) this.apply(chat, { op: 'meta', patch: { banner } });
    }
  }

  /** The chat's banner: read-only while another program has it, then the engine's own (signed out). */
  private bannerFor(owner: Owner, cwd: string, project?: ProjectProfile): string | null {
    return [owner === 'elsewhere' ? READ_ONLY_BANNER : null, this.agentKey?.cwd === cwd || project?.connection === 'claude-api' ? null : this.banner].filter((b) => b !== null).join(' · ') || null;
  }

  // ── State helpers ───────────────────────────────────────────────────────────────────────

  /** A chat not running here, read afresh (another app may have written to it meanwhile). */
  private async readFresh(sessionId: string, known: Chat | undefined, ownerNow?: Owner): Promise<Chat> {
    const project = this.projectFor?.(sessionId);
    const file = await findTranscript(this.projectsDir, sessionId);
    // Before the read, so a write during it shows as a change on the next look.
    const seen = file ? await statOf(file) : null;
    const taken = new Set<string>();
    const page = file ? await claudeHistory(file, { limit: PAGE, before: null, taken }) : { items: [], hasOlder: false, cursor: null };
    const facts = file ? await tailFacts(file) : { cwd: '', model: null, mode: null };
    // The mode the session last ran in carries over; Bypass never does by itself, it is picked here
    // (main restores a saved pick). With none, Auto: the picker shows the mode the next process
    // really starts in, so a saved pick that differs is put back before it starts.
    const lastMode = facts.mode !== null && isMode(facts.mode) && facts.mode !== 'bypassPermissions' ? facts.mode : null;
    const owner: Owner = ownerNow ?? (this.elsewhere(sessionId) ? 'elsewhere' : 'nobody');
    return {
      project, id: sessionId, emit: null, session: null, stream: freshStream(), file, cursor: page.cursor, taken,
      newestTaken: new Set(taken), seen, follow: null,
      chosenModel: known?.chosenModel ?? null, chosenEffort: known?.chosenEffort ?? null, restart: false, plugins: [],
      state: {
        // A call with no result may still be running in the program that has the session open.
        sessionId, provider: 'claude', owner, title: '', cwd: facts.cwd, items: owner === 'elsewhere' ? page.items : settleLost(page.items),
        hasOlder: page.hasOlder, turn: 'idle', model: known?.chosenModel ?? facts.model, models: this.models ?? [],
        mode: known?.state.mode ?? lastMode ?? FALLBACK_MODE, modes: MODES, banner: this.bannerFor(owner, facts.cwd, project), apiKeyAuth: this.agentKey?.cwd === facts.cwd || project?.connection === 'claude-api',
      },
    };
  }

  // ── Following a chat another program writes ─────────────────────────────────────────────

  /** While the chat is open here and another program has the session, its transcript is looked
      at every followMs: a cheap stat, and the newest page re-read only when the file changed. */
  private followIfElsewhere(chat: Chat): void {
    if (chat.follow || !chat.emit || chat.state.owner !== 'elsewhere') return;
    let reading: Promise<void> | null = null;
    chat.follow = setInterval(() => {
      if (this.chats.get(chat.id) !== chat || !chat.emit || chat.state.owner !== 'elsewhere') {
        this.unfollow(chat);
        return;
      }
      if (!this.elsewhere(chat.id)) {
        // The other program let go. What it wrote on its way out (a call's result, the reply) is
        // read once more after any read in flight, or the chat would end on a stale page.
        this.unfollow(chat);
        void (reading ?? Promise.resolve()).then(() => this.lastLook(chat)).catch(() => {});
        return;
      }
      if (reading) return;
      reading = this.reread(chat).catch(() => {}).finally(() => { reading = null; });
    }, this.followMs);
    chat.follow.unref?.();
  }

  /** The last read of a chat the other program let go of. A call still without a result then will
      never get one (as after Move here), unless the session was taken again meanwhile. */
  private async lastLook(chat: Chat): Promise<void> {
    await this.reread(chat, true);
    if (this.chats.get(chat.id) !== chat || chat.state.owner !== 'elsewhere' || chat.follow !== null || chat.session || this.elsewhere(chat.id)) return;
    for (const i of chat.state.items) {
      if (i.kind === 'tool' && (i.status === 'running' || i.status === 'waiting')) this.apply(chat, { op: 'upsert', item: { ...i, status: 'failed' } });
    }
  }

  private unfollow(chat: Chat): void {
    if (chat.follow) clearInterval(chat.follow);
    chat.follow = null;
  }

  /** `last`: the final read after following stopped (lastLook), so no follow is running. */
  private async reread(chat: Chat, last = false): Promise<void> {
    const file = chat.file ?? await findTranscript(this.projectsDir, chat.id);
    if (!file) return;
    const st = await statOf(file);
    if (!st) return;
    const prev = chat.file === file ? chat.seen : null;
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.ino === st.ino) return;
    const still = () => this.chats.get(chat.id) === chat && chat.state.owner === 'elsewhere' && (chat.follow !== null || last);
    if (!prev || st.ino !== prev.ino || st.size < prev.size) {
      // Shrunk or replaced: what was shown may be gone, so start again from a fresh newest page.
      const fresh = await this.readFresh(chat.id, chat, 'elsewhere');
      if (!still()) return;
      Object.assign(chat, { ...fresh, emit: chat.emit, follow: chat.follow, state: { ...fresh.state, title: chat.state.title } });
      chat.emit?.({ op: 'reset', state: chat.state });
      return;
    }
    // Records older pages show stay taken; the newest page's own may be shown again by the re-read.
    const taken = new Set([...chat.taken].filter((u) => !chat.newestTaken.has(u)));
    const before = new Set(taken);
    const page = await claudeHistory(file, { limit: PAGE, before: null, taken });
    if (!still()) return;
    const newest = new Set([...taken].filter((u) => !before.has(u)));
    for (const u of newest) chat.taken.add(u);
    chat.newestTaken = newest;
    chat.seen = st;
    for (const item of page.items) {
      const shown = chat.state.items.find((i) => i.id === item.id);
      if (!shown || JSON.stringify(shown) !== JSON.stringify(item)) this.apply(chat, { op: 'upsert', item });
    }
  }

  private nextId(kind: string): string {
    return `${kind}-${++this.seq}`;
  }

  private chat(sessionId: string): Chat {
    const chat = this.chats.get(sessionId);
    if (!chat) throw new Error('This Claude chat is not open');
    return chat;
  }

  private apply(chat: Chat, u: ChatUpdate): void {
    if (u.op === 'meta' && u.patch.turn === 'running') this.interruptions.delete(chat.id);
    chat.state = applyUpdate(chat.state, u);
    chat.emit?.(u);
  }

  /** Changes fields of one item (optionally only while its status is `onlyFrom`). */
  private patch(chat: Chat, id: string, fields: Record<string, unknown>, onlyFrom?: string): void {
    const item = chat.state.items.find((i) => i.id === id);
    if (!item || (onlyFrom !== undefined && (item as { status?: string }).status !== onlyFrom)) return;
    this.apply(chat, { op: 'upsert', item: { ...item, ...fields } as ChatItem });
  }

  private notice(chat: Chat, level: 'info' | 'warn' | 'error', text: string): void {
    this.apply(chat, { op: 'upsert', item: { kind: 'notice', id: `notice-${++this.seq}`, at: this.now(), level, text } });
  }
}
