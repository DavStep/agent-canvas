// AcpEngine: sessions with any ACP agent the owner configured (docs/acp.md). One process per
// agent serves all of its sessions. A session's chat lives here (ChatState, changed only through
// applyUpdate), with its permission requests, its queued messages, and the folder its fs and
// terminal requests are confined to. Cards come from views(), over the sessions' records.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { acpCardId, showsInNewSession, type AcpAgentConfig, type AcpBadge } from '../../../shared/acp.ts';
import { promptLine } from '../../../shared/attachments.ts';
import type { NewSessionRequest, ProviderOptions } from '../../../shared/bridge.ts';
import type { ApprovalAnswer, ChatItem, ChatState, ChatUpdate, ImageRef, ModelOption, ModeOption } from '../../../shared/chat.ts';
import type { SessionInterruption, SessionView } from '../../../shared/types.ts';
import { folderOf } from '../../activity.ts';
import { applyUpdate } from '../chatLog.ts';
import type { BusySession, ChatEngine, StartOptions } from '../engine.ts';
import { AcpConnection, type ClientHandlers, type SpawnLike } from './connection.ts';
import { approvalItem, modelsOf, modesOf, recentSteps, stopNotice, UpdateMapper, type Choices } from './map.ts';
import type { AcpRecord, AcpRecords } from './records.ts';
import { locate, readText, writeText } from './scope.ts';
import { promptBlocks } from './prompt.ts';
import { Terminals } from './terminals.ts';

/** Images saved for an agent that takes none, when main gives no attachments folder. */
async function keepInTemp(images: ImageRef[]): Promise<{ name: string; path: string }[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-canvas-acp-'));
  const out: { name: string; path: string }[] = [];
  for (const [i, img] of images.entries()) {
    const data = /^data:[^;,]+;base64,(.*)$/s.exec(img.dataUrl)?.[1];
    if (data === undefined) continue;
    const name = `image-${i + 1}.${img.mime.split('/')[1] ?? 'png'}`;
    await fs.writeFile(path.join(dir, name), Buffer.from(data, 'base64'), { mode: 0o600 });
    out.push({ name, path: path.join(dir, name) });
  }
  return out;
}

export const QUITTING = 'Agent canvas is quitting';
/** An agent process with nothing running and no chat open is stopped after this long. */
const IDLE_MS = 10 * 60_000;
const TEXT_MAX = 2000;

/** Per-turn token use, when the agent reports it (usage_update): for usage analytics. */
/** One turn's tokens, from the prompt response's `usage` (an agent that reports it), for usage
    analytics: `turn` is the user message's item id. */
export interface AcpTurnUsage {
  sessionId: string; agent: string; cwd: string; model: string; turn: string; at: number;
  input: number; output: number; cacheRead: number; cacheWrite: number;
}

export interface AcpUsage { sessionId: string; agent: string; used: number; size: number; cost: { amount: number; currency: string } | null; at: number }

export interface AcpEngineOptions {
  /** The agents in Settings now. */
  agents(): AcpAgentConfig[];
  /** The program an agent's command runs, or null when it is not installed. */
  resolve(agent: AcpAgentConfig): Promise<string | null>;
  /** The environment agent processes and terminals start from (childEnv). */
  env: Record<string, string>;
  records: AcpRecords;
  /** The cards changed (a turn began or ended, a permission waits): the source republishes. */
  onChange?(): void;
  onUsage?(u: AcpUsage): void;
  /** A turn ended and the agent said how many tokens it took. */
  onTurnUsage?(u: AcpTurnUsage): void;
  /** Saves images as files for an agent that takes none (AttachmentStore.keepImages). */
  keepImages?(images: ImageRef[]): Promise<{ name: string; path: string }[]>;
  spawn?: SpawnLike;
  now?: () => number;
  idleMs?: number;
  handshakeMs?: number;
  shell?: string;
  version?: string;
}

type PendingKind = 'permission' | 'scope';
interface Pending {
  kind: PendingKind;
  toolItemId: string | null;
  choices: Choices | null;
  /** A permission: the agent's answer. A scope ask: true to allow. */
  resolve(answer: acp.RequestPermissionResponse | boolean): void;
}

interface Queued { itemId: string; text: string; images: ImageRef[] }

interface Run {
  record: AcpRecord;
  conn: AcpConnection | null;
  state: ChatState;
  emit: ((u: ChatUpdate) => void) | null;
  mapper: UpdateMapper;
  /** The real path of the session's folder: what fs and terminal requests may touch freely. */
  root: string | null;
  turn: boolean;
  queue: Queued[];
  pending: Map<string, Pending>;
  /** Paths outside the folder the owner allowed for this session ("Always allow"). */
  allowedOutside: Set<string>;
  modelConfigId: string | null;
  /** Terminal ids embedded in tool rows: terminal → tool item. */
  terminalRows: Map<string, string>;
  stateSince: number;
  /** Set while it attaches (load/resume), so two callers share one attach. */
  attaching: Promise<void> | null;
}

