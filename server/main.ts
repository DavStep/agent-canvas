import { isAgentDirectory } from '../shared/agentConnection.ts';
// Builds the canvas's source: the live Store with its saved layout and reply marks, or the demo.
import path from 'node:path';
import { createDemoSource, type DemoTurnPhase, type DemoVariant, type StartedSession } from './demo.ts';
import { withCleanItems } from '../shared/boardItems.ts';
import { withCleanNotes } from '../shared/boardNotes.ts';
import { withCleanSlots } from '../shared/cardSlots.ts';
import { createDebouncedSave, isLayout, isReplyState, loadJson, saveJsonAtomic, type ReplyState } from './persist.ts';
import type { Source } from './source.ts';
import { ReplyTracker } from './state.ts';
import { Store } from './store.ts';
import type { Owner, Provider } from '../shared/chat.ts';
import { recentCodexCompletions } from './adapter/codex.ts';
import { ACTIVITY_LIMIT, ActivityLog, isActivityLog } from './activityLog.ts';
import type { ActivityEntry, Layout } from '../shared/types.ts';
import type { ChatEngine } from './engines/engine.ts';
import type { StoreEngines } from './store.ts';

const SAVE_DEBOUNCE_MS = 300;

export type SourceOptions =
  /** `acp`: the ACP engine, whose cards (its own records) join the demo's. */
  | { demo: DemoVariant; acp?: ChatEngine }
  | {
    demo: null; claudeHome: string; codexHome: string; dataHome: string;
    /** This app's chat engines and the process they run in, for owners (see Store). */
    engines?: StoreEngines; appPid?: number;
    /** The canvas agent's folder: its sessions are no cards (see Store). */
    agentCwd?: string;
  };

export interface RunningSource {
  source: Source;
  /** Starts polling (a no-op for the demo). */
  start(): void;
  /** Stops polling, lets a poll in flight finish, then writes any save still waiting on its debounce. */
  stop(): Promise<void>;
  /** A card's owner as of the last poll, or null for a session not on the canvas. */
  owner(id: string): Owner | null;
  /** A session just started here. The demo adds its card; the live Store finds a card in the
      provider's own files on its next poll, and is told only of a conversation with the canvas
      agent (a session in the agent's folder), which is the snapshot's `agent` at once. */
  started?(s: StartedSession): void;
  /** Demo only: the agent's scripted turn began or ended, for the snapshot's `agent`. */
  agentTurn?(id: string, running: boolean): void;
  /** Demo only: a card's scripted turn moved on (demoEngine's onTurn). */
  turn?(id: string, phase: DemoTurnPhase, answer?: string): void;
  /** Polls now (the live Store), so a change an engine made shows without waiting for the timer. */
  refresh?(): Promise<void>;
  refreshCodexLimit?(): Promise<void>;
  /** An engine with no provider files to poll (ACP) changed a card: the views are rebuilt. */
  engineChanged?(): void;
  /** The pid of a live Claude session another program runs (the live Store), for "Show in Terminal". */
  hostPid?(id: string): number | null;
}

export async function createSource(opts: SourceOptions): Promise<RunningSource> {
  const running = await createBoardSource(opts);
  const file = opts.demo === null ? path.join(opts.dataHome, 'activity-log.json') : null;
  const saved = file ? await loadJson<ActivityEntry[]>(file, [], isActivityLog) : [];
  const backfill = opts.demo === null ? await recentCodexCompletions(opts.codexHome, ACTIVITY_LIMIT).catch(err => {
    process.stderr.write(`agent-canvas: could not read past Codex completions: ${String(err)}\n`);
    return [];
  }) : [];
  const log = new ActivityLog(saved, backfill);
  const saver = createDebouncedSave(async () => { if (file) await saveJsonAtomic(file, log.entries); }, SAVE_DEBOUNCE_MS);
  if (file && log.entries.some((entry, i) => entry !== saved[i])) saver.schedule();
  const board = running.source;
  const record = () => { if (log.observe(board.snapshot()) && file) saver.schedule(); };
  record();
  // Subscribe before the window so every broadcast includes the event it announces.
  const off = board.onChange(record);
  return {
    ...running,
    source: {
      snapshot: () => ({ ...board.snapshot(), activityLog: log.entries }),
      onChange: cb => board.onChange(cb),
      applyLayout: op => board.applyLayout(op),
      markSeen: ids => board.markSeen(ids),
      dismissInterruption: (id, undo) => board.dismissInterruption(id, undo),
    },
    stop: async () => { await running.stop(); off(); await saver.flush(); },
  };
}

