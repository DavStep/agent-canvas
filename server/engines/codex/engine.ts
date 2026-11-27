// CodexEngine: Codex chats driven through the one `codex app-server`. Each open thread keeps its
// ChatState (changed only through applyUpdate), the server requests waiting on the owner, and
// the running turn. Session ids are Codex thread ids. The engine never archives a thread.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderAccount, UsageWindow } from '../../../shared/account.ts';
import { MISSING_BANNER, NO_ANSWER_BANNER, NOT_STARTED_BANNER } from '../../../shared/banners.ts';
import type { NewSessionRequest, ProviderOptions } from '../../../shared/bridge.ts';
import type {
  ApprovalAnswer, ChatItem, ChatState, ChatUpdate, ImageRef, ModelOption, ModeOption, Owner, Question,
} from '../../../shared/chat.ts';
import type { SessionInterruption } from '../../../shared/types.ts';
import { codexFailure } from '../../interruptions.ts';
import { applyUpdate } from '../chatLog.ts';
import type { ProjectProfile } from '../../agent/project.ts';
import type { BusySession, Engine, StartOptions } from '../engine.ts';
import { callCanvasTool, codexAgentOptions, type CodexCanvasAgent } from '../../agent/codex.ts';
import type { DynamicToolCallParams } from './protocol/v2/DynamicToolCallParams.ts';
import { codexItems, itemUpdates, unwrapShell } from './map.ts';
import type { AskForApproval } from './protocol/v2/AskForApproval.ts';
import type { CommandExecutionApprovalDecision } from './protocol/v2/CommandExecutionApprovalDecision.ts';
import type { ConfigReadResponse } from './protocol/v2/ConfigReadResponse.ts';
import type { CommandExecutionRequestApprovalParams } from './protocol/v2/CommandExecutionRequestApprovalParams.ts';
import type { FileChangeRequestApprovalParams } from './protocol/v2/FileChangeRequestApprovalParams.ts';
import type { GetAccountRateLimitsResponse } from './protocol/v2/GetAccountRateLimitsResponse.ts';
import type { GetAccountResponse } from './protocol/v2/GetAccountResponse.ts';
import type { ModelListResponse } from './protocol/v2/ModelListResponse.ts';
import type { RateLimitWindow } from './protocol/v2/RateLimitWindow.ts';
import type { SandboxMode } from './protocol/v2/SandboxMode.ts';
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy.ts';
import type { Thread } from './protocol/v2/Thread.ts';
import type { ThreadAttachmentListResponse } from './protocol/v2/ThreadAttachmentListResponse.ts';
import type { TurnPlanUpdatedNotification } from './protocol/v2/TurnPlanUpdatedNotification.ts';
import type { ThreadLoadedListResponse } from './protocol/v2/ThreadLoadedListResponse.ts';
import type { ThreadReadResponse } from './protocol/v2/ThreadReadResponse.ts';
import type { ThreadResumeResponse } from './protocol/v2/ThreadResumeResponse.ts';
import type { ThreadStartResponse } from './protocol/v2/ThreadStartResponse.ts';
import type { ThreadTurnsListResponse } from './protocol/v2/ThreadTurnsListResponse.ts';
import type { ToolRequestUserInputParams } from './protocol/v2/ToolRequestUserInputParams.ts';
import type { ToolRequestUserInputResponse } from './protocol/v2/ToolRequestUserInputResponse.ts';
import type { Turn } from './protocol/v2/Turn.ts';
import type { TurnError } from './protocol/v2/TurnError.ts';
import type { TurnStartResponse } from './protocol/v2/TurnStartResponse.ts';
import { RpcError, type RpcClient } from './rpc.ts';
import { CodexMissingError, CodexServer, CodexStartError, defaultSpawn, type SpawnLike } from './server.ts';

export { MISSING_BANNER, NO_ANSWER_BANNER, NOT_STARTED_BANNER, READ_ONLY_BANNER } from '../../../shared/banners.ts';
export const QUITTING = 'Agent canvas is quitting';
const PAGE = 200;
const TURNS_PER_REQUEST = 50;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const POLL_MS = 2_000;
/** Turns re-read when a read-only chat's thread changed: the one being written and the one before. */
const RECENT_TURNS = 2;
/** updatedAt counts whole seconds, so a write in the same second as our last look would be missed;
    while the thread changed this recently, the newest turns are re-read anyway. */
const RECENT_WRITE_S = 3;
/** What `thread/resume` answers (code -32600) when another process holds the thread. */
const WRITER_ERROR = /already has an active writer/;

type ModeId = 'read-only' | 'auto' | 'full-access';
const MODES: ModeOption[] = [{ id: 'read-only', label: 'Read only' }, { id: 'auto', label: 'Auto' }, { id: 'full-access', label: 'Full access' }];
const PRESETS: Record<ModeId, { approvalPolicy: AskForApproval; sandbox: SandboxMode; sandboxPolicy: SandboxPolicy }> = {
  'read-only': { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
  auto: {
    approvalPolicy: 'on-request', sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  },
  'full-access': { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } },
};
const isMode = (m: string): m is ModeId => Object.hasOwn(PRESETS, m);

/** `availableDecisions` is an experimental field (we initialize with experimentalApi), so the
    stable generated params lack it. */
type CommandApproval = CommandExecutionRequestApprovalParams & { availableDecisions?: CommandExecutionApprovalDecision[] | null };

interface Decisions { always: CommandExecutionApprovalDecision | null; deny: CommandExecutionApprovalDecision; alwaysLabel: string | null }

interface Pending {
  kind: 'approval' | 'question';
  rpc: RpcClient;
  rpcId: number | string;
  toolItemId: string | null;
  decisions: Decisions | null;
  cancelOnExpiry?: boolean;
  reply(result: unknown): void;
}

interface ThreadRun {
  project?: ProjectProfile;
  captureRequest?: number;
  id: string;
  state: ChatState;
  emit: ((u: ChatUpdate) => void) | null;
  /** The server process it is loaded on, while this app owns it. */
  rpc: RpcClient | null;
  turnId: string | null;
  lastTurnId: string | null;
  /** The turn the owner pressed Stop on: its interrupted end is no interruption. */
  manualStopId?: string;
  /** Server requests waiting on the owner, by chat item id. */
  pending: Map<string, Pending>;
  /** Items read from history but not shown yet (older than the page, local images not inlined),
      and whether more turns exist. */
  older: ChatItem[];
  cursor: string | null;
  more: boolean;
  /** How a read-only chat reads: pages of turns, or (if the server refuses that for a thread it
      does not hold) the whole thread once on open and again only when it changed. */
  reads: 'turns' | 'whole';
  /** The last updatedAt and status a read-only chat's poll saw. */
  lastUpdatedAt: number | null;
  lastStatus: string | null;
  /** The shown mode is binding: sent as a preset with the next turn/start, and kept over the
      thread's own sandbox on a resume. Set by a pick here (or main's restore of a saved one). */
  modeChanged: boolean;
  /** The owner picked a mode here (or main restored a saved one): a resume, eager or lazy, keeps
      it rather than the thread's own sandbox. */
  modePicked: boolean;
  /** The owner picked a model here: a resume keeps it rather than the thread's own. */
  modelChosen: boolean;
  /** The thinking level picked when the chat started here: sent with each turn/start (null: the model's own). */
  effort?: string | null;
  poll: NodeJS.Timeout | null;
  /** Raw item JSON last seen by a read-only chat, by item id. */
  seen: Map<string, string>;
}