const badgeOf = (r: AcpRecord, agent: AcpAgentConfig | undefined): AcpBadge =>
  ({ id: r.agent, name: agent?.name ?? r.agentName, icon: agent?.icon ?? r.icon });

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A cut-off turn as the card's "interrupted": a usage or rate limit the agent named, a turn
    limit, else an error. */
export function interruptionKind(reason: acp.StopReason | null, error?: string): 'limit' | 'error' {
  if (reason === 'max_tokens' || reason === 'max_turn_requests') return 'limit';
  if (reason === null && error !== undefined && /\b(usage|rate)[ -]limit|quota|too many requests|\b429\b/i.test(error)) return 'limit';
  return 'error';
}

export class AcpEngine implements ChatEngine {
  readonly provider = 'acp' as const;
  readonly banner = null;
  /** Turns cut off by the agent's process ending, by session id (the store's "interrupted"). */
  readonly interruptions = new Map<string, SessionInterruption>();
  private readonly runs = new Map<string, Run>();
  /** Agent session id → local id, for routing what an agent sends. */
  private readonly bySession = new Map<string, string>();
  private readonly conns = new Map<string, Promise<AcpConnection>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  /** The modes and models each agent offered last, for New session's pickers. */
  private readonly offered = new Map<string, { modes: ModeOption[]; mode: string; models: ModelOption[]; model: string | null }>();
  /** Updates for a session not registered yet (sent before session/new answered). */
  private readonly early = new Map<string, acp.SessionUpdate[]>();
  private readonly terminals: Terminals;
  private readonly now: () => number;
  private seq = 0;
  private stopping = false;

  constructor(private readonly opts: AcpEngineOptions) {
    this.now = opts.now ?? Date.now;
    this.terminals = new Terminals({ env: () => opts.env, shell: opts.shell ?? (process.env.SHELL || '/bin/zsh') });
  }

  // ── Cards ─────────────────────────────────────────────────────────────────────────────

  views(): SessionView[] {
    const agents = new Map(this.opts.agents().map((a) => [a.id, a]));
    return this.opts.records.all().map((r): SessionView => {
      const run = this.runs.get(r.id);
      const waiting = run ? [...run.pending.values()].length > 0 : false;
      const working = run?.turn === true;
      const items = run?.state.items ?? [];
      const lastTool = [...items].reverse().find((i) => i.kind === 'tool');
      const modelLabel = run?.state.models.find((m) => m.id === run.state.model)?.label ?? run?.state.model ?? r.model;
      return {
        id: acpCardId(r.id), provider: 'acp', acp: badgeOf(r, agents.get(r.agent)), hostId: null,
        name: run?.state.title || r.title, cwd: r.cwd, folder: folderOf(r.cwd),
        state: waiting ? 'needs_you' : working ? 'working' : 'idle', need: waiting ? 'permission' : null,
        activity: waiting ? 'Wants permission' : working ? (lastTool?.kind === 'tool' && lastTool.status === 'running' ? lastTool.action?.target || lastTool.target : 'Thinking') : null,
        ...(working && run ? { recentSteps: recentSteps(run.state.items) } : {}),
        rawStatus: waiting ? 'waiting' : working ? 'busy' : 'idle',
        stateSince: run?.stateSince ?? r.updatedAt, startedAt: r.startedAt, branch: null, model: modelLabel ?? null,
        lastPrompt: r.lastPrompt, lastAnswer: r.lastAnswer, subagents: [],
        owner: run?.conn && !run.conn.closed ? 'here' : 'nobody', ownerNote: null, host: null,
      };
    });
  }

  private changed(run?: Run): void {
    if (run) run.stateSince = this.now();
    this.opts.onChange?.();
  }

  // ── ChatEngine ────────────────────────────────────────────────────────────────────────

  async open(id: string, emit: (u: ChatUpdate) => void): Promise<ChatState> {
    const run = this.runFor(id);
    run.emit = emit;
    this.cancelIdle(run.record.agent);
    if (!run.conn || run.conn.closed) await this.attach(run).catch(() => {});
    return run.state;
  }

  close(id: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.emit = null;
    this.scheduleIdle(run.record.agent);
  }

  async loadOlder(): Promise<void> { /* a session's whole history arrives at once */ }

