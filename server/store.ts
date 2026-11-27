import { isAgentDirectory } from '../shared/agentConnection.ts';
// The live source: polls Claude and Codex, then tells listeners when the snapshot changes. Each
// poll also decides every card's owner, and tells an engine when a session it runs turns up in
// another program.
import { watch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { providerBanner } from '../shared/banners.ts';
import type { Owner, Provider } from '../shared/chat.ts';
import type { Layout, LayoutOp, SessionHost, SessionView, Snapshot, SubagentView } from '../shared/types.ts';
import { CodexReader } from './adapter/codex.ts';
import { defaultProbe, whichAlive, type Probe } from './adapter/liveness.ts';
import { onePerSession, readSessionFiles, type RawSession } from './adapter/sessionFiles.ts';
import { readSubagents } from './adapter/subagents.ts';
import { findTranscript, readTail, type TranscriptTail } from './adapter/transcript.ts';
import type { Source } from './source.ts';
import { applyLayoutOp, ensureFolderZones } from './layoutOps.ts';
import { folderOf } from './activity.ts';
import { ACP_PREFIX } from '../shared/acp.ts';
import type { ChatEngine, Engine } from './engines/engine.ts';
import { hostOf, processTable, type ProcInfo } from './engines/host.ts';
import { foreignFile, lineage, ownerOf, RELEASING_NOTE, type OwnerContext } from './engines/ownership.ts';
import { recentClaude, type RecentSession } from './engines/recent.ts';
import { recentView, toView, type ReplyTracker } from './state.ts';
import { promptLine } from '../shared/attachments.ts';
import { limitPending, limitReady } from '../shared/interruption.ts';

const DEFAULT_POLL_MS = 1000;
/** fs.watch can fire many times for one rewrite; polls never start closer together than this. */
const DEFAULT_MIN_GAP_MS = 250;
/** A torn file keeps its session's previous view for this many polls. */
const MAX_TORN_POLLS = 3;
/** Recent (not live) Claude sessions shown, as many as Codex shows. */
const DEFAULT_RECENT = 40;
const CODEX_PREFIX = 'codex:';


/** This app's engines: Claude's and Codex's, and the one for the configured ACP agents. */
export type StoreEngines = Partial<Record<Provider, Engine>> & { acp?: ChatEngine };
export interface StoreOptions {
  claudeHome: string;
  codexHome?: string;
  layout: Layout;
  replies: ReplyTracker;
  pollMs?: number;
  /** Least time between the starts of two polls. */
  minGapMs?: number;
  /** How processes are checked; the real one by default. */
  probe?: Probe;
  onPersist?: (layout: Layout, replies: Record<string, number>, dismissed: Record<string, number>) => void;
  /** Interruptions the owner aborted: session id → the time of the latest one dismissed (epoch ms). */
  dismissed?: Record<string, number>;
  /** How many recent Claude sessions without a live process are shown (40 by default). */
  recentLimit?: number;
  /** This app's chat engines. What they run is `here`; one whose session turns up in another
      program is told so (Engine.lost). */
  engines?: StoreEngines;
  /** The process the engines run in, whose direct children are this app's Claude processes.
      Without it every live Claude session file is another program's. */
  appPid?: number;
  /** Parent pids of running processes, when only those are known (no hosts then). */
  parents?: (pids: number[]) => Promise<Map<number, number>>;
  /** Running processes (parent, tty, command), for owners and for where a session another
      program runs lives; one `ps` call by default. */
  processes?: (pids: number[]) => Promise<Map<number, ProcInfo>>;
  /** The canvas agent's folder. A conversation in this or an API agent directory is the agent: it is
      no card (left out of `sessions`, and no folder zone is made for it); the one started last
      is the snapshot's `agent`. */
  agentCwd?: string;
}

/** The agent's session as main reported it started, shown until the session files show it. */
export interface StartedAgent { id: string; cwd: string; provider: Provider; text: string; at: number }

interface Entry {
  raw: RawSession;
  transcript: string | null;
  mtimeMs: number | null;
  tail: TranscriptTail | null;
  subagents: SubagentView[];
  tornPolls: number;
}

async function mtimeOf(file: string | null): Promise<number | null> {
  if (file === null) return null;
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

const byStart = (a: SessionView, b: SessionView): number => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class Store implements Source {
  private readonly sessionsDir: string;
  private readonly projectsDir: string;
  private readonly codex: CodexReader | null;
  private readonly replies: ReplyTracker;
  private readonly pollMs: number;
  private readonly minGapMs: number;
  private readonly probe: Probe;
  private readonly onPersist?: StoreOptions['onPersist'];
  private readonly recentLimit: number;
  private readonly engines: StoreEngines;
  private readonly appPid: number | null;
  private readonly processes: (pids: number[]) => Promise<Map<number, ProcInfo>>;
  private readonly listeners = new Set<() => void>();

  private layout: Layout;
  private entries = new Map<string, Entry>();
  private codexSessions: SessionView[] = [];
  private codexError: string | null = null;
  private recent: RecentSession[] = [];
  /** Every live session file (two can name one session) and their parent pids, for owners. */
  private liveFiles: OwnerContext['claudeFiles'] = [];
  private procs = new Map<number, ProcInfo>();
  private owners = new Map<string, Owner>();
  private sessions: SessionView[] = [];
  /** `sessions` and the agent's sessions together: what owners are decided and reported over. */
  private views: SessionView[] = [];
  private readonly agentCwd: string | null;
  private agent: SessionView | null = null;
  /** The conversation the owner started last here: it is the agent even before a poll finds it. */
  private startedAgent: StartedAgent | null = null;
  private banners: Snapshot['banners'] = { claude: null, codex: null };
  private shown: string;
  private persistedLayout: Layout;
  private persistedReplies: string;
  /** Session id → the latest interruption the owner aborted (its `at`): it stays gone on rescans. */
  private readonly dismissed: Map<string, number>;
  private persistedDismissed: string;

  private timer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private lastPollAt = -Infinity;
  private lastQuotaCheck = -Infinity;
  /** Rebuilds the cards when the next usage limit resets, so they turn "Ready to continue" on time. */
  private resetTimer: NodeJS.Timeout | null = null;
  private resetTimerAt: number | null = null;
  private checkingQuota = false;

  constructor(opts: StoreOptions) {
    this.sessionsDir = path.join(opts.claudeHome, 'sessions');
    this.projectsDir = path.join(opts.claudeHome, 'projects');
    this.codex = opts.codexHome ? new CodexReader(opts.codexHome) : null;
    this.layout = opts.layout;
    this.replies = opts.replies;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.minGapMs = opts.minGapMs ?? DEFAULT_MIN_GAP_MS;
    this.probe = opts.probe ?? defaultProbe;
    this.onPersist = opts.onPersist;
    this.recentLimit = opts.recentLimit ?? DEFAULT_RECENT;
    this.engines = opts.engines ?? {};
    this.appPid = opts.appPid ?? null;
    this.agentCwd = opts.agentCwd ?? null;
    const parents = opts.parents;
    this.processes = opts.processes ?? (parents
      ? async (pids) => new Map([...await parents(pids)].map(([pid, ppid]) => [pid, { ppid, tty: null, comm: '' }]))
      : processTable);
    this.shown = this.fingerprint();
    this.persistedLayout = this.layout;
    this.persistedReplies = JSON.stringify(this.replies.toJSON());
    this.dismissed = new Map(Object.entries(opts.dismissed ?? {}));
    this.persistedDismissed = JSON.stringify(opts.dismissed ?? {});
  }

  /** Abort on an interrupted session: it is a normal idle card from now on, and this interruption
      does not come back on a rescan (a later one does). `undo` brings it back. */
  dismissInterruption(id: string, undo = false): void {
    const view = this.views.find((v) => v.id === id);
    if (undo) {
      this.dismissed.delete(id);
    } else {
      const shown = view?.interruption;
      if (!shown) return;
      this.dismissed.set(id, Math.max(shown.at, this.dismissed.get(id) ?? 0));
      const target = this.engineFor(view);
      target?.engine.interruptions?.delete(target.id);
      // Old dismissals of sessions long gone are let go.
      const old = Date.now() - 90 * 86_400_000;
      for (const [key, at] of this.dismissed) if (at < old) this.dismissed.delete(key);
    }
    this.publish();
  }

  snapshot(): Snapshot {
    return {
      generatedAt: Date.now(), demo: false, sessions: this.sessions, layout: this.layout, banners: this.banners,
      ...(this.agentCwd !== null ? { agent: this.agent } : {}),
    };
  }

  /** Main started a conversation with the agent: it is the snapshot's `agent` from now on, as a
      stand-in view until a poll reads the real one from Claude Code's files. */
  agentStarted(s: StartedAgent): void {
    this.startedAgent = s;
    this.publish();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  applyLayout(op: LayoutOp): void {
    this.layout = applyLayoutOp(this.layout, op);
    this.publish();
  }

  markSeen(ids: string[] | 'all'): void {
    this.replies.markSeen(ids);
    this.publish();
  }

  /** A card's owner as of the last poll, or null for a session not on the canvas. */
  owner(id: string): Owner | null {
    return this.owners.get(id) ?? null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
    void this.poll();
  }

  /** Stops polling; resolves once a poll in flight (if any) has finished, without a follow-up. */
  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    this.resetTimerAt = null;
    this.watcher?.close();
    this.watcher = null;
    this.again = false;
    return this.running ?? Promise.resolve();
  }

  /**
   * One poll; calls that arrive while one runs (or waits) are folded into a single follow-up
   * poll. A poll starts no sooner than minGapMs after the previous one started.
   */
  poll(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      await this.waitForGap();
      for (;;) {
        this.again = false;
        this.lastPollAt = performance.now();
        try {
          await this.pollOnce();
        } catch (err) {
          process.stderr.write(`agent-canvas: poll failed: ${(err as Error).message}\n`);
        }
        if (!this.again) break;
        await this.waitForGap();
        if (!this.again) break; // stop() cancelled the follow-up while it waited
      }
      this.running = null;
    })();
    return this.running;
  }

  private async waitForGap(): Promise<void> {
    const wait = this.lastPollAt + this.minGapMs - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  private ensureWatch(): void {
    if (!this.timer || this.watcher) return;
    try {
      this.watcher = watch(this.sessionsDir, () => { void this.poll(); });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null; // folder missing: try again next poll
    }
  }

  private async pollOnce(): Promise<void> {
    this.ensureWatch();
    const codexPoll = this.readCodex();
    const recentPoll = this.readRecent();
    const { sessions: files, torn } = await readSessionFiles(this.sessionsDir);
    const alive = await whichAlive(files, this.probe);
    const live = onePerSession(files, alive);
    const liveFiles = files.filter((_, i) => alive[i]);
    // Only this app's own processes can be here, so with no app pid there is nothing to ask.
    const procs = this.appPid === null || liveFiles.length === 0 ? new Map<number, ProcInfo>() : await this.lookUpProcesses(liveFiles.map((f) => f.pid));
    const next = new Map<string, Entry>();
    for (const raw of live) next.set(raw.sessionId, await this.read(raw, this.entries.get(raw.sessionId)));
    for (const id of torn) {
      const prev = this.entries.get(id);
      if (prev && !next.has(id) && prev.tornPolls < MAX_TORN_POLLS) next.set(id, { ...prev, tornPolls: prev.tornPolls + 1 });
    }
    const now = Date.now();
    await codexPoll;
    await recentPoll;
    this.liveFiles = liveFiles;
    this.procs = procs;
    for (const entry of next.values()) {
      if (entry.tornPolls === 0) this.replies.observe(entry.raw.sessionId, entry.raw.status, now);
    }
    const acp = this.acpViews();
    for (const v of acp) this.replies.observe(v.id, v.rawStatus, now);
    this.replies.forget([...next.keys(), ...this.codexSessions.map((s) => s.id), ...acp.map((v) => v.id)]);
    this.entries = next;
    // The agent is no card, so its folder gets no zone.
    const folders = new Set([...next.values()].filter((e) => !isAgentDirectory(this.agentCwd, e.raw.cwd)).map((e) => folderOf(e.raw.cwd)));
    for (const session of this.codexSessions) if (!isAgentDirectory(this.agentCwd, session.cwd)) folders.add(session.folder);
    for (const r of this.recent) if (!next.has(r.id) && !isAgentDirectory(this.agentCwd, r.cwd)) folders.add(folderOf(r.cwd));
    for (const v of acp) if (!isAgentDirectory(this.agentCwd, v.cwd)) folders.add(v.folder);
    this.layout = ensureFolderZones(this.layout, [...folders]);
    this.publish();
    if (performance.now() - this.lastQuotaCheck >= 60_000) void this.refreshCodexLimit();
  }

  /** Recheck a blocked account on focus, a provider update, or once a minute while waiting. */
  async refreshCodexLimit(): Promise<void> {
    const engine = this.engines.codex;
    if (!engine || this.checkingQuota || !this.views.some(v => v.interruption?.codexUsage === 'blocked')) return;
    this.lastQuotaCheck = performance.now();
    this.checkingQuota = true;
    try {
      await engine.account();
      this.publish();
    } catch {
      // Keep the saved interruption until a later account check succeeds.
    } finally {
      this.checkingQuota = false;
    }
  }

  /** The process table, or an empty map (every parent unknown) when the lookup fails. */
  private async lookUpProcesses(pids: number[]): Promise<Map<number, ProcInfo>> {
    try {
      return await this.processes([...new Set(pids)]);
    } catch (err) {
      process.stderr.write(`agent-canvas: process lookup failed: ${(err as Error).message}\n`);
      return new Map();
    }
  }

  private async readCodex(): Promise<void> {
    if (this.codex === null) return;
    const now = Date.now();
    try {
      this.codexSessions = await this.codex.read(now);
      this.codexError = null;
      for (const session of this.codexSessions) {
        const status = session.state === 'working' ? 'busy' : session.state === 'needs_you' ? 'waiting'
          : session.rawStatus === 'completed' ? 'idle' : 'unknown';
        this.replies.observe(session.id, status, now);
      }
    } catch (err) {
      const message = (err as Error).message;
      if (message !== this.codexError) process.stderr.write(`agent-canvas: Codex read failed: ${message}\n`);
      this.codexError = message; // Keep the previous cards during a temporary database error.
    }
  }

  private async readRecent(): Promise<void> {
    try {
      this.recent = await recentClaude(this.projectsDir, this.recentLimit);
    } catch (err) {
      process.stderr.write(`agent-canvas: recent Claude sessions failed: ${(err as Error).message}\n`);
    }
  }

  private async read(raw: RawSession, prev: Entry | undefined): Promise<Entry> {
    const transcript = await findTranscript(this.projectsDir, raw.sessionId);
    const mtimeMs = await mtimeOf(transcript);
    const unchanged = prev !== undefined && prev.transcript === transcript && prev.mtimeMs === mtimeMs && prev.raw.status === raw.status;
    const tail = unchanged ? prev.tail : transcript === null ? null : await readTail(transcript);
    const subagents = transcript !== null && (raw.status === 'busy' || raw.status === 'shell')
      ? await readSubagents(transcript, raw.sessionId, raw.statusUpdatedAt)
      : [];
    return { raw, transcript, mtimeMs, tail, subagents, tornPolls: 0 };
  }

  /** Review Focus 1: a session that turned up elsewhere is reported to its engine, which stops its
      own process if it runs it; again on each poll while the engine still runs it. A Claude
      session the engine runs is only taken away when another process tree's file is positively
      seen, never because its parents could not be told. */
  private tellLost(ctx: OwnerContext): void {
    const owners = new Map(this.views.map((s) => [s.id, s.owner]));
    for (const view of this.views) {
      if (view.owner !== 'elsewhere') continue;
      const target = this.engineFor(view);
      if (!target) continue;
      const runsIt = target.engine.owned().has(target.id);
      if (runsIt && target.engine.shared?.().has(target.id)) continue;
      if (this.owners.get(view.id) === 'elsewhere' && !runsIt) continue;
      if (view.provider === 'claude' && runsIt && !foreignFile(view.id, ctx)) continue;
      try {
        target.engine.lost(target.id);
      } catch (err) {
        process.stderr.write(`agent-canvas: telling the ${view.provider} engine failed: ${(err as Error).message}\n`);
      }
    }
    this.owners = owners;
  }

  private fingerprint(): string {
    return JSON.stringify({ sessions: this.sessions, layout: this.layout, banners: this.banners, agent: this.agent });
  }

  /** The process another program runs a Claude session in: its live file positively traced to
      another tree, else the one the card was read from. */
  private elsewherePid(id: string, ctx: Pick<OwnerContext, 'appPid' | 'parentOf'>): number | null {
    return this.liveFiles.find((f) => f.sessionId === id && lineage(f.pid, ctx) === 'foreign')?.pid ?? this.entries.get(id)?.raw.pid ?? null;
  }

  private hostFor(id: string, ctx: OwnerContext): SessionHost | null {
    const pid = this.elsewherePid(id, ctx);
    return pid === null ? null : hostOf(pid, this.procs)?.host ?? null;
  }

  /** The pid of a live Claude session another program runs, as of the last poll, for "Show in
      Terminal"; null for any other card. */
  hostPid(id: string): number | null {
    const card = this.views.find((s) => s.id === id);
    if (card?.provider !== 'claude' || card.owner !== 'elsewhere' || !this.entries.has(id)) return null;
    return this.elsewherePid(id, { appPid: this.appPid, parentOf: (pid) => this.procs.get(pid)?.ppid ?? null });
  }

  /** The ACP engine's cards, or none. */
  private acpViews(): SessionView[] {
    try {
      return this.engines.acp?.views?.() ?? [];
    } catch (err) {
      process.stderr.write(`agent-canvas: ACP cards failed: ${(err as Error).message}\n`);
      return [];
    }
  }

  /** An engine without provider files (ACP) changed a card: its turns are seen as they happen
      (a finished one needs a reply, as a poll would have it), and the views are rebuilt. */
  engineChanged(): void {
    const now = Date.now();
    const acp = this.acpViews();
    for (const v of acp) this.replies.observe(v.id, v.rawStatus, now);
    const folders = acp.filter((v) => !isAgentDirectory(this.agentCwd, v.cwd)).map((v) => v.folder);
    if (folders.length > 0) this.layout = ensureFolderZones(this.layout, folders);
    this.publish();
  }

  /** The engine for a card, and the id it knows the session by (Codex: the bare thread id). */
  private engineFor(view: SessionView): { engine: ChatEngine; id: string } | null {
    const engine = this.engines[view.provider];
    if (!engine) return null;
    const prefix = view.provider === 'codex' ? CODEX_PREFIX : view.provider === 'acp' ? ACP_PREFIX : null;
    return { engine, id: prefix !== null && view.id.startsWith(prefix) ? view.id.slice(prefix.length) : view.id };
  }

  /** Approvals and questions waiting in this app's engines: the providers' own files never say
      so (Codex's only tell working from idle), so the card, the rail's Needs-you group and the
      Dock badge learn it here. A card the provider already shows waiting for the same thing
      keeps its own activity line. */
  /** A turn cut off by a limit, an error or its process ending (from the provider's files, or
      seen by this app's engine) makes its card "Needs you · interrupted", until a new turn
      starts or the owner aborts it. A session this app runs is never cut off while it runs it. */
  private withInterruptions(views: SessionView[]): SessionView[] {
    return views.map((v) => {
      const target = this.engineFor(v);
      const witnessed = target?.engine.interruptions?.get(target.id);
      if (witnessed && v.state === 'working' && v.stateSince > witnessed.at) target!.engine.interruptions!.delete(target!.id);
      let found = witnessed ?? v.interruption;
      if (found && !witnessed && found.kind === 'killed' && v.owner === 'here') found = undefined;
      if (found && (v.state === 'working' || (v.state === 'needs_you' && v.need !== 'reply'))) found = undefined;
      const dismissedAt = this.dismissed.get(v.id);
      if (found && dismissedAt !== undefined && found.at <= dismissedAt) found = undefined;
      if (!found) {
        if (!v.interruption) return v;
        const { interruption: _, ...rest } = v;
        return rest;
      }
      // Saved Codex turns have second precision. A read started before (or in the same
      // recorded second as) a new failure cannot clear its countdown.
      const allowedAt = this.engines.codex?.usageAllowedAt;
      if (v.provider === 'codex' && found.codexUsage === 'blocked' && allowedAt != null
        && Math.floor(allowedAt / 1000) > Math.floor(found.at / 1000)) {
        found = { ...found, codexUsage: 'available', resetsAt: null, reason: 'Continue the interrupted turn when you’re ready.' };
      }
      // A limit that has reset no longer holds the session: it only waits for Continue.
      const activity = found.kind === 'limit' && found.codexUsage !== 'available' && limitReady(found, Date.now()) ? 'Limit reset · you can continue' : found.reason;
      return { ...v, state: 'needs_you', need: 'interrupted', interruption: found, activity, stateSince: found.at || v.stateSince, subagents: [] };
    });
  }

  private withWaits(views: SessionView[]): SessionView[] {
    const waits = new Map<string, 'permission' | 'question' | 'turn'>();
    for (const provider of ['claude', 'codex', 'acp'] as const) {
      for (const b of this.engines[provider]?.busy() ?? []) {
        const id = provider === 'codex' ? CODEX_PREFIX + b.sessionId : provider === 'acp' ? ACP_PREFIX + b.sessionId : b.sessionId;
        if (b.reason !== 'turn' || !waits.has(id)) waits.set(id, b.reason === 'approval' ? 'permission' : b.reason);
      }
    }
    if (waits.size === 0) return views;
    return views.map((v) => {
      const need = waits.get(v.id);
      if (need === 'turn') {
        if (v.owner !== 'here' || v.state === 'working' || (v.state === 'needs_you' && v.need !== 'reply' && v.need !== 'interrupted')) return v;
        const { interruption: _, ...rest } = v;
        return { ...rest, state: 'working', need: null, activity: null };
      }
      if (!need || (v.state === 'needs_you' && v.need === need)) return v;
      return { ...v, state: 'needs_you', need, activity: need === 'permission' ? 'Wants permission' : 'Has a question' };
    });
  }

  /** A view of the agent conversation just started, for as long as the engine runs it and
      the provider's files do not show it yet (a poll finds it within a second or so). */
  private agentStandIn(known: SessionView[]): SessionView[] {
    const s = this.startedAgent;
    if (s === null || this.agentCwd === null || known.some((v) => v.id === s.id)) return [];
    const engineId = s.provider === 'codex' ? s.id.slice(CODEX_PREFIX.length) : s.id;
    if (!this.engines[s.provider]?.owned().has(engineId)) return [];
    return [{
      id: s.id, provider: s.provider, hostId: null, name: '', cwd: s.cwd, folder: folderOf(s.cwd), state: 'working', need: null,
      activity: 'Working', rawStatus: 'busy', stateSince: s.at, startedAt: s.at, branch: null, model: null,
      lastPrompt: promptLine(s.text).slice(0, 2000), lastAnswer: null, subagents: [], owner: 'here', ownerNote: null, host: null,
    }];
  }

  /** A rebuild just after the soonest usage limit still to reset (the agent's conversation too). */
  private armResetTimer(): void {
    const now = Date.now();
    const next = [...this.views].map((v) => v.interruption).filter((i) => i !== undefined && limitPending(i, now))
      .reduce<number | null>((min, i) => (min === null || i!.resetsAt! < min ? i!.resetsAt! : min), null);
    if (next === this.resetTimerAt) return;
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    this.resetTimerAt = next;
    if (next === null) return;
    // setTimeout holds at most ~24.8 days; a later reset is re-armed by the rebuild then.
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      this.resetTimerAt = null;
      this.publish();
    }, Math.min(next - now + 1000, 2 ** 31 - 1));
    this.resetTimer.unref?.();
  }

  /** Rebuilds the views, then notifies listeners and persists only what changed. */
  private publish(): void {
    const engineOwned = new Set<string>([
      ...(this.engines.claude?.owned() ?? []),
      ...[...(this.engines.codex?.owned() ?? [])].map((id) => CODEX_PREFIX + id),
    ]);
    const releasing = new Set([...(this.engines.codex?.releasing() ?? [])].map((id) => CODEX_PREFIX + id));
    const ctx: OwnerContext = {
      claudeFiles: this.liveFiles, appPid: this.appPid, parentOf: (pid) => this.procs.get(pid)?.ppid ?? null, engineOwned,
      lastOwner: (id) => this.owners.get(id) ?? null,
    };
    const claudeOwner = (id: string) => ownerOf({ id, provider: 'claude', state: 'idle' }, ctx);
    const claude = [...this.entries.values()].map((e) => {
      const id = e.raw.sessionId;
      // A torn file says nothing new about who holds it.
      const owner = e.tornPolls > 0 ? this.owners.get(id) ?? claudeOwner(id) : claudeOwner(id);
      return toView(e.raw, e.tail, e.subagents, this.replies.needsReply(id), owner, owner === 'elsewhere' ? this.hostFor(id, ctx) : null);
    });
    const recent = this.recent.filter((r) => !this.entries.has(r.id)).map((r) => recentView(r, claudeOwner(r.id)));
    const codex = this.codexSessions.map((s): SessionView => {
      const owner = ownerOf(s, ctx);
      const view: SessionView = { ...s, owner, ownerNote: owner === 'here' && releasing.has(s.id) ? RELEASING_NOTE : null };
      return this.replies.needsReply(s.id) ? { ...view, state: 'needs_you', need: 'reply', activity: 'Finished' } : view;
    });
    // ACP sessions run only here; their cards come from the engine's own records.
    const acp = this.acpViews().map((v) => (this.replies.needsReply(v.id) && v.state === 'idle' ? { ...v, state: 'needs_you' as const, need: 'reply' as const, activity: 'Finished' } : v));
    this.views = this.withWaits(this.withInterruptions([...claude, ...recent, ...this.agentStandIn([...claude, ...recent, ...codex]), ...codex, ...acp])).sort(byStart);
    const isAgent = (v: SessionView): boolean => isAgentDirectory(this.agentCwd, v.cwd);
    this.sessions = this.views.filter((v) => !isAgent(v));
    // The conversation started last here, else the newest one known.
    const agents = this.views.filter(isAgent);
    this.agent = agents.find((v) => v.id === this.startedAgent?.id) ?? agents.at(-1) ?? null;
    this.banners = { claude: providerBanner(this.engines.claude?.banner ?? null), codex: providerBanner(this.engines.codex?.banner ?? null) };
    this.tellLost(ctx);
    this.armResetTimer();
    const shown = this.fingerprint();
    if (shown !== this.shown) {
      this.shown = shown;
      for (const cb of [...this.listeners]) {
        try {
          cb();
        } catch (err) {
          process.stderr.write(`agent-canvas: change listener failed: ${(err as Error).message}\n`);
        }
      }
    }
    const replies = this.replies.toJSON();
    const repliesText = JSON.stringify(replies);
    const dismissed = Object.fromEntries(this.dismissed);
    const dismissedText = JSON.stringify(dismissed);
    if (this.layout !== this.persistedLayout || repliesText !== this.persistedReplies || dismissedText !== this.persistedDismissed) {
      this.persistedLayout = this.layout;
      this.persistedReplies = repliesText;
      this.persistedDismissed = dismissedText;
      this.onPersist?.(this.layout, replies, dismissed);
    }
  }
}