export interface CodexEngineOptions {
  agent?: CodexCanvasAgent;
  codexPath: string | null;
  /** Recheck installed binaries before each new app-server process. */
  resolveCodexPath?: () => Promise<string | null>;
  spawn?: SpawnLike;
  now?: () => number;
  /** How often a read-only (elsewhere) chat re-reads its history. */
  pollMs?: number;
  /** How long the app server's handshake may take (15 s by default). */
  handshakeMs?: number;
  /** Usage changed (account/rateLimits/updated): the profile page may want account() again. */
  onAccountChanged?: () => void;
  /** Whether another program writes the thread now (the store's call, as of its last poll): such
      a chat opens read-only and is followed. */
  elsewhere?: (threadId: string) => boolean;
  /** The environment the app server runs with (childEnv by default). */
  env?: Record<string, string>;
  /** How long a request may wait for its answer (60 s by default). */
  requestTimeoutMs?: number;
}

const isWriterError = (e: unknown): boolean => e instanceof RpcError && WRITER_ERROR.test(e.message);

/** 300 → "5 h", 10080 → "Weekly", other whole days → "<n> d", else hours. */
export function windowLabel(mins: number | null): string {
  if (mins === null) return 'Usage';
  if (mins === 10080) return 'Weekly';
  if (mins % 1440 === 0) return `${mins / 1440} d`;
  return `${Math.round((mins / 60) * 10) / 10} h`;
}

/** Codex wraps upstream API errors as a JSON string; the owner wants the message inside. */
function errorText(error: TurnError | null): string {
  if (!error) return 'The turn failed';
  try {
    const inner = JSON.parse(error.message) as { error?: { message?: unknown }; message?: unknown };
    const message = inner.error?.message ?? inner.message;
    if (typeof message === 'string' && message !== '') return message;
  } catch {
    // Plain text already.
  }
  return error.message;
}

function decisionsFor(params: CommandApproval): Decisions {
  const offered = params.availableDecisions ?? null; // absent on older servers: the standard set
  const has = (d: string) => offered === null || offered.includes(d as CommandExecutionApprovalDecision);
  const amendment = offered?.find((d): d is Extract<CommandExecutionApprovalDecision, { acceptWithExecpolicyAmendment: unknown }> =>
    typeof d === 'object' && 'acceptWithExecpolicyAmendment' in d);
  if (has('acceptForSession')) return { always: 'acceptForSession', deny: has('decline') ? 'decline' : 'cancel', alwaysLabel: 'this session' };
  const prefix = amendment?.acceptWithExecpolicyAmendment.execpolicy_amendment.join(' ');
  return {
    always: amendment ?? null,
    deny: has('decline') ? 'decline' : 'cancel',
    alwaysLabel: amendment ? `your Codex rules, permanently (not just this session): commands starting with \`${prefix}\`` : null,
  };
}

/** The preset nearest the owner's own Codex config (config.toml): what a new chat shows chosen.
    Started with it, a chat gets no preset at all, so the config applies exactly as written. */
function configMode(config: { sandbox_mode: SandboxMode | null }): ModeId {
  if (config.sandbox_mode === 'danger-full-access') return 'full-access';
  if (config.sandbox_mode === 'read-only') return 'read-only';
  return 'auto';
}

function modeOf(sandbox: SandboxPolicy | null | undefined): ModeId {
  if (sandbox?.type === 'readOnly') return 'read-only';
  if (sandbox?.type === 'dangerFullAccess') return 'full-access';
  return 'auto';
}

async function readImage(file: string, mime: string): Promise<ImageRef | string> {
  try {
    if ((await fs.stat(file)).size > MAX_IMAGE_BYTES) return `Image not shown (over 5 MB): ${path.basename(file)}`;
    return { mime, dataUrl: `data:${mime};base64,${(await fs.readFile(file)).toString('base64')}` };
  } catch {
    return `Image not shown (cannot read it): ${path.basename(file)}`;
  }
}

/** The page cannot load file: URLs, so local images become data URLs, or a notice beside the
    message when the file is too big or gone. */
async function inlineImages(items: ChatItem[]): Promise<ChatItem[]> {
  const local = (i: ChatItem) => i.kind === 'user' && i.images.some((img) => img.dataUrl.startsWith('file:'));
  if (!items.some(local)) return items;
  const out: ChatItem[] = [];
  for (const item of items) {
    if (item.kind !== 'user' || !local(item)) {
      out.push(item);
      continue;
    }
    const images: ImageRef[] = [];
    const notices: ChatItem[] = [];
    for (const [n, img] of item.images.entries()) {
      const shown = img.dataUrl.startsWith('file:') ? await readImage(fileURLToPath(img.dataUrl), img.mime) : img;
      if (typeof shown === 'string') notices.push({ kind: 'notice', id: `${item.id}:image:${n}`, at: item.at, level: 'warn', text: shown });
      else images.push(shown);
    }
    out.push({ ...item, images }, ...notices);
  }
  return out;
}

export class CodexEngine implements Engine {
  readonly provider = 'codex' as const;
  readonly interruptions = new Map<string, SessionInterruption>();
  private readonly server: CodexServer;
  private readonly agent?: CodexCanvasAgent;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly onAccountChanged: (() => void) | null;
  private readonly elsewhere: (threadId: string) => boolean;
  private readonly withoutAttachments = new WeakSet<RpcClient>();
  private readonly threads = new Map<string, ThreadRun>();
  private loaded = new Set<string>();
  /** Threads let go here that the server still holds until it unloads them. */
  private released = new Set<string>();
  private readonly models = new WeakMap<RpcClient, ModelOption[]>();
  private missing: boolean;
  private notStarted = false;
  /** A request went unanswered; cleared when the server answers again. */
  private noAnswer = false;
  private seq = 0;
  /** Notifications and server requests are handled one at a time, in arrival order. */
  private queue: Promise<void> = Promise.resolve();
  /** Set by stop(): the app server is not started again. */
  private stopping = false;