  async send(id: string, text: string, images: ImageRef[]): Promise<void> {
    this.refuseIfStopping();
    const run = this.runFor(id);
    if (!run.conn || run.conn.closed) {
      await this.attach(run);
      if (!run.conn || run.conn.closed) throw new Error(run.state.banner ?? `${this.nameOf(run)} is not running`);
    }
    if (run.state.owner !== 'here') throw new Error(run.state.banner ?? `${this.nameOf(run)} cannot continue this conversation`);
    const itemId = `user-${++this.seq}`;
    if (run.turn) {
      run.queue.push({ itemId, text, images });
      this.apply(run, { op: 'upsert', item: { kind: 'user', id: itemId, at: this.now(), text, images, queued: true } });
      return;
    }
    await this.startTurn(run, { itemId, text, images });
  }

  async interrupt(id: string): Promise<void> {
    const run = this.runFor(id);
    if (!run.turn || !run.conn) return;
    // The spec: every permission still waiting is answered `cancelled`; the turn then ends with
    // stop reason `cancelled`.
    for (const [itemId, p] of run.pending) this.expire(run, itemId, p);
    run.conn.cancel(run.record.sessionId);
  }

  async answerApproval(id: string, approvalId: string, answer: ApprovalAnswer): Promise<void> {
    const run = this.runFor(id);
    const p = run.pending.get(approvalId);
    if (!p) throw new Error('This approval is no longer waiting');
    if (p.kind === 'scope') {
      run.pending.delete(approvalId);
      p.resolve(answer !== 'deny');
      if (answer === 'allowAlways') {
        const item = run.state.items.find((i) => i.id === approvalId);
        if (item?.kind === 'approval') run.allowedOutside.add(item.detail.split('\n')[0]!);
      }
    } else {
      const option = answer === 'allow' ? p.choices?.allow : answer === 'allowAlways' ? p.choices?.always : p.choices?.deny;
      if (!option) throw new Error(answer === 'allowAlways' ? '"Always allow" is not offered for this request' : 'The agent offered no such choice');
      run.pending.delete(approvalId);
      p.resolve({ outcome: { outcome: 'selected', optionId: option } });
    }
    this.patch(run, approvalId, { status: answer === 'allow' ? 'allowed' : answer === 'allowAlways' ? 'allowedAlways' : 'denied' });
    if (p.toolItemId) this.patch(run, p.toolItemId, { status: answer === 'deny' ? 'denied' : 'running' }, 'waiting');
    this.changed(run);
  }

  async answerQuestion(): Promise<void> {
    throw new Error('ACP agents ask no questions here');
  }

  async setModel(id: string, model: string): Promise<void> {
    const run = this.runFor(id);
    if (!run.conn || run.modelConfigId === null) throw new Error(`${this.nameOf(run)} offers no model choice here`);
    const res = await run.conn.request('session/set_config_option', { sessionId: run.record.sessionId, configId: run.modelConfigId, value: model });
    const m = modelsOf(res.configOptions);
    this.apply(run, { op: 'meta', patch: m ? { models: m.models, model: m.model } : { model } });
    void this.opts.records.patch(run.record.id, { model });
    this.remember(run);
  }

  async setMode(id: string, mode: string): Promise<void> {
    const run = this.runFor(id);
    if (!run.conn || run.state.modes.length === 0) throw new Error(`${this.nameOf(run)} offers no modes here`);
    if (!run.state.modes.some((m) => m.id === mode)) throw new Error(`Unknown mode: ${mode}`);
    await run.conn.request('session/set_mode', { sessionId: run.record.sessionId, modeId: mode });
    this.apply(run, { op: 'meta', patch: { mode } });
    void this.opts.records.patch(run.record.id, { mode });
    this.remember(run);
  }

  async moveHere(): Promise<boolean> { return true; }

  async rename(id: string, title: string): Promise<void> {
    const run = this.runs.get(id);
    if (run) this.apply(run, { op: 'meta', patch: { title } });
    await this.opts.records.patch(id, { title, updatedAt: this.now() });
    this.changed();
  }