async function createBoardSource(opts: SourceOptions): Promise<RunningSource> {
  // Demo mode never reads or writes the data folder.
  if (opts.demo !== null) {
    const demo = createDemoSource(Date.now(), opts.demo);
    const acp = opts.acp;
    const listeners = new Set<() => void>();
    // The demo's cards, then the ACP agents' (real sessions: e2e starts one with a stub agent).
    const source: typeof demo = acp?.views ? {
      ...demo,
      snapshot: () => {
        const snap = demo.snapshot();
        return { ...snap, sessions: [...snap.sessions, ...acp.views!()] };
      },
      onChange: (cb) => {
        listeners.add(cb);
        const off = demo.onChange(cb);
        return () => { listeners.delete(cb); off(); };
      },
    } : demo;
    return {
      source, start() {}, stop: async () => {},
      engineChanged: () => { for (const cb of [...listeners]) cb(); },
      owner: (id) => source.snapshot().sessions.find((s) => s.id === id)?.owner ?? null,
      started: (s) => source.started(s),
      agentTurn: (id, running) => source.agentTurn(id, running),
      turn: (id, phase, answer) => source.turn(id, phase, answer),
    };
  }

  const layoutFile = path.join(opts.dataHome, 'layout.json');
  const stateFile = path.join(opts.dataHome, 'state.json');
  const layout = withCleanNotes(withCleanSlots(withCleanItems(await loadJson<Layout>(layoutFile, { version: 1, zones: [], assignments: {} }, isLayout))));
  const state = await loadJson<ReplyState>(stateFile, { version: 1, pendingReply: {} }, isReplyState);

  let latest: { layout: Layout; pendingReply: Record<string, number>; dismissed: Record<string, number> } | null = null;
  const saver = createDebouncedSave(async () => {
    if (latest === null) return;
    const { layout: l, pendingReply, dismissed } = latest;
    await Promise.all([
      saveJsonAtomic(layoutFile, l),
      saveJsonAtomic(stateFile, { version: 1, pendingReply, dismissedInterruptions: dismissed } satisfies ReplyState),
    ]);
  }, SAVE_DEBOUNCE_MS);
  const store = new Store({
    claudeHome: opts.claudeHome,
    codexHome: opts.codexHome,
    layout,
    replies: new ReplyTracker(state.pendingReply),
    dismissed: state.dismissedInterruptions,
    onPersist: (l, pendingReply, dismissed) => {
      latest = { layout: l, pendingReply, dismissed };
      saver.schedule();
    },
    engines: opts.engines,
    appPid: opts.appPid,
    agentCwd: opts.agentCwd,
  });
  const { agentCwd } = opts;
  return {
    source: store,
    start: () => store.start(),
    // A poll in flight may schedule a save, so it finishes before the flush; a failure is already logged.
    stop: () => store.stop().then(() => saver.flush()),
    owner: (id) => store.owner(id),
    started: (s) => {
      if (!isAgentDirectory(agentCwd, s.cwd)) return;
      store.agentStarted(s);
      void store.poll();
    },
    refresh: () => store.poll(),
    refreshCodexLimit: () => store.refreshCodexLimit(),
    engineChanged: () => store.engineChanged(),
    hostPid: (id) => store.hostPid(id),
  };
}