  constructor(opts: CodexEngineOptions) {
    this.agent = opts.agent;
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.onAccountChanged = opts.onAccountChanged ?? null;
    this.elsewhere = opts.elsewhere ?? (() => false);
    this.missing = opts.codexPath === null;
    this.server = new CodexServer({
      codexPath: opts.resolveCodexPath ?? opts.codexPath,
      spawn: opts.spawn ?? defaultSpawn,
      setup: (rpc) => this.setup(rpc),
      onExit: (rpc, reason) => this.enqueue(() => this.serverExited(rpc, reason)),
      ...(opts.handshakeMs ? { handshakeMs: opts.handshakeMs } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.requestTimeoutMs ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    });
  }

  /** Why Codex cards cannot work fully right now (missing program, hung server, a request that
      went unanswered), or null. */
  get banner(): string | null {
    return this.missing ? MISSING_BANNER : this.notStarted ? NOT_STARTED_BANNER : this.noAnswer ? NO_ANSWER_BANNER : null;
  }

  // ── Engine ──────────────────────────────────────────────────────────────────────────────

  async open(sessionId: string, emit: (u: ChatUpdate) => void): Promise<ChatState> {
    const known = this.threads.get(sessionId);
    if (known?.rpc && !known.rpc.closed) {
      known.emit = emit;
      return known.state;
    }
    if (known) this.forget(known);
    const rpc = await this.ensure();
    const models = await this.loadModels(rpc);
    // Viewing never takes the thread's writer lock (the Codex app could not open it meanwhile, nor
    // for a minute after): it is read here, and resumed only by the first thing that writes.
    const run = await this.openReadOnly(sessionId, rpc, models, this.elsewhere(sessionId) ? 'elsewhere' : 'nobody');
    const page = await this.takePage(run);
    run.state = { ...run.state, items: [...page, ...run.state.items], hasOlder: run.older.length > 0 || run.more };
    run.emit = emit;
    return run.state;
  }

  close(sessionId: string): void {
    const run = this.threads.get(sessionId);
    if (!run) return;
    run.emit = null;
    this.stopPoll(run);
    // Keep a running thread going; an idle one is let go so other apps may open it.
    if (!run.rpc) this.threads.delete(sessionId);
    else if (!run.turnId && run.pending.size === 0) this.release(run);
  }

  async loadOlder(sessionId: string): Promise<void> {
    const run = this.run(sessionId);
    if (run.older.length < PAGE && run.more) await this.readTurns(run, run.rpc && !run.rpc.closed ? run.rpc : await this.ensure(), PAGE);
    const page = await this.takePage(run);
    this.apply(run, { op: 'older', items: page, hasOlder: run.older.length > 0 || run.more });
  }

  async send(sessionId: string, text: string, images: ImageRef[]): Promise<void> {
    this.refuseIfStopping();
    const run = this.run(sessionId);
    const rpc = await this.ensure();
    const clientUserMessageId = `local-${randomUUID()}`;
    const input = [
      ...(text !== '' ? [{ type: 'text', text, text_elements: [] }] : []),
      ...images.map((i) => ({ type: 'image', url: i.dataUrl })),
    ];
    const user = { kind: 'user' as const, id: clientUserMessageId, at: this.now(), text, images };
    if (run.state.owner === 'elsewhere' || !await this.attach(run, rpc)) {
      try {
        await rpc.request('thread/queue/add', { threadId: run.id, input, clientUserMessageId });
      } catch (err) {
        if (err instanceof RpcError && err.code === -32601) throw new Error('This Codex version cannot queue messages. Close the chat in the other app and choose Move here.');
        throw err;
      }
      // History may already contain the consumed submission. Its clientId is also our item ID.
      if (!run.state.items.some(i => i.id === clientUserMessageId)) this.apply(run, { op: 'upsert', item: { ...user, queued: true } });
      return;
    }
    this.apply(run, { op: 'upsert', item: user });
    if (run.turnId) {
      try {
        await rpc.request('turn/steer', { threadId: run.id, input, expectedTurnId: run.turnId, clientUserMessageId });
        return;
      } catch (err) {
        if (run.turnId !== null) {
          this.notice(run, 'error', `Not sent: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
        // The turn ended meanwhile: start a new one below.
      }
    }
    this.apply(run, { op: 'meta', patch: { turn: 'running', plan: [] } });
    const preset = run.modeChanged && isMode(run.state.mode) ? PRESETS[run.state.mode] : null;
    try {
      const { turn } = await rpc.request<TurnStartResponse>('turn/start', {
        threadId: run.id, input, model: run.state.model, clientUserMessageId,
        ...(run.effort ? { effort: run.effort } : {}),
        ...(preset ? { approvalPolicy: preset.approvalPolicy, sandboxPolicy: preset.sandboxPolicy } : {}),
      });
      run.modeChanged = false;
      if (turn.id !== run.lastTurnId && turn.status === 'inProgress') run.turnId = turn.id;
    } catch (err) {
      this.apply(run, { op: 'meta', patch: { turn: 'idle' } });
      this.notice(run, 'error', `Not sent: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const run = this.run(sessionId);
    if (!run.turnId || !run.rpc || run.rpc.closed) return;
    const turnId = run.turnId;
    run.manualStopId = turnId;
    try {
      await run.rpc.request('turn/interrupt', { threadId: run.id, turnId });
    } catch (err) {
      if (run.manualStopId === turnId) delete run.manualStopId;
      throw err;
    }
  }

  async answerApproval(sessionId: string, approvalId: string, answer: ApprovalAnswer): Promise<void> {
    const run = this.run(sessionId);
    const pending = run.pending.get(approvalId);
    if (!pending?.decisions) throw new Error('This approval is no longer waiting');
    const decision = answer === 'allow' ? 'accept' : answer === 'allowAlways' ? pending.decisions.always : pending.decisions.deny;
    if (decision === null) throw new Error('"Always allow" is not offered for this request');
    run.pending.delete(approvalId);
    pending.reply({ decision });
    this.patch(run, approvalId, { status: answer === 'allow' ? 'allowed' : answer === 'allowAlways' ? 'allowedAlways' : 'denied' });
    if (pending.toolItemId) this.patch(run, pending.toolItemId, { status: answer === 'deny' ? 'denied' : 'running' }, 'waiting');
  }

  async answerQuestion(sessionId: string, questionId: string, answers: Record<string, string>): Promise<void> {
    const run = this.run(sessionId);
    const pending = run.pending.get(questionId);
    if (pending?.kind !== 'question') throw new Error('This question is no longer waiting');
    run.pending.delete(questionId);
    const reply: ToolRequestUserInputResponse = {
      answers: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, { answers: [value] }])),
    };
    pending.reply(reply);
    // A secret answer goes to Codex only: the thread keeps an empty string in its place.
    const item = run.state.items.find((i) => i.id === questionId);
    const secret = new Set(item?.kind === 'question' ? item.questions.filter((q) => q.isSecret).map((q) => q.id) : []);
    const kept = Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, secret.has(id) ? '' : value]));
    this.patch(run, questionId, { status: 'answered', answers: kept });
  }

  /** Kept here and sent with the next turn/start, which resumes the thread first: picking takes
      no writer lock by itself (main also re-applies saved picks each time a chat opens). A chat
      another app holds records the pick too, for when it is moved here. */
  async setModel(sessionId: string, model: string): Promise<void> {
    const run = this.run(sessionId);
    if (run.state.models.length > 0 && !run.state.models.some((m) => m.id === model)) throw new Error(`Unknown Codex model: ${model}`);
    run.modelChosen = true;
    this.apply(run, { op: 'meta', patch: { model } });
  }

  async setModelProfile(sessionId: string, model: string, effort: string): Promise<void> {
    const run = this.run(sessionId);
    if (run.state.model === model && run.effort === effort) return;
    if (run.turnId) throw new Error('Wait for this turn to finish before changing models.');
    run.modelChosen = true;
    run.effort = effort;
    this.apply(run, { op: 'meta', patch: { model, effort } });
  }

  async setMode(sessionId: string, mode: string): Promise<void> {
    const run = this.run(sessionId);
    if (!isMode(mode)) throw new Error(`Unknown Codex permission preset: ${mode}`);
    run.modePicked = true;
    run.modeChanged = true; // sent with the next turn/start
    this.apply(run, { op: 'meta', patch: { mode } });
  }

  async moveHere(sessionId: string): Promise<boolean> {
    this.refuseIfStopping();
    const run = this.run(sessionId);
    if (run.rpc && !run.rpc.closed) return true;
    const rpc = await this.ensure();
    const models = await this.loadModels(rpc);
    let resumed: ThreadResumeResponse;
    try {
      resumed = await rpc.request<ThreadResumeResponse>('thread/resume', { threadId: sessionId, excludeTurns: true, ...codexAgentOptions(this.agent, run.state.cwd, false, run.project) });
    } catch (err) {
      if (isWriterError(err)) return false;
      throw err;
    }
    this.stopPoll(run);
    this.claim(run, rpc);
    // History from the server that now holds it, replacing the read-only copy.
    run.older = [];
    run.cursor = null;
    run.more = true;
    run.reads = 'turns';
    let page: ChatItem[];
    try {
      await this.readTurns(run, rpc, PAGE);
      page = await this.takePage(run);
    } catch (err) {
      // Resumed but not shown: let the thread go again rather than hold its lock unseen.
      this.unclaim(run, rpc);
      if (run.emit && run.state.owner === 'elsewhere') this.startPoll(run, rpc);
      throw err;
    }
    run.seen.clear();
    // The owner's picks (made, or restored, while another app held it) stay and go out with the
    // next turn. Otherwise the thread's own model and sandbox show, which its turns run under
    // without a preset.
    run.modeChanged = run.modePicked;
    const state: ChatState = {
      ...run.state, owner: 'here', banner: this.banner, items: page, hasOlder: run.older.length > 0 || run.more,
      turn: 'idle', models,
      model: run.modelChosen ? run.state.model : this.pickModel(resumed.model, models),
      mode: run.modePicked ? run.state.mode : modeOf(resumed.sandbox),
    };
    this.apply(run, { op: 'reset', state });
    return true;
  }

  async rename(id: string, title: string): Promise<void> {
    const rpc = await this.ensure();
    await rpc.request('thread/name/set', { threadId: id, name: title });
    const run = this.threads.get(id);
    if (run) this.apply(run, { op: 'meta', patch: { title } });
  }

  async start(req: NewSessionRequest, options: StartOptions = {}): Promise<string> {
    this.refuseIfStopping();
    if (req.mode !== null && !isMode(req.mode)) throw new Error(`Unknown Codex permission preset: ${req.mode}`);
    const rpc = await this.ensure();
    const models = await this.loadModels(rpc);
    const config = await this.ownConfig(rpc, req.cwd);
    const own = config.mode;
    const model = req.model ?? this.pickModel(config.model, models);
    const mode = (req.mode ?? own) as ModeId;
    // The owner's own Codex settings apply unless another preset was picked for this chat.
    const preset = mode === own ? {} : { approvalPolicy: PRESETS[mode].approvalPolicy, sandbox: PRESETS[mode].sandbox };
    const started = await rpc.request<ThreadStartResponse>('thread/start', { cwd: req.cwd, model, ...preset, ...codexAgentOptions(this.agent, req.cwd, true, options.project) });
    const run = this.track(started.thread, rpc, { owner: 'here', cwd: started.cwd, models, model, mode: mode === own ? modeOf(started.sandbox) : mode });
    run.project = options.project;
    if (options.title) await this.rename(run.id, options.title);
    run.more = false;
    run.effort = req.effort;
    this.apply(run, { op: "meta", patch: { effort: req.effort } });
    await this.send(run.id, req.text, req.images);
    return run.id;
  }

  /** model/list's models (listed once) and the three presets, with the owner's Codex config's
      model (when listed) and matching preset chosen. */
  async options(): Promise<ProviderOptions> {
    const rpc = await this.ensure();
    const models = await this.loadModels(rpc);
    const config = await this.ownConfig(rpc, null);
    const model = this.pickModel(config.model, models);
    const efforts = models.find((m) => m.id === model)?.efforts ?? [];
    const effort = config.effort !== null && efforts.includes(config.effort) ? config.effort : null;
    return { models, model, effort, modes: MODES, mode: config.mode };
  }

  /** The owner's Codex config as seen from cwd: its model and the preset matching it. Auto and
      no model if it cannot be read. */
  private async ownConfig(rpc: RpcClient, cwd: string | null): Promise<{ mode: ModeId; model: string | null; effort: string | null }> {
    try {
      const { config } = await rpc.request<ConfigReadResponse>('config/read', { cwd });
      const effort = (config as { model_reasoning_effort?: unknown }).model_reasoning_effort;
      return { mode: configMode(config), model: typeof config.model === 'string' ? config.model : null, effort: typeof effort === 'string' ? effort : null };
    } catch {
      return { mode: 'auto', model: null, effort: null };
    }
  }

  lost(sessionId: string): void {
    const run = this.threads.get(sessionId);
    if (!run) return;
    const rpc = run.rpc;
    if (rpc) {
      // Stop this app's turn, then let go; the other program's process is never touched.
      const turnId = run.turnId;
      this.settleOpen(run);
      run.turnId = null;
      run.rpc = null;
      this.released.add(run.id);
      if (!rpc.closed) {
        const interrupted = turnId ? rpc.request('turn/interrupt', { threadId: run.id, turnId }).catch(() => {}) : Promise.resolve();
        void interrupted.then(() => rpc.request('thread/unsubscribe', { threadId: run.id })).then(() => this.refreshLoaded(rpc), () => {});
      }
    }
    this.apply(run, { op: 'meta', patch: { owner: 'elsewhere', turn: 'idle', banner: this.banner } });
    if (!run.emit) {
      this.forget(run);
      return;
    }
    // Followed read-only, as any chat another program writes.
    void this.ensure().then((r) => { if (this.threads.get(run.id) === run && run.state.owner === 'elsewhere') this.startPoll(run, r); }, () => {});
  }

  owned(): Set<string> {
    return new Set(this.loaded);
  }

  releasing(): Set<string> {
    return new Set([...this.released].filter((id) => this.loaded.has(id)));
  }

  busy(): BusySession[] {
    return [...this.threads.values()].flatMap((run): BusySession[] => {
      const pending = [...run.pending.values()];
      if (pending.some((p) => p.kind === 'approval')) return [{ sessionId: run.id, reason: 'approval' }];
      if (pending.length > 0) return [{ sessionId: run.id, reason: 'question' }];
      return run.turnId ? [{ sessionId: run.id, reason: 'turn' }] : [];
    });
  }

  usageAllowedAt: number | null = null;
  private accountRead: Promise<ProviderAccount> | null = null;

  account(): Promise<ProviderAccount> {
    this.accountRead ??= this.readAccount().finally(() => { this.accountRead = null; });
    return this.accountRead;
  }

  private async readAccount(): Promise<ProviderAccount> {
    const none: ProviderAccount = { provider: 'codex', signedIn: false, email: null, plan: null, windows: [], note: MISSING_BANNER };
    if (this.stopping) return { ...none, note: QUITTING };
    let rpc: RpcClient;
    try {
      rpc = await this.ensure();
    } catch (err) {
      return { ...none, note: err instanceof CodexMissingError ? MISSING_BANNER : err instanceof CodexStartError ? NOT_STARTED_BANNER : `Codex did not start: ${String(err)}` };
    }
    let account: GetAccountResponse['account'];
    try {
      ({ account } = await rpc.request<GetAccountResponse>('account/read', { refreshToken: false }));
    } catch (err) {
      return { ...none, note: `Codex could not read the account: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (account?.type !== 'chatgpt') this.usageAllowedAt = null;
    if (!account) return { ...none, note: 'Not signed in. Run `codex login` in a terminal.' };
    const out: ProviderAccount = {
      ...none, signedIn: true, note: null,
      email: account.type === 'chatgpt' ? account.email : null,
      plan: account.type === 'chatgpt' ? account.planType : account.type === 'apiKey' ? 'API key' : account.type === 'amazonBedrock' ? 'Amazon Bedrock' : account.type === 'gcp' ? 'Google Cloud' : null,
    };
    try {
      const requestedAt = this.now();
      const { rateLimits, rateLimitResetCredits, ordinaryUsageAllowed } = await rpc.request<GetAccountRateLimitsResponse>(
        'account/rateLimits/read', { excludeResetCreditDetails: true },
      );
      this.usageAllowedAt = account.type === 'chatgpt' && ordinaryUsageAllowed === true ? requestedAt : null;
      if (rateLimitResetCredits?.availableCount != null) {
        const count = Number(rateLimitResetCredits.availableCount);
        if (Number.isSafeInteger(count) && count >= 0) out.availableResets = count;
      }
      const window = (w: RateLimitWindow): UsageWindow =>
        ({ label: windowLabel(w.windowDurationMins), usedPercent: w.usedPercent, resetsAt: w.resetsAt === null ? null : w.resetsAt * 1000 });
      out.windows = [rateLimits.primary, rateLimits.secondary].filter((w): w is RateLimitWindow => w !== null).map(window);
      const credits = rateLimits.credits;
      if (credits?.hasCredits) out.note = `Credits: ${credits.unlimited ? 'unlimited' : credits.balance ?? 'available'}`;
    } catch {
      // Usage is extra; the account itself is known.
    }
    return out;
  }

  /** Quit: nothing new starts from now on (send, start and moveHere reject, and the server is
      not spawned again); the app server, and one still starting, is stopped and waited for. What
      it ran is over afterwards, so busy() and owned() are empty. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const run of this.threads.values()) this.stopPoll(run);
    await this.server.stop();
    for (const run of this.threads.values()) {
      this.settleOpen(run);
      run.rpc = null;
      run.turnId = null;
      if (run.state.turn !== 'idle') this.apply(run, { op: 'meta', patch: { turn: 'idle' } });
    }
    this.loaded.clear();
    this.released.clear();
  }

  private refuseIfStopping(): void {
    if (this.stopping) throw new Error(QUITTING);
  }

  // ── Server, models, history ─────────────────────────────────────────────────────────────

  private async ensure(): Promise<RpcClient> {
    this.refuseIfStopping();
    let rpc: RpcClient;
    try {
      rpc = await this.server.client();
    } catch (err) {
      if (err instanceof CodexMissingError) this.missing = true;
      if (err instanceof CodexStartError) this.setNotStarted(true);
      throw err;
    }
    this.missing = false;
    this.setNotStarted(false);
    return rpc;
  }

  private async loadModels(rpc: RpcClient): Promise<ModelOption[]> {
    const cached = this.models.get(rpc);
    if (cached) return cached;
    const out: ModelOption[] = [];
    let cursor: string | null = null;
    do {
      const page: ModelListResponse = await rpc.request<ModelListResponse>('model/list', cursor ? { cursor } : {});
      for (const m of page.data) {
        if (m.hidden) continue;
        out.push({
          id: m.id, label: m.displayName || m.id, isDefault: m.isDefault,
          efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort ?? null,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.models.set(rpc, out);
    return out;
  }

  /** The thread's model when the server offers it; otherwise the default (a model named only in
      config.toml can be one the server rejects). */
  private pickModel(model: string | null, models: ModelOption[]): string | null {
    if (model !== null && models.some((m) => m.id === model)) return model;
    return models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? model;
  }

  private setNotStarted(value: boolean): void {
    if (this.notStarted === value) return;
    this.notStarted = value;
    this.refreshBanners();
  }

  private setNoAnswer(value: boolean): void {
    if (this.noAnswer === value) return;
    this.noAnswer = value;
    this.refreshBanners();
  }

  private refreshBanners(): void {
    for (const run of this.threads.values()) {
      const banner = this.banner;
      if (run.state.banner !== banner) this.apply(run, { op: 'meta', patch: { banner } });
    }
  }

  private track(thread: Thread, rpc: RpcClient | null, s: { owner: Owner; cwd: string; models: ModelOption[]; model: string | null; mode: ModeId }): ThreadRun {
    const run: ThreadRun = {
      project: this.agent?.projectFor?.(thread.id), id: thread.id, emit: null, rpc: null, turnId: null, lastTurnId: null, pending: new Map(),
      older: [], cursor: null, more: rpc !== null, reads: 'turns', lastUpdatedAt: null, lastStatus: null,
      modeChanged: false, modePicked: false, modelChosen: false, poll: null, seen: new Map(),
      state: {
        sessionId: thread.id, provider: 'codex', owner: s.owner, title: thread.name || thread.preview || '', cwd: s.cwd,
        items: [], hasOlder: false, turn: 'idle', model: s.model, models: s.models, mode: s.mode, modes: MODES,
        banner: this.banner,
      },
    };
    this.threads.set(run.id, run);
    if (rpc) this.claim(run, rpc);
    return run;
  }

  /** The thread is now loaded on this server process. */
  private claim(run: ThreadRun, rpc: RpcClient): void {
    run.rpc = rpc;
    this.loaded.add(run.id);
    this.released.delete(run.id);
    void this.refreshLoaded(rpc);
  }

  /** Loads a thread here before writing to it: the first message after opening (a chat opens
      read-only), or after a restart. Another process holding it makes the chat elsewhere. */
  private async attach(run: ThreadRun, rpc: RpcClient): Promise<boolean> {
    if (run.rpc === rpc && !rpc.closed) return true;
    const models = await this.loadModels(rpc);
    let resumed: ThreadResumeResponse;
    try {
      resumed = await rpc.request<ThreadResumeResponse>('thread/resume', { threadId: run.id, excludeTurns: true, ...codexAgentOptions(this.agent, run.state.cwd, false, run.project) });
    } catch (err) {
      if (!isWriterError(err)) throw err;
      this.apply(run, { op: 'meta', patch: { owner: 'elsewhere', turn: 'idle', banner: this.banner } });
      if (run.emit) this.startPoll(run, rpc);
      return false;
    }
    this.stopPoll(run);
    this.claim(run, rpc);
    // The thread's own model and sandbox, unless the owner picked others here.
    const patch: Partial<ChatState> = {
      owner: 'here', banner: this.banner, models,
      model: run.modelChosen ? run.state.model : this.pickModel(resumed.model, models),
    };
    if (!run.modeChanged && resumed?.sandbox) patch.mode = modeOf(resumed.sandbox);
    this.apply(run, { op: 'meta', patch });
    return true;
  }

  /** Undoes claim() for a thread resumed here but not kept. */
  private unclaim(run: ThreadRun, rpc: RpcClient): void {
    run.rpc = null;
    this.released.add(run.id);
    if (!rpc.closed) void rpc.request('thread/unsubscribe', { threadId: run.id }).then(() => this.refreshLoaded(rpc), () => {});
  }

  /** Lets go of an idle thread so another app can write it. The server keeps it loaded, and the
      writer lock held, until it unloads it (live: about 60 s later, announced by thread/closed,
      which refreshes owned()); the protocol has no way to unload it sooner. */
  private release(run: ThreadRun): void {
    this.threads.delete(run.id);
    const rpc = run.rpc;
    run.rpc = null;
    this.released.add(run.id);
    if (rpc && !rpc.closed) {
      void rpc.request('thread/unsubscribe', { threadId: run.id }).then(() => this.refreshLoaded(rpc), () => {});
    }
  }

  private forget(run: ThreadRun): void {
    this.stopPoll(run);
    this.threads.delete(run.id);
  }

  private async refreshLoaded(rpc: RpcClient): Promise<void> {
    try {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: ThreadLoadedListResponse = await rpc.request<ThreadLoadedListResponse>('thread/loaded/list', cursor ? { cursor } : {});
        ids.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      if (!rpc.closed) {
        this.loaded = new Set(ids);
        for (const id of this.released) if (!this.loaded.has(id)) this.released.delete(id);
      }
    } catch {
      // The cache stays as it was; the next claim or release refreshes it.
    }
  }

  /** Reads older turns (newest first) until at least `want` items wait in `older`; returns the
      newest turn's status when this was the first page. */
  private async readTurns(run: ThreadRun, rpc: RpcClient, want: number): Promise<Turn['status'] | null> {
    let newest: Turn['status'] | null = null;
    while (run.more && run.older.length < want) {
      const first = run.cursor === null;
      const page = await rpc.request<ThreadTurnsListResponse>('thread/turns/list', {
        threadId: run.id, limit: TURNS_PER_REQUEST, sortDirection: 'desc', itemsView: 'full', ...(run.cursor ? { cursor: run.cursor } : {}),
      });
      if (first) newest = page.data[0]?.status ?? null;
      run.older = [...this.remember(run, [...page.data].reverse()), ...run.older];
      run.cursor = page.nextCursor;
      run.more = page.nextCursor !== null;
    }
    return newest;
  }

  /** Moves the newest page out of `older`, with its local images inlined (and only its own). */
  private async takePage(run: ThreadRun): Promise<ChatItem[]> {
    const page = run.older.slice(-PAGE);
    run.older = run.older.slice(0, run.older.length - page.length);
    return inlineImages(page);
  }

  /** The Codex browser stores its latest tab screenshot independently of the transcript. */
  private async syncBrowserCapture(run: ThreadRun, rpc: RpcClient): Promise<void> {
    if (this.withoutAttachments.has(rpc)) return;
    let cursor: string | null = null;
    const request = (run.captureRequest ?? 0) + 1;
    run.captureRequest = request;
    let latest: { id: string; src: string; at: number } | null = null;
    try {
      do {
        const page: ThreadAttachmentListResponse = await rpc.request('thread/attachment/list', { threadId: run.id, cursor, limit: 50 });
        for (const a of page.data) {
          const p = a.payload;
          if (a.attachmentType !== 'browser_preview' || !p || typeof p !== 'object' || Array.isArray(p)) continue;
          if (typeof p.screenshotUrl !== 'string' || !/^(data:image\/(?:jpeg|png|webp);base64,|https:\/\/)/i.test(p.screenshotUrl)) continue;
          if (!latest || latest.at <= a.createdAt) latest = { id: a.id, src: p.screenshotUrl, at: a.createdAt };
        }
        cursor = page.nextCursor;
      } while (cursor);
    } catch (err) {
      if (err instanceof RpcError && err.code === -32601) this.withoutAttachments.add(rpc);
      return;
    }
    if (this.threads.get(run.id) !== run || run.captureRequest !== request) return;
    const before = run.state.browserCapture;
    if (before?.id === latest?.id && before?.src === latest?.src) return;
    this.apply(run, { op: 'meta', patch: { browserCapture: latest ? { id: latest.id, src: latest.src } : null } });
  }

  /** History items, remembering each raw item so a read-only chat can spot changes later. */
  private remember(run: ThreadRun, turns: Turn[]): ChatItem[] {
    const items = codexItems(turns);
    // A chat not held here may be followed later (it can turn up elsewhere while it is open).
    if (run.state.owner !== 'here') for (const item of items) run.seen.set(item.id, JSON.stringify(item));
    return items;
  }

  /** A thread opened without taking it: metadata first (an elsewhere poll's baseline), then a
      bounded page of turns. Only if the server will not list turns of a thread it does not hold,
      the whole thread once. Followed (re-read every pollMs) only while another process writes it.
      Neither thread/read nor thread/turns/list carries its sandbox or approval policy, so the
      mode shows Auto, and that shown mode is binding: the first turn sends its preset, and the
      lazy resume does not replace it with the thread's own sandbox. */
  private async openReadOnly(sessionId: string, rpc: RpcClient, models: ModelOption[], owner: 'elsewhere' | 'nobody'): Promise<ThreadRun> {
    const { thread } = await rpc.request<ThreadReadResponse>('thread/read', { threadId: sessionId, includeTurns: false });
    const run = this.track(thread, null, { owner, cwd: thread.cwd, models, model: this.pickModel(thread.model, models), mode: 'auto' });
    // Auto stands in until the resume says the thread's own sandbox, which then shows and runs
    // (Full access stays Full access). A pick, or main's restore of a saved one, binds instead.
    run.lastUpdatedAt = thread.updatedAt;
    run.lastStatus = thread.status.type;
    run.more = true;
    let newest: Turn['status'] | null;
    try {
      newest = await this.readTurns(run, rpc, PAGE);
    } catch {
      const whole = await rpc.request<ThreadReadResponse>('thread/read', { threadId: sessionId, includeTurns: true });
      run.reads = 'whole';
      run.more = false;
      run.cursor = null;
      run.older = this.remember(run, whole.thread.turns);
      newest = whole.thread.turns.at(-1)?.status ?? null;
    }
    run.state = { ...run.state, turn: newest === 'inProgress' ? 'running' : 'idle' };
    await this.syncBrowserCapture(run, rpc);
    if (owner === 'elsewhere') this.startPoll(run, rpc);
    return run;
  }

  /** A chat another process writes is re-read every pollMs while it is open here. */
  private startPoll(run: ThreadRun, rpc: RpcClient): void {
    if (run.poll) return;
    let busy = false;
    run.poll = setInterval(() => {
      if (busy || rpc.closed) return;
      busy = true;
      void this.reread(run, rpc).finally(() => {
        busy = false;
      });
    }, this.pollMs);
    run.poll.unref?.();
  }

  private stopPoll(run: ThreadRun): void {
    if (run.poll) clearInterval(run.poll);
    run.poll = null;
  }

  /** The poll: a cheap metadata read; the newest turns are re-read only when the thread changed. */
  private async reread(run: ThreadRun, rpc: RpcClient): Promise<void> {
    let turns: Turn[];
    try {
      const { thread } = await rpc.request<ThreadReadResponse>('thread/read', { threadId: run.id, includeTurns: false });
      const recent = this.now() / 1000 - thread.updatedAt <= RECENT_WRITE_S;
      const changed = thread.updatedAt !== run.lastUpdatedAt || thread.status.type !== run.lastStatus;
      run.lastUpdatedAt = thread.updatedAt;
      run.lastStatus = thread.status.type;
      if (!changed && !recent && run.state.turn !== 'running') return;
      turns = run.reads === 'turns'
        ? [...(await rpc.request<ThreadTurnsListResponse>('thread/turns/list', {
          threadId: run.id, limit: RECENT_TURNS, sortDirection: 'desc', itemsView: 'full',
        })).data].reverse()
        : (await rpc.request<ThreadReadResponse>('thread/read', { threadId: run.id, includeTurns: true })).thread.turns;
    } catch {
      return; // try again next time
    }
    if (!run.poll || run.state.owner !== 'elsewhere') return;
    const hidden = new Set(run.older.map((i) => i.id));
    const changed = codexItems(turns).filter((item) => {
      const json = JSON.stringify(item);
      if (hidden.has(item.id) || run.seen.get(item.id) === json) return false;
      run.seen.set(item.id, json);
      return true;
    });
    await this.syncBrowserCapture(run, rpc);
    if (!run.poll || run.state.owner !== 'elsewhere') return;
    for (const item of await inlineImages(changed)) this.apply(run, { op: 'upsert', item });
    const turn = turns.at(-1)?.status === 'inProgress' ? 'running' : 'idle';
    if (turn !== run.state.turn) this.apply(run, { op: 'meta', patch: { turn } });
  }

  // ── Notifications and server requests ───────────────────────────────────────────────────

  private enqueue(task: () => void | Promise<void>): void {
    // A handler failing on one odd message must not stop the ones after it.
    this.queue = this.queue.then(task).catch(() => {});
  }

  private setup(rpc: RpcClient): void {
    // A wedged server: the request fails with "Codex didn't answer" and the cards say so until
    // it answers again.
    rpc.onHealth((answering) => { if (!rpc.closed) this.setNoAnswer(!answering); });
    rpc.onClose(() => this.setNoAnswer(false));
    rpc.onNotification('*', (params, method) => this.enqueue(() => this.onNotification(rpc, method, params)));
    rpc.onRequest('item/tool/call', async (params: DynamicToolCallParams, id) => {
      const run = this.threads.get(params.threadId);
      if (!this.agent || run?.rpc !== rpc || (!run.project && run.state.cwd !== this.agent.cwd)) {
        throw new RpcError(-32601, 'Canvas tools are available only in the canvas agent');
      }
      const result = await callCanvasTool(this.agent.api, params, run.state.mode === 'full-access' ? null : (title, detail) =>
        this.confirmAgentTool(rpc, id, params.threadId, params.callId, title, detail), run.project?.tools);
      return { success: !result.isError, contentItems: [{ type: 'inputText', text: result.text }] };
    });
    // The canvas agent has no MCP server that asks the owner through Codex: decline any that does.
    rpc.onRequest('mcpServer/elicitation/request', async () => ({ action: 'decline', content: null, _meta: null }));
    rpc.onRequest('item/commandExecution/requestApproval', (params: CommandApproval, id) => this.waitForOwner(rpc, id, params.threadId, 'approval', (run, itemId) => {
      const decisions = decisionsFor(params);
      const title = params.kind === 'writeStdin' ? 'Send input to the running command?'
        : params.networkApprovalContext ? 'Allow network access?' : 'Allow this command?';
      const detail = [unwrapShell(params.command ?? ''), params.reason ?? ''].filter((s) => s !== '').join('\n\n');
      this.apply(run, { op: 'upsert', item: {
        kind: 'approval', id: itemId, at: params.startedAtMs || this.now(), toolItemId: params.itemId, title, detail,
        alwaysLabel: decisions.alwaysLabel, status: 'pending',
      } });
      this.patch(run, params.itemId, { status: 'waiting' }, 'running');
      return { kind: 'approval', toolItemId: params.itemId, decisions };
    }));
    rpc.onRequest('item/fileChange/requestApproval', (params: FileChangeRequestApprovalParams, id) => this.waitForOwner(rpc, id, params.threadId, 'approval', (run, itemId) => {
      const tool = run.state.items.find((i) => i.id === params.itemId);
      const detail = [tool?.kind === 'tool' ? tool.target : '', params.reason ?? '', params.grantRoot ? `Write access to ${params.grantRoot}` : '']
        .filter((s) => s !== '').join('\n\n');
      this.apply(run, { op: 'upsert', item: {
        kind: 'approval', id: itemId, at: params.startedAtMs || this.now(), toolItemId: params.itemId, title: 'Allow these edits?', detail,
        alwaysLabel: 'this session', status: 'pending',
      } });
      this.patch(run, params.itemId, { status: 'waiting' }, 'running');
      return { kind: 'approval', toolItemId: params.itemId, decisions: { always: 'acceptForSession', deny: 'decline', alwaysLabel: 'this session' } };
    }));
    rpc.onRequest('item/tool/requestUserInput', (params: ToolRequestUserInputParams, id) => this.waitForOwner(rpc, id, params.threadId, 'question', (run, itemId) => {
      const questions: Question[] = params.questions.map((q) => ({
        id: q.id, header: q.header, text: q.question, options: q.options ?? [], multiSelect: false, allowOther: q.isOther,
        ...(q.isSecret ? { isSecret: true } : {}),
      }));
      this.apply(run, { op: 'upsert', item: { kind: 'question', id: itemId, at: this.now(), questions, status: 'pending', answers: null } });
      return { kind: 'question', toolItemId: null, decisions: null };
    }));
    rpc.onRequest('*', (params: { threadId?: unknown }, _id, method) => {
      const run = typeof params?.threadId === 'string' ? this.threads.get(params.threadId) : undefined;
      if (run) this.enqueue(() => this.notice(run, 'warn', `Codex asked for something Agent canvas cannot answer yet (${method}); it was declined.`));
      throw new RpcError(-32601, `Agent canvas does not handle ${method}`);
    });
  }

  private async confirmAgentTool(rpc: RpcClient, id: number | string, threadId: string, toolItemId: string | null, title: string, detail: string): Promise<boolean> {
    const answer = await this.waitForOwner(rpc, id, threadId, 'approval', (run, itemId) => {
      this.apply(run, { op: 'upsert', item: {
        kind: 'approval', id: itemId, at: this.now(), toolItemId, title, detail, alwaysLabel: null, status: 'pending',
      } });
      return { kind: 'approval', toolItemId, cancelOnExpiry: true, decisions: { always: null, deny: 'decline', alwaysLabel: null } };
    });
    return (answer as { decision: string }).decision === 'accept';
  }

  /** Registers a server request in arrival order and replies when the owner answers. A request
      that expires (turn over, server gone) is never answered. */
  private waitForOwner(
    rpc: RpcClient, rpcId: number | string, threadId: string, prefix: Pending['kind'],
    show: (run: ThreadRun, itemId: string) => Omit<Pending, 'rpc' | 'rpcId' | 'reply'>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.enqueue(() => {
        const run = this.threads.get(threadId);
        if (!run || run.rpc !== rpc) {
          reject(new RpcError(-32600, 'Agent canvas has no open chat for this thread'));
          return;
        }
        const itemId = `${prefix}-${++this.seq}`;
        run.pending.set(itemId, { ...show(run, itemId), rpc, rpcId, reply: resolve });
      });
    });
  }

  private async onNotification(rpc: RpcClient, method: string, params: any): Promise<void> {
    const run = typeof params?.threadId === 'string' ? this.threads.get(params.threadId) : undefined;
    if (method === 'thread/closed' || method === 'thread/started') void this.refreshLoaded(rpc);
    if (method === 'account/updated') this.usageAllowedAt = null;
    if (method === 'account/updated' || method === 'account/rateLimits/updated') { this.onAccountChanged?.(); return; }
    if (run && method === 'thread/attachment/updated' && params.attachmentType === 'browser_preview') {
      await this.syncBrowserCapture(run, rpc);
      return;
    }
    if (!run || run.rpc !== rpc) return;
    switch (method) {
      case 'turn/plan/updated': {
        const { plan, turnId } = params as TurnPlanUpdatedNotification;
        if (turnId === run.turnId) this.apply(run, { op: 'meta', patch: { plan } });
        return;
      }
      case 'turn/started':
        run.turnId = (params.turn as Turn).id;
        this.apply(run, { op: 'meta', patch: { turn: 'running', plan: [] } });
        return;
      case 'turn/completed':
        this.turnEnded(run, params.turn as Turn);
        return;
      case 'thread/name/updated':
        if (typeof params.threadName === 'string') this.apply(run, { op: 'meta', patch: { title: params.threadName } });
        return;
      case 'thread/closed':
        if (run.state.turn === 'running' && !this.stopping && !(run.turnId !== null && run.turnId === run.manualStopId)) {
          this.interrupted(run, { kind: 'killed', reason: 'Codex closed the thread mid-turn', at: this.now(), resetsAt: null });
        }
        run.rpc = null;
        this.loaded.delete(run.id);
        this.apply(run, { op: 'meta', patch: { owner: 'nobody', turn: 'idle' } });
        return;
      case 'error':
        // A final error also ends the turn as failed; that notice is the one shown.
        if (params.willRetry) this.notice(run, 'warn', `${errorText(params.error as TurnError)} (retrying)`);
        return;
      case 'serverRequest/resolved':
        for (const [itemId, p] of run.pending) if (p.rpc === rpc && p.rpcId === params.requestId) this.expire(run, itemId, p);
        return;
    }
    await this.applyItemUpdates(run, itemUpdates(method, params, (id) => run.state.items.find((i) => i.id === id), this.now()));
  }

  private async applyItemUpdates(run: ThreadRun, updates: ChatUpdate[]): Promise<void> {
    for (const u of updates) {
      if (u.op === 'upsert' && u.item.kind === 'user') for (const item of await inlineImages([u.item])) this.apply(run, { op: 'upsert', item });
      else this.apply(run, u);
    }
  }

  private turnEnded(run: ThreadRun, turn: Turn): void {
    run.lastTurnId = turn.id;
    if (run.turnId === turn.id || run.turnId === null) run.turnId = null;
    for (const [itemId, p] of run.pending) this.expire(run, itemId, p);
    const manual = run.manualStopId === turn.id;
    delete run.manualStopId;
    if (turn.status === 'failed') {
      this.notice(run, 'error', errorText(turn.error));
      if (!manual) this.interrupted(run, codexFailure(turn.error, this.now()));
    }
    if (turn.status === 'interrupted') {
      // Interrupted without a Stop here: Codex (or another program) cut it off.
      this.notice(run, manual ? 'info' : 'error', manual ? 'Stopped' : 'Interrupted before it finished');
      if (!manual && !this.stopping) this.interrupted(run, { kind: 'killed', reason: 'Codex interrupted the turn before it finished', at: this.now(), resetsAt: null });
    }
    this.apply(run, { op: 'meta', patch: { turn: 'idle' } });
    if (!run.emit && run.pending.size === 0) this.release(run);
  }

  /** Review Focus 4: the process died. Open chats it ran say so, nothing waits on it any more,
      and the next message starts a new one. */
  private serverExited(rpc: RpcClient, reason: Error): void {
    this.loaded.clear();
    this.released.clear();
    for (const run of this.threads.values()) {
      if (run.rpc !== rpc) continue;
      const wasBusy = run.turnId !== null || run.pending.size > 0;
      this.settleOpen(run);
      run.rpc = null;
      run.turnId = null;
      if (wasBusy) this.notice(run, 'error', `Codex stopped unexpectedly (${reason.message}). Your next message starts it again.`);
      if (wasBusy && !this.stopping) this.interrupted(run, { kind: 'error', reason: `Codex stopped unexpectedly (${reason.message})`, at: this.now(), resetsAt: null });
      this.apply(run, { op: 'meta', patch: { turn: 'idle', owner: 'nobody', banner: this.banner } });
      if (!run.emit) this.threads.delete(run.id); // nobody is looking; the next open reads it afresh
    }
  }

  // ── State helpers ───────────────────────────────────────────────────────────────────────

  private run(sessionId: string): ThreadRun {
    const run = this.threads.get(sessionId);
    if (!run) throw new Error('This Codex chat is not open');
    return run;
  }

  /** A turn cut off by something other than the owner: the card says so until a new turn starts. */
  private interrupted(run: ThreadRun, i: SessionInterruption): void {
    this.interruptions.set(run.id, i);
  }

  private apply(run: ThreadRun, u: ChatUpdate): void {
    if (u.op === 'meta' && u.patch.turn === 'running') this.interruptions.delete(run.id);
    run.state = applyUpdate(run.state, u);
    run.emit?.(u);
  }

  /** Changes fields of one item (optionally only while its status is `onlyFrom`). */
  private patch(run: ThreadRun, id: string, fields: Record<string, unknown>, onlyFrom?: string): void {
    const item = run.state.items.find((i) => i.id === id);
    if (!item || (onlyFrom !== undefined && (item as { status?: string }).status !== onlyFrom)) return;
    this.apply(run, { op: 'upsert', item: { ...item, ...fields } as ChatItem });
  }

  /** The process running this thread's turn is gone: nothing waits any more, and what ran or
      streamed has stopped. */
  private settleOpen(run: ThreadRun): void {
    for (const [itemId, p] of run.pending) this.expire(run, itemId, p);
    for (const item of run.state.items) {
      if (item.kind === 'tool' && (item.status === 'running' || item.status === 'waiting')) this.apply(run, { op: 'upsert', item: { ...item, status: 'failed' } });
      if ((item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming) this.apply(run, { op: 'upsert', item: { ...item, streaming: false } });
    }
  }

  private expire(run: ThreadRun, itemId: string, p: Pending): void {
    if (p.cancelOnExpiry) p.reply({ decision: 'decline' });
    run.pending.delete(itemId);
    this.patch(run, itemId, { status: 'expired' }, 'pending');
  }

  private notice(run: ThreadRun, level: 'info' | 'warn' | 'error', text: string): void {
    this.apply(run, { op: 'upsert', item: { kind: 'notice', id: `notice-${++this.seq}`, at: this.now(), level, text } });
  }
}