  async start(req: NewSessionRequest, options: StartOptions = {}): Promise<string> {
    this.refuseIfStopping();
    const agent = this.opts.agents().find((a) => a.id === req.agent);
    if (!agent) throw new Error(req.agent ? `No ACP agent "${req.agent}" in Settings` : 'Choose an ACP agent');
    // The same rule as every picker: a hidden agent (by default the Claude and Codex adapters)
    // starts nothing new. Its past sessions still open and continue.
    if (!showsInNewSession(agent)) throw new Error(`${agent.name} is hidden from New session. Turn on "Show in New session" for it in Settings › ACP agents.`);
    const conn = await this.connect(agent, req.cwd);
    const res = await conn.request('session/new', { cwd: req.cwd, mcpServers: [] });
    const at = this.now();
    const record: AcpRecord = {
      id: randomUUID(), agent: agent.id, agentName: agent.name, icon: agent.icon, sessionId: res.sessionId, cwd: req.cwd,
      title: options.title ?? promptLine(req.text).trim().split('\n')[0]!.slice(0, 120), startedAt: at, updatedAt: at,
      lastPrompt: null, lastAnswer: null, model: null, mode: null,
    };
    await this.opts.records.put(record);
    const run = this.track(record, conn);
    this.setUp(run, res.modes, res.configOptions);
    if (req.mode && req.mode !== run.state.mode && run.state.modes.some((m) => m.id === req.mode)) await this.setMode(record.id, req.mode).catch(() => {});
    if (req.model && req.model !== run.state.model && run.modelConfigId) await this.setModel(record.id, req.model).catch(() => {});
    this.remember(run);
    await this.startTurn(run, { itemId: `user-${++this.seq}`, text: req.text, images: req.images });
    return record.id;
  }

  async options(agentId?: string): Promise<ProviderOptions> {
    const o = agentId ? this.offered.get(agentId) : undefined;
    return { models: o?.models ?? [], model: o?.model ?? null, effort: null, modes: o?.modes ?? [], mode: o?.mode ?? '' };
  }

  lost(): void { /* ACP sessions are only ever run here */ }

  owned(): Set<string> {
    return new Set([...this.runs.values()].filter((r) => r.conn && !r.conn.closed).map((r) => r.record.id));
  }

  releasing(): Set<string> { return new Set(); }

  busy(): BusySession[] {
    return [...this.runs.values()].flatMap((r): BusySession[] =>
      r.pending.size > 0 ? [{ sessionId: r.record.id, reason: 'approval' }] : r.turn ? [{ sessionId: r.record.id, reason: 'turn' }] : []);
  }

  /** Quit: nothing new starts; every agent process and terminal is stopped. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    this.terminals.releaseAll();
    const conns = await Promise.allSettled([...this.conns.values()]);
    await Promise.allSettled(conns.flatMap((c) => (c.status === 'fulfilled' ? [c.value.stop()] : [])));
    this.conns.clear();
  }

  // ── Sessions ──────────────────────────────────────────────────────────────────────────

  private runFor(id: string): Run {
    const known = this.runs.get(id);
    if (known) return known;
    const record = this.opts.records.get(id);
    if (!record) throw new Error('This ACP session is not known');
    return this.track(record, null);
  }

  private track(record: AcpRecord, conn: AcpConnection | null): Run {
    const agent = this.opts.agents().find((a) => a.id === record.agent);
    const run: Run = {
      record, conn, emit: null, mapper: new UpdateMapper(`acp-${record.id.slice(0, 8)}`, this.now), root: null, turn: false, queue: [],
      pending: new Map(), allowedOutside: new Set(), modelConfigId: null, terminalRows: new Map(), stateSince: record.updatedAt, attaching: null,
      state: {
        sessionId: record.id, provider: 'acp', acp: badgeOf(record, agent), owner: conn ? 'here' : 'nobody', title: record.title, cwd: record.cwd,
        items: [], hasOlder: false, turn: 'idle', plan: [], model: record.model, models: [], mode: record.mode ?? '', modes: [], banner: null,
      },
    };
    this.runs.set(record.id, run);
    if (conn) this.bind(run, conn);
    return run;
  }

  private bind(run: Run, conn: AcpConnection): void {
    run.conn = conn;
    this.bySession.set(run.record.sessionId, run.record.id);
    for (const u of this.early.get(run.record.sessionId) ?? []) this.onUpdate(run, u);
    this.early.delete(run.record.sessionId);
  }

  private setUp(run: Run, modes: acp.SessionModeState | null | undefined, configOptions: acp.SessionConfigOption[] | null | undefined): void {
    const m = modesOf(modes);
    const models = modelsOf(configOptions);
    run.modelConfigId = models?.configId ?? null;
    this.apply(run, { op: 'meta', patch: {
      owner: 'here', banner: null, modes: m.modes, mode: m.mode, models: models?.models ?? [], model: models?.model ?? run.record.model,
    } });
  }

  private remember(run: Run): void {
    this.offered.set(run.record.agent, { modes: run.state.modes, mode: run.state.mode, models: run.state.models, model: run.state.model });
  }

  /** Brings a past session back on a live process: load (its history replayed into the chat),
      else resume (no history), else read-only with a notice. Never throws for a known cause:
      the chat's banner says why. */
  private attach(run: Run): Promise<void> {
    run.attaching ??= this.attachOnce(run).finally(() => { run.attaching = null; });
    return run.attaching;
  }

  private async attachOnce(run: Run): Promise<void> {
    const name = this.nameOf(run);
    const agent = this.opts.agents().find((a) => a.id === run.record.agent);
    const fail = (banner: string) => { this.apply(run, { op: 'meta', patch: { owner: 'nobody', banner, turn: 'idle' } }); };
    if (!agent) return fail(`${name} is no longer in Settings → ACP agents, so this conversation is read-only.`);
    let conn: AcpConnection;
    try {
      conn = await this.connect(agent, run.record.cwd);
    } catch (err) {
      return fail(errText(err));
    }
    if (!conn.canLoad && !conn.canResume) {
      this.bySession.delete(run.record.sessionId);
      fail(`${name} can't reopen past conversations (it offers no session/load), so this one is read-only here. Start a new session to continue.`);
      return;
    }
    run.conn = conn;
    this.bySession.set(run.record.sessionId, run.record.id);
    try {
      if (conn.canLoad) {
        // The history comes again as updates, before load answers: it replaces what was shown.
        run.mapper.reset();
        this.apply(run, { op: 'reset', state: { ...run.state, items: [], plan: [] } });
        const res = await conn.request('session/load', { sessionId: run.record.sessionId, cwd: run.record.cwd, mcpServers: [] });
        for (const u of run.mapper.close(run.state.items)) this.apply(run, u);
        this.setUp(run, res?.modes, res?.configOptions);
      } else {
        const res = await conn.request('session/resume', { sessionId: run.record.sessionId, cwd: run.record.cwd, mcpServers: [] });
        this.setUp(run, res.modes, res.configOptions);
        if (run.state.items.length === 0) this.notice(run, 'info', `${name} continues this conversation, but cannot show its earlier messages.`);
      }
      // A reopened session may come back in the agent's default mode: the one picked for this
      // conversation (kept in its record) is put back, so a resume never drops it.
      const picked = run.record.mode;
      if (picked && picked !== run.state.mode && run.state.modes.some((m) => m.id === picked)) await this.setMode(run.record.id, picked).catch(() => {});
      this.remember(run);
    } catch (err) {
      run.conn = null;
      fail(`${name} could not reopen this conversation: ${errText(err)}`);
    }
    this.changed();
  }

  private async startTurn(run: Run, msg: Queued): Promise<void> {
    const conn = run.conn!;
    const name = this.nameOf(run);
    const { prompt, text } = await this.promptOf(conn, msg.text, msg.images);
    this.interruptions.delete(run.record.id);
    this.apply(run, { op: 'upsert', item: { kind: 'user', id: msg.itemId, at: this.now(), text: msg.text, images: msg.images } });
    this.apply(run, { op: 'meta', patch: { turn: 'running', plan: [] } });
    run.turn = true;
    this.cancelIdle(run.record.agent);
    void this.opts.records.patch(run.record.id, { lastPrompt: promptLine(text).slice(0, TEXT_MAX), updatedAt: this.now() });
    run.record = this.opts.records.get(run.record.id) ?? run.record;
    this.changed(run);
    conn.request('session/prompt', { sessionId: run.record.sessionId, prompt }).then(
      (res) => {
        this.turnUsage(run, msg.itemId, (res as { usage?: unknown }).usage);
        this.turnEnded(run, res.stopReason);
      },
      (err: unknown) => {
        if (conn.ending) return; // the exit handler says so
        this.notice(run, 'error', `${name}: ${errText(err)}`);
        this.turnEnded(run, null, errText(err));
      },
    );
  }

  /** The prompt's content blocks (prompt.ts): files by link, images as images when the agent
      takes them, else saved (keepImages, or a private temp folder) and linked. */
  private async promptOf(conn: AcpConnection, text: string, images: ImageRef[]): Promise<{ prompt: acp.ContentBlock[]; text: string }> {
    const keepImages = this.opts.keepImages ?? keepInTemp;
    return { prompt: await promptBlocks(text, images, { image: conn.canImage, keepImages }), text };
  }

  /** ACP's `usage` on a prompt response (input counts what was not read from cache). */
  private turnUsage(run: Run, turn: string, usage: unknown): void {
    if (!this.opts.onTurnUsage || typeof usage !== 'object' || usage === null) return;
    const u = usage as Record<string, unknown>;
    const n = (k: string): number => (typeof u[k] === 'number' && Number.isFinite(u[k]) && (u[k] as number) >= 0 ? u[k] as number : 0);
    const input = n('inputTokens');
    const output = n('outputTokens') + n('thoughtTokens');
    if (input + output + n('cachedReadTokens') + n('cachedWriteTokens') === 0) return;
    this.opts.onTurnUsage({
      sessionId: run.record.id, agent: run.record.agent, cwd: run.record.cwd, model: run.state.model ?? run.record.agentName, turn, at: this.now(),
      input, output, cacheRead: n('cachedReadTokens'), cacheWrite: n('cachedWriteTokens'),
    });
  }

  /** `error`: the prompt request failed (reason null). Queued messages go out only after a turn
      that ended normally or that the owner stopped; after a limit, a refusal or an error they are
      held (not sent), the chat says so, and the card is marked interrupted. */
  private turnEnded(run: Run, reason: acp.StopReason | null, error?: string): void {
    for (const u of run.mapper.close(run.state.items)) this.apply(run, u);
    for (const [itemId, p] of run.pending) this.expire(run, itemId, p);
    for (const item of run.state.items) {
      if (item.kind === 'tool' && (item.status === 'running' || item.status === 'waiting')) {
        this.apply(run, { op: 'upsert', item: { ...item, status: reason === 'end_turn' ? 'done' : 'failed' } });
      }
    }
    const n = reason ? stopNotice(reason, this.nameOf(run)) : null;
    if (n) this.notice(run, n.level, n.text);
    const cutOff = reason !== 'end_turn' && reason !== 'cancelled';
    if (cutOff) {
      const why = n?.text ?? `${this.nameOf(run)}: ${error ?? 'the turn failed'}`;
      this.interruptions.set(run.record.id, { kind: interruptionKind(reason, error), reason: why, at: this.now(), resetsAt: null });
    }
    run.turn = false;
    this.apply(run, { op: 'meta', patch: { turn: 'idle' } });
    const answer = [...run.state.items].reverse().find((i) => i.kind === 'assistant');
    void this.opts.records.patch(run.record.id, {
      updatedAt: this.now(), title: run.state.title || run.record.title,
      ...(answer?.kind === 'assistant' ? { lastAnswer: answer.text.slice(0, TEXT_MAX) } : {}),
    });
    this.changed(run);
    const next = cutOff ? undefined : run.queue.shift();
    if (next && run.conn && !run.conn.closed) {
      void this.startTurn(run, next).catch((err: unknown) => this.notice(run, 'error', `Not sent: ${errText(err)}`));
    } else {
      this.holdQueue(run);
      this.scheduleIdle(run.record.agent);
    }
  }

  /** The messages still queued are not sent: they stay in the chat as written, and a notice
      says they did not go out. */
  private holdQueue(run: Run): void {
    const held = run.queue.splice(0);
    if (held.length === 0) return;
    for (const q of held) this.patch(run, q.itemId, { queued: false });
    const what = held.length === 1 ? 'Your queued message was' : `Your ${held.length} queued messages were`;
    this.notice(run, 'warn', `${what} not sent. Send again when you are ready.`);
  }

  // ── Agent processes ───────────────────────────────────────────────────────────────────

  private refuseIfStopping(): void {
    if (this.stopping) throw new Error(QUITTING);
  }

  private connect(agent: AcpAgentConfig, cwd: string): Promise<AcpConnection> {
    this.refuseIfStopping();
    const known = this.conns.get(agent.id);
    if (known) {
      return known.then((c) => {
        // A process that died, or an agent whose command changed, is started afresh.
        const same = JSON.stringify([c.agent.command, c.agent.args, c.agent.env]) === JSON.stringify([agent.command, agent.args, agent.env]);
        if (!c.closed && same) return c;
        if (this.conns.get(agent.id) === known) this.conns.delete(agent.id);
        if (!c.closed && !this.agentBusy(agent.id)) void c.stop();
        return this.connect(agent, cwd);
      }, () => {
        if (this.conns.get(agent.id) === known) this.conns.delete(agent.id);
        return this.connect(agent, cwd);
      });
    }
    const opening = (async () => {
      const program = await this.opts.resolve(agent);
      if (program === null) throw new Error(`${agent.name} is not installed: \`${agent.command}\` was not found on this Mac's PATH.`);
      const conn = await AcpConnection.open({
        agent, program, env: this.opts.env, cwd, handlers: this.handlers(), spawn: this.opts.spawn,
        handshakeMs: this.opts.handshakeMs, version: this.opts.version,
      });
      conn.onExit((reason) => this.exited(conn, reason));
      return conn;
    })();
    this.conns.set(agent.id, opening);
    opening.catch(() => { if (this.conns.get(agent.id) === opening) this.conns.delete(agent.id); });
    return opening;
  }

  private agentBusy(agentId: string): boolean {
    return [...this.runs.values()].some((r) => r.record.agent === agentId && (r.turn || r.pending.size > 0));
  }

  private scheduleIdle(agentId: string): void {
    this.cancelIdle(agentId);
    const inUse = [...this.runs.values()].some((r) => r.record.agent === agentId && (r.turn || r.pending.size > 0 || r.emit !== null));
    if (inUse || this.stopping) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(agentId);
      const c = this.conns.get(agentId);
      if (!c || this.agentBusy(agentId)) return;
      this.conns.delete(agentId);
      void c.then((conn) => conn.stop(), () => {});
    }, this.opts.idleMs ?? IDLE_MS);
    timer.unref();
    this.idleTimers.set(agentId, timer);
  }

  private cancelIdle(agentId: string): void {
    const t = this.idleTimers.get(agentId);
    if (t) clearTimeout(t);
    this.idleTimers.delete(agentId);
  }

  /** The process ended: its sessions' chats say so if it was mid-turn, and the next message starts it again. */
  private exited(conn: AcpConnection, reason: string): void {
    for (const run of this.runs.values()) {
      if (run.conn !== conn) continue;
      const busy = run.turn || run.pending.size > 0;
      this.terminals.releaseAll(run.record.sessionId);
      for (const [itemId, p] of run.pending) this.expire(run, itemId, p);
      for (const u of run.mapper.close(run.state.items)) this.apply(run, u);
      for (const item of run.state.items) if (item.kind === 'tool' && (item.status === 'running' || item.status === 'waiting')) this.apply(run, { op: 'upsert', item: { ...item, status: 'failed' } });
      run.conn = null;
      run.turn = false;
      if (busy && !this.stopping) {
        this.notice(run, 'error', `${this.nameOf(run)} stopped unexpectedly (${reason}). Your next message starts it again.`);
        this.interruptions.set(run.record.id, { kind: 'killed', reason: `${this.nameOf(run)} stopped unexpectedly`, at: this.now(), resetsAt: null });
      }
      this.holdQueue(run);
      this.apply(run, { op: 'meta', patch: { turn: 'idle', owner: 'nobody' } });
    }
    this.changed();
  }

  // ── What agents send ──────────────────────────────────────────────────────────────────

  private runOf(sessionId: string): Run {
    const id = this.bySession.get(sessionId);
    const run = id ? this.runs.get(id) : undefined;
    if (!run) throw new Error(`No session ${sessionId} here`);
    return run;
  }

  private handlers(): ClientHandlers {
    return {
      update: (n) => {
        const id = this.bySession.get(n.sessionId);
        const run = id ? this.runs.get(id) : undefined;
        if (run) { this.onUpdate(run, n.update); return; }
        const list = this.early.get(n.sessionId) ?? [];
        if (list.length < 200) list.push(n.update);
        this.early.set(n.sessionId, list);
      },
      permission: (p, signal) => this.onPermission(p, signal),
      readTextFile: async (p) => {
        const run = this.runOf(p.sessionId);
        const real = await this.inScope(run, p.path, 'read');
        return { content: await readText(real, p.line, p.limit) };
      },
      writeTextFile: async (p) => {
        const run = this.runOf(p.sessionId);
        const real = await this.inScope(run, p.path, 'write');
        await writeText(real, p.content);
        return {};
      },
      createTerminal: async (p) => {
        const run = this.runOf(p.sessionId);
        const cwd = await this.inScope(run, p.cwd ?? run.record.cwd, 'run a command in');
        const terminalId = this.terminals.create({ sessionId: p.sessionId, command: p.command, args: p.args, env: p.env, cwd, outputByteLimit: p.outputByteLimit });
        this.followTerminal(run, terminalId);
        return { terminalId };
      },
      terminalOutput: async (p) => this.terminals.output(p.sessionId, p.terminalId),
      waitForTerminalExit: (p) => this.terminals.waitForExit(p.sessionId, p.terminalId),
      killTerminal: async (p) => { this.terminals.kill(p.sessionId, p.terminalId); return {}; },
      releaseTerminal: async (p) => { this.terminals.release(p.sessionId, p.terminalId); return {}; },
    };
  }

  private onUpdate(run: Run, update: acp.SessionUpdate): void {
    if (update.sessionUpdate === 'usage_update') {
      this.opts.onUsage?.({ sessionId: run.record.id, agent: run.record.agent, used: update.used, size: update.size, cost: update.cost ?? null, at: this.now() });
      return;
    }
    const { updates, patch, terminals } = run.mapper.apply(update, run.state.items, run.record.cwd);
    for (const u of updates) this.apply(run, u);
    if (patch) {
      this.apply(run, { op: 'meta', patch });
      if (patch.title) void this.opts.records.patch(run.record.id, { title: patch.title });
      if (patch.mode !== undefined || patch.models) this.remember(run);
    }
    for (const [terminalId, itemId] of terminals) {
      if (run.terminalRows.get(terminalId) === itemId) continue;
      run.terminalRows.set(terminalId, itemId);
      this.followTerminal(run, terminalId);
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update' || patch?.title) this.changed();
  }

  /** A terminal embedded in a tool row streams its output into that row. */
  private followTerminal(run: Run, terminalId: string): void {
    const itemId = run.terminalRows.get(terminalId);
    if (!itemId) return;
    const followed = this.terminals.follow(terminalId,
      (chunk) => this.apply(run, { op: 'append', id: itemId, field: 'output', chunk }),
      (exit) => this.patch(run, itemId, { exitCode: exit.exitCode }));
    if (followed) {
      this.patch(run, itemId, { output: followed.output, ...(followed.exit ? { exitCode: followed.exit.exitCode } : {}) });
    }
  }

  private onPermission(p: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    const id = this.bySession.get(p.sessionId);
    const run = id ? this.runs.get(id) : undefined;
    if (!run) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    // The tool call it is about gets (or refreshes) its row, waiting for the owner.
    this.onUpdate(run, { sessionUpdate: 'tool_call_update', ...p.toolCall });
    const tool = run.state.items.find((i) => i.kind === 'tool' && i.id === `tool-${p.toolCall.toolCallId}`);
    const itemId = `approval-${++this.seq}`;
    const { item, choices } = approvalItem(itemId, p, tool?.kind === 'tool' ? tool : undefined, this.nameOf(run), this.now(), run.record.cwd);
    this.apply(run, { op: 'upsert', item });
    if (tool) this.patch(run, tool.id, { status: 'waiting' });
    return new Promise((resolve) => {
      run.pending.set(itemId, { kind: 'permission', toolItemId: tool?.id ?? null, choices, resolve: (a) => resolve(a as acp.RequestPermissionResponse) });
      signal.addEventListener('abort', () => {
        const pending = run.pending.get(itemId);
        if (pending) this.expire(run, itemId, pending);
      }, { once: true });
      this.changed(run);
    });
  }

  /** The real path of `p` when the session may use it: inside its folder, allowed before, or
      allowed now by the owner on an approval card. Throws when the owner says no. */
  private async inScope(run: Run, p: string, verb: 'read' | 'write' | 'run a command in'): Promise<string> {
    run.root ??= await fs.realpath(run.record.cwd).catch(() => path.resolve(run.record.cwd));
    const { real, inside } = await locate(run.root, p);
    if (inside || run.allowedOutside.has(real)) return real;
    const itemId = `approval-${++this.seq}`;
    const what = verb === 'run a command in' ? 'a folder' : 'a file';
    this.apply(run, { op: 'upsert', item: {
      kind: 'approval', id: itemId, at: this.now(), toolItemId: null, title: `Allow ${this.nameOf(run)} to ${verb} ${what} outside the project folder?`,
      detail: `${real}\n\nThe project folder is ${run.root}.`, alwaysLabel: 'this path, for this session', status: 'pending',
    } });
    const allowed = await new Promise<boolean>((resolve) => {
      run.pending.set(itemId, { kind: 'scope', toolItemId: null, choices: null, resolve: (a) => resolve(a === true) });
      this.changed(run);
    });
    this.changed(run);
    if (!allowed) throw new Error(`The owner did not allow ${verb === 'run a command in' ? 'running a command in' : verb === 'read' ? 'reading' : 'writing'} ${real}: it is outside the project folder ${run.root}`);
    return real;
  }

  // ── State helpers ─────────────────────────────────────────────────────────────────────

  private nameOf(run: Run): string {
    return this.opts.agents().find((a) => a.id === run.record.agent)?.name ?? run.record.agentName;
  }

  private apply(run: Run, u: ChatUpdate): void {
    run.state = applyUpdate(run.state, u);
    run.emit?.(u);
  }

  private patch(run: Run, id: string, fields: Record<string, unknown>, onlyFrom?: string): void {
    const item = run.state.items.find((i) => i.id === id);
    if (!item || (onlyFrom !== undefined && (item as { status?: string }).status !== onlyFrom)) return;
    this.apply(run, { op: 'upsert', item: { ...item, ...fields } as ChatItem });
  }

  private expire(run: Run, itemId: string, p: Pending): void {
    run.pending.delete(itemId);
    p.resolve(p.kind === 'scope' ? false : { outcome: { outcome: 'cancelled' } });
    this.patch(run, itemId, { status: 'expired' }, 'pending');
    if (p.toolItemId) this.patch(run, p.toolItemId, { status: 'failed' }, 'waiting');
  }

  private notice(run: Run, level: 'info' | 'warn' | 'error', text: string): void {
    this.apply(run, { op: 'upsert', item: { kind: 'notice', id: `notice-${++this.seq}`, at: this.now(), level, text } });
  }
}
