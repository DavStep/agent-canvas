import { agentDirectory, isAgentDirectory } from '../shared/agentConnection.ts';
// The mockup's eleven sessions (mockups/BRIEF.md) as a Snapshot, plus an in-memory Source, and a
// scripted chat engine for them, so demo mode needs no real Claude or Codex.
// The 'large' variant is forty sessions over twelve folders, none placed, for first placement and Fit.
// All names and content are invented demo data.
import type { ProviderAccount } from '../shared/account.ts';
import type { NewSessionRequest } from '../shared/bridge.ts';
import type {
  ApprovalAnswer, ChatItem, ChatState, ChatUpdate, ImageRef, ModelOption, ModeOption, Owner, Provider,
} from '../shared/chat.ts';
import type { Layout, LayoutOp, SessionInterruption, SessionView, Snapshot, SubagentView } from '../shared/types.ts';
import { applyUpdate } from './engines/chatLog.ts';
import type { BusySession, Engine } from './engines/engine.ts';
import { OPENED_ELSEWHERE } from './engines/ownership.ts';
import { BUSY_ELSEWHERE, WRITING_ALONGSIDE } from '../shared/banners.ts';
import type { Source } from './source.ts';
import { applyLayoutOp, ensureFolderZones } from './layoutOps.ts';
import { folderOf } from './activity.ts';
import { promptLine } from '../shared/attachments.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HOME = '/Users/demo/Documents';
/** The canvas agent's folder in the demo: a session started here is the agent, not a card. */
export const DEMO_AGENT_CWD = '/Users/demo/.agent-canvas/agent';

interface DemoCard {
  id: string;
  provider?: SessionView['provider'];
  name: string;
  folder: string;
  state: SessionView['state'];
  need?: SessionView['need'];
  activity?: string;
  recentSteps?: SessionView['recentSteps'];
  branch: string | null;
  /** How long the session has been in its current state. */
  since: number;
  /** How long ago the session started, when it matters for card order (default: 20 min before `since`). */
  started?: number;
  subagents?: SubagentView[];
  lastPrompt?: string;
  lastAnswer?: string;
  /** Who holds it (default nobody): the demo shows all three. */
  owner?: Owner;
  /** A turn cut off `since` ago (state needs_you, need interrupted); `resetsIn`: a limit's reset, from now. */
  interruption?: { kind: SessionInterruption['kind']; reason: string; resetsIn?: number };
}

const CARDS: DemoCard[] = [
  { id: 'demo-reconnect', name: 'Reconnection dialog and animation issues', folder: 'garden-sim',
    state: 'working', activity: 'Editing ReconnectDialog.tsx', branch: 'fix/reconnect', since: 6 * MIN, owner: 'here',
    recentSteps: [{ kind: 'read', label: 'Read ReconnectDialog.tsx', status: 'done', durationMs: 1400 }] },
  { id: 'demo-hostly', name: 'Enable account deletion approvals on Hostly', folder: 'garden-sim',
    state: 'needs_you', need: 'permission', activity: 'Wants to run: ssh hostly systemctl restart api',
    branch: 'main', since: 2 * MIN, owner: 'here' },
  { id: 'demo-purchases', name: 'Purchases unavailable in production', folder: 'garden-sim',
    state: 'needs_you', need: 'reply',
    activity: 'Found it: product IDs differ between sandbox and production', branch: 'main', since: 14 * MIN, owner: 'here' },
  { id: 'demo-preview', name: 'Preview improvement suggestions', folder: 'garden-sim',
    state: 'idle', branch: 'main', since: 3 * HOUR, started: 3 * DAY },
  { id: 'demo-codex', provider: 'codex', name: 'Codex usage credits analysis', folder: 'garden-sim',
    state: 'idle', branch: 'main', since: 20 * HOUR, started: 2 * DAY },
  { id: 'demo-dbviz', name: 'Database visualization dashboard', folder: 'garden-dashboard',
    state: 'working', activity: 'Running tests', branch: 'feat/db-viz', since: 11 * MIN, owner: 'elsewhere',
    subagents: [
      { id: 'demo-dbviz-sub-1', type: 'schema-explorer', description: 'Map the database schema', state: 'working' },
      { id: 'demo-dbviz-sub-2', type: 'chart-builder', description: 'Build the table size chart', state: 'done' },
    ] },
  { id: 'demo-mcp', name: 'Dashboard as MCP', folder: 'garden-dashboard',
    state: 'idle', branch: 'main', since: 1 * HOUR, started: 6 * DAY },
  { id: 'demo-3d', name: 'Agent setup 3D graph visualization', folder: 'garden-dashboard',
    state: 'idle', branch: 'main', since: 5 * HOUR, started: 4 * DAY },
  { id: 'demo-progression', name: 'trying to analyze the progression shown', folder: 'garden-dashboard',
    state: 'idle', branch: 'main', since: 22 * HOUR, started: 3 * DAY,
    lastPrompt: 'When does each ad offer first show up in the Mine?',
    // A table in a reply, as agents write them: bold cells, a right-aligned number column.
    lastAnswer:
      'On a fresh run, the Mine shows the ad offers in this order:\n\n' +
      '| Offer | First appears at | Reward | Lasts |\n' +
      '|---|---|--:|---|\n' +
      '| **×2 Hit Damage** | **80 Stone** earned this run | ×2 | 3 min |\n' +
      '| **×2 Stone** | **100 Stone** earned this run | ×2 | 3 min |\n' +
      '| **Auto Tap** | **150 Stone** earned across runs | 5 taps/s | 60 s |\n\n' +
      'Spending Stone still counts toward all three unlocks. Both ×2 offers also stay unlocked ' +
      'after you pass the threshold once, so a new run shows them from the start (`offers.ts`).' },
  { id: 'demo-deploy', name: 'Deploy changes', folder: 'sailcloth-io',
    state: 'idle', branch: 'main', since: 40 * MIN, owner: 'elsewhere' },
  { id: 'demo-friend-notes', name: 'System discussion with friend notes', folder: '',
    state: 'working', activity: 'Laying out visual directions', branch: null, since: 1 * MIN, owner: 'here',
    lastPrompt: 'Standalone canvas',
    lastAnswer:
      'The check is back, and it narrows the choice to two real options.\n\n' +
      'I recommend the standalone canvas because all 11 of your live sessions are desktop-app ' +
      'sessions; the other route makes you change how you work before you get any value.\n\n' +
      'I left the comparison on the ticket: https://tickets.example.com/t/4576.' },
];

/** Zone positions copied from the mockup (mockups/nightdesk-v2.html), so the demo composes like it. */
const ZONE_POSITIONS: Record<string, { x: number; y: number }> = {
  'garden-sim': { x: 0, y: 0 },
  'garden-dashboard': { x: 40, y: 356 },
  'sailcloth-io': { x: 572, y: 344 },
  '': { x: 604, y: 500 },
};

/** The most recent 17:42 local time at or before `now` (the selected card's start time). */
function lastFiveFortyTwo(now: number): number {
  const d = new Date(now);
  d.setHours(17, 42, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

function toView(card: DemoCard, index: number, now: number): SessionView {
  const stateSince = now - card.since;
  const startedAt = card.id === 'demo-friend-notes'
    ? Math.min(lastFiveFortyTwo(now), stateSince)
    : now - (card.started ?? card.since + 20 * MIN);
  return {
    id: card.id,
    provider: card.provider ?? 'claude',
    hostId: `local_demo-${index + 1}`,
    name: card.name,
    cwd: card.folder === '' ? '/Users/demo' : `${HOME}/${card.folder}`,
    folder: card.folder,
    state: card.state,
    need: card.need ?? null,
    activity: card.activity ?? null,
    ...(card.recentSteps ? { recentSteps: card.recentSteps } : {}),
    rawStatus: card.state,
    stateSince,
    startedAt,
    branch: card.branch,
    model: 'Fable 5.2',
    lastPrompt: card.lastPrompt ?? null,
    lastAnswer: card.lastAnswer ?? null,
    subagents: card.subagents ?? [],
    owner: card.owner ?? 'nobody',
    ownerNote: null,
    host: null,
    ...(card.interruption ? { interruption: {
      kind: card.interruption.kind, reason: card.interruption.reason, at: stateSince,
      resetsAt: card.interruption.resetsIn === undefined ? null : now + card.interruption.resetsIn,
    } } : {}),
  };
}

/** Twelve folders and how many of the forty large-variant sessions each holds ('' is "No folder"). */
const LARGE_FOLDERS: [string, number][] = [
  ['harbor-api', 9], ['lantern-web', 6], ['moss-ledger', 5], ['tidepool', 4], ['quarry-cli', 3], ['fern-docs', 3],
  ['orbit-mobile', 2], ['kiln-infra', 2], ['sparrow-ml', 2], ['cobalt-auth', 2], ['drift-data', 1], ['', 1],
];

const LARGE_NAMES = [
  'Rate limiter for public endpoints', 'Retry webhooks with backoff', 'Split the billing service', 'Audit log export',
  'Pagination on the orders list', 'Healthcheck flaps under load', 'Migrate to the new queue', 'Trim cold start time',
  'Fix the flaky invoice test', 'Dark mode for settings', 'Keyboard shortcuts overlay', 'Empty states for search',
  'Onboarding checklist', 'Image upload progress', 'Chart tooltips overlap', 'Reconcile ledger totals',
  'Currency rounding bug', 'Monthly statement PDF', 'Import bank CSV files', 'Archive closed accounts',
  'Tide chart widget', 'Offline sync for notes', 'Sensor data backfill', 'Alert on missing readings',
  'Shell completions', 'Config file migration', 'Release notes generator', 'Search the docs site',
  'API reference examples', 'Broken links in guides', 'Push notification opt-in', 'Crash on rotate',
  'Terraform state cleanup', 'Rotate staging certificates', 'Evaluate the ranking model', 'Label the feedback set',
  'Session expiry warning', 'Passkey sign-in', 'Nightly export job', 'Scratch notes on naming',
];

const DEMO_LIMIT_TEXT = "You've hit your 5-hour limit · resets 9pm";

const LARGE_ACTIVITY = ['Running tests', 'Editing handlers.ts', 'Reading schema.sql', 'Thinking', 'Searching the codebase'];

/** Forty invented sessions, a steady mix of working, needs you and idle. */
function largeCards(): DemoCard[] {
  const cards: DemoCard[] = [];
  for (const [folder, count] of LARGE_FOLDERS) {
    for (let j = 0; j < count; j++) {
      const i = cards.length;
      const id = `demo-large-${i + 1}`;
      const branch = folder === '' ? null : i % 3 === 0 ? 'main' : `feat/task-${i + 1}`;
      const since = ((i * 17) % 90 + 1) * MIN;
      const kind = i % 6;
      const base = { id, name: LARGE_NAMES[i]!, folder, branch, since };
      if (kind === 0 || kind === 3) {
        cards.push({ ...base, state: 'working', activity: LARGE_ACTIVITY[i % LARGE_ACTIVITY.length]!, owner: kind === 0 ? 'here' : 'elsewhere',
          subagents: i % 12 === 0
            ? [{ id: `${id}-sub-1`, type: 'test-runner', description: 'Run the test suite', state: 'working' }]
            : undefined });
      } else if (kind === 1) {
        cards.push({ ...base, state: 'needs_you', need: i % 4 === 1 ? 'permission' : 'reply', owner: 'here',
          activity: i % 4 === 1 ? 'Wants to run: npm run migrate' : 'Done: the change is ready for review' });
      } else if (i === 2) {
        // Cut off by a usage limit that resets in two hours, and (below) by the app closing mid-turn.
        cards.push({ ...base, state: 'needs_you', need: 'interrupted', activity: DEMO_LIMIT_TEXT,
          interruption: { kind: 'limit', reason: DEMO_LIMIT_TEXT, resetsIn: 2 * HOUR } });
      } else if (i === 4) {
        cards.push({ ...base, state: 'needs_you', need: 'interrupted', activity: 'Its process ended mid-turn, while running Bash',
          interruption: { kind: 'killed', reason: 'Its process ended mid-turn, while running Bash' } });
      } else {
        cards.push({ ...base, state: 'idle', since: since * 3 });
      }
    }
  }
  return cards;
}

export type DemoVariant = 'mockup' | 'large';

export function demoSnapshot(now: number, variant: DemoVariant = 'mockup'): Snapshot {
  const cards = variant === 'large' ? largeCards() : CARDS;
  const sessions = cards.map((card, index) => toView(card, index, now));
  const empty: Layout = { version: 1, zones: [], assignments: {} };
  const folders = [...new Set(sessions.map((s) => s.folder))];
  const layout = ensureFolderZones(empty, folders);
  // The large variant leaves every zone for the page to place.
  const positions = variant === 'large' ? {} : ZONE_POSITIONS;
  const zones = layout.zones.map((z) => ({ ...z, ...(positions[z.folder ?? ''] ?? {}) }));
  return { generatedAt: now, demo: true, sessions, layout: { ...layout, zones }, banners: { claude: null, codex: null } };
}

/** Demo folders are invented, so none is on disk: one named "missing-folder" stands for a folder
    that is gone (the New session dialog's error), every other one exists. */
export async function demoFolderKind(p: string): Promise<'dir' | 'missing'> {
  return /\/missing-folder\/?$/.test(p) ? 'missing' : 'dir';
}
/** A demo start in a folder named "slow-start" takes this long, as a slow process would. */
export const DEMO_SLOW_START_MS = 2_500;

/** A session the New session dialog started, for the demo's canvas (the live Store finds its own). */
export interface StartedSession { title?: string; id: string; provider: Provider; cwd: string; text: string; at: number }

/** The first line of the first message, as the session's name until the provider gives one. */
const firstLine = (text: string): string => promptLine(text).trim().split('\n')[0]!.trim().slice(0, 120);

/** An in-memory Source over the demo snapshot. Layout, "seen" and started sessions live until restart. */
export function createDemoSource(now: number, variant: DemoVariant = 'mockup'): Source & {
  started(s: StartedSession): void;
  /** The agent's scripted turn began or ended. */
  agentTurn(id: string, running: boolean): void;
  /** A card's scripted turn moved on (demoEngine's onTurn): the card shows it. */
  turn(id: string, phase: DemoTurnPhase, answer?: string): void;
} {
  const initial = demoSnapshot(now, variant);
  let sessions = initial.sessions;
  let layout = initial.layout;
  let agent: SessionView | null = null;
  /** Interrupted cards the owner aborted, as they were, for Undo. */
  const dismissedDemo = new Map<string, SessionView>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const cb of listeners) cb(); };

  return {
    snapshot: () => ({ generatedAt: Date.now(), demo: true, sessions, layout, banners: { claude: null, codex: null }, agent }),
    onChange(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    applyLayout(op: LayoutOp) {
      const next = applyLayoutOp(layout, op);
      if (next === layout) return;
      layout = next;
      emit();
    },
    dismissInterruption(id, undo = false) {
      const s = sessions.find((x) => x.id === id);
      if (!s) return;
      if (undo) {
        const before = dismissedDemo.get(id);
        if (!before) return;
        dismissedDemo.delete(id);
        sessions = sessions.map((x) => (x.id === id ? before : x));
      } else {
        if (!s.interruption) return;
        dismissedDemo.set(id, s);
        const { interruption: _, ...rest } = s;
        sessions = sessions.map((x) => (x.id === id ? { ...rest, state: 'idle', need: null, activity: null, rawStatus: 'idle' } : x));
      }
      emit();
    },
    markSeen(ids) {
      const at = Date.now();
      let changed = false;
      sessions = sessions.map((s) => {
        if (s.state !== 'needs_you' || s.need !== 'reply') return s;
        if (ids !== 'all' && !ids.includes(s.id)) return s;
        changed = true;
        return { ...s, state: 'idle', need: null, activity: null, rawStatus: 'idle', stateSince: at };
      });
      if (changed) emit();
    },
    started({ id, provider, cwd, title, text, at }) {
      if (sessions.some((s) => s.id === id)) return;
      const folder = folderOf(cwd);
      const view: SessionView = {
        id, provider, hostId: null, name: title ?? firstLine(text), cwd, folder, state: 'working', need: null, activity: 'Thinking', rawStatus: 'working',
        stateSince: at, startedAt: at, branch: null, model: 'Fable 5.2', lastPrompt: text.slice(0, 2000), lastAnswer: null, subagents: [],
        owner: 'here', ownerNote: null, host: null,
      };
      // A session in the agent's folder is the canvas agent: no card, and no zone for its folder.
      if (isAgentDirectory(DEMO_AGENT_CWD, cwd)) {
        agent = view;
      } else {
        sessions = [...sessions, view];
        layout = ensureFolderZones(layout, [folder]);
      }
      emit();
    },
    turn(id, phase, answer) {
      // Codex cards started here carry the codex: prefix; the engine knows the bare id.
      const card = sessions.find((s) => s.id === id) ?? sessions.find((s) => s.id === `codex:${id}`);
      if (!card) return;
      const at = Date.now();
      const { interruption: _, ...rest } = card;
      const next: SessionView = phase === 'working' ? { ...rest, state: 'working', need: null, activity: 'Thinking', rawStatus: 'working', stateSince: at, owner: 'here' }
        : phase === 'waiting' ? { ...rest, state: 'needs_you', need: 'permission', activity: 'Wants to run: npm test', rawStatus: 'waiting', stateSince: at, owner: 'here' }
          : phase === 'done' ? { ...rest, state: 'needs_you', need: 'reply', activity: 'Finished', rawStatus: 'idle', stateSince: at, lastAnswer: answer ?? card.lastAnswer }
            : { ...rest, state: 'idle', need: null, activity: null, rawStatus: 'idle', stateSince: at };
      sessions = sessions.map((s) => (s.id === card.id ? next : s));
      emit();
    },
    agentTurn(id, running) {
      // A demo card's new turn (Continue on an interrupted one): it works again.
      const card = sessions.find((s) => s.id === id);
      if (card) {
        if (!running || !card.interruption) return;
        const { interruption: _, ...rest } = card;
        sessions = sessions.map((s) => (s.id === id ? { ...rest, state: 'working', need: null, activity: 'Thinking', rawStatus: 'working', stateSince: Date.now() } : s));
        emit();
        return;
      }
      if (agent?.id !== id || (agent.state === 'working') === running) return;
      agent = running
        ? { ...agent, state: 'working', activity: 'Thinking', rawStatus: 'working', stateSince: Date.now() }
        : { ...agent, state: 'idle', activity: null, rawStatus: 'idle', stateSince: Date.now(), lastAnswer: DEMO_AGENT_REPORT };
      emit();
    },
  };
}

// ── The demo chat engine ──────────────────────────────────────────────────────────────────

const DEMO_READ_ONLY = 'Open in another app — read-only here';
const DEMO_MODELS: ModelOption[] = [
  { id: 'demo-large', label: 'Fable 5.2', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'demo-small', label: 'Fable 5.2 Mini', isDefault: false, efforts: ['low', 'medium', 'high'], defaultEffort: 'low' },
];
const DEMO_MODES: Record<Provider, ModeOption[]> = {
  claude: [
    { id: 'auto', label: 'Auto' }, { id: 'default', label: 'Ask' }, { id: 'acceptEdits', label: 'Accept edits' },
    { id: 'plan', label: 'Plan' }, { id: 'bypassPermissions', label: 'Bypass' },
  ],
  codex: [{ id: 'read-only', label: 'Read only' }, { id: 'auto', label: 'Auto' }, { id: 'full-access', label: 'Full access' }],
};
const DEMO_DIFF = [
  '--- a/src/purchases/products.ts', '+++ b/src/purchases/products.ts', '@@ -1,4 +1,6 @@',
  " export const PRODUCT_IDS = {", "-  gems: 'gems_100_sandbox',", "+  gems: isProduction ? 'gems_100' : 'gems_100_sandbox',",
  "+  // Production and sandbox ids differ: pick by environment.", " };",
].join('\n');

const DEMO_READ = [
  "import { isProduction } from '../env';", '', 'export const PRODUCT_IDS = {', "  gems: 'gems_100_sandbox',", '};', '',
].join('\n');

let demoCardsById: Map<string, DemoCard> | null = null;
function demoCard(id: string): DemoCard | undefined {
  demoCardsById ??= new Map([...CARDS, ...largeCards()].map((c) => [c.id, c]));
  return demoCardsById.get(id);
}

/** The agent's scripted answer to anything: a short report by zone, what needs the owner first. */
export const DEMO_AGENT_REPORT = [
  '**garden-sim**: 2 need you, 1 working',
  '- Enable account deletion approvals on Hostly: waiting 2m for permission to run `ssh hostly systemctl restart api`',
  '- Purchases unavailable in production: finished 14m ago; product IDs differ between sandbox and production',
  '- Reconnection dialog and animation issues: working 6m, editing ReconnectDialog.tsx',
  '',
  '**garden-dashboard**: 1 working',
  '- Database visualization dashboard: working 11m, running tests (open in another app)',
  '',
  '**No folder**: 1 working',
  '- System discussion with friend notes: working 1m, laying out visual directions',
  '',
  '5 other sessions are idle. No open tickets are assigned to you.',
].join('\n');

interface DemoChat {
  /** The canvas agent's chat: its turns play the agent's script (an overview, then a report). */
  agent?: boolean;
  state: ChatState;
  emit: ((u: ChatUpdate) => void) | null;
  timers: NodeJS.Timeout[];
  /** What the next approval answer continues with. */
  waiting: { approvalId: string; toolId: string } | null;
}

/** Where a demo card's scripted turn is: running, stopped at its approval, finished, or stopped by the owner. */
export type DemoTurnPhase = 'working' | 'waiting' | 'done' | 'stopped';

/** A scripted Engine for demo mode: each message plays a turn with streamed text, an edit, and a
    command that waits for approval. Nothing is read or written, and no process is started. */
export function demoEngine(provider: Provider, opts: {
  stepMs?: number; now?: () => number; previewUrl?: string;
  /** The agent's turn began or ended, or a card's turn began (createDemoSource's agentTurn shows it on the snapshot). */
  onAgentTurn?: (sessionId: string, running: boolean) => void;
  /** A card's scripted turn began, stopped at its approval, finished or was stopped (createDemoSource's
      turn shows it). Off unless asked for: the e2e test of links (AGENT_CANVAS_DEMO_TURNS) needs cards that finish. */
  onTurn?: (sessionId: string, phase: DemoTurnPhase, answer?: string) => void;
} = {}): Engine {
  const stepMs = opts.stepMs ?? 400;
  /** The dev server address the test run prints, which the Browser tab opens. */
  const previewUrl = opts.previewUrl ?? 'http://localhost:5199/';
  const now = opts.now ?? Date.now;
  const chats = new Map<string, DemoChat>();
  let seq = 0;
  const nextId = (chat: DemoChat, kind: string) => `${chat.state.sessionId}-${kind}-${++seq}`;

  const apply = (chat: DemoChat, u: ChatUpdate) => {
    chat.state = applyUpdate(chat.state, u);
    chat.emit?.(u);
  };
  const upsert = (chat: DemoChat, item: ChatItem) => apply(chat, { op: 'upsert', item });
  const find = (chat: DemoChat, id: string) => chat.state.items.find((i) => i.id === id);
  /** Plays the steps one stepMs apart. Each step sets the next one's timer, so they run in order
      even on a busy machine (timers of different lengths set together may fire out of order). */
  const later = (chat: DemoChat, steps: (() => void)[]) => {
    const run = (n: number): void => {
      if (n >= steps.length) return;
      const t = setTimeout(() => {
        steps[n]!();
        run(n + 1);
      }, stepMs);
      t.unref?.();
      chat.timers.push(t);
    };
    run(0);
  };
  const cancel = (chat: DemoChat) => {
    for (const t of chat.timers) clearTimeout(t);
    chat.timers = [];
  };
  const get = (id: string): DemoChat => {
    const chat = chats.get(id);
    if (!chat) throw new Error('This demo chat is not open');
    return chat;
  };

  function create(id: string, cwd?: string): DemoChat {
    const card = demoCard(id);
    const owner: Owner = card?.owner ?? (cwd !== undefined ? 'here' : 'nobody');
    const at = now() - (card?.since ?? 0);
    const items: ChatItem[] = card ? [
      { kind: 'user', id: `${id}-u0`, at: at - 60_000, text: card.lastPrompt ?? card.name, images: [] },
      { kind: 'assistant', id: `${id}-a0`, at: at - 30_000, text: card.lastAnswer ?? 'I read through the code and have a plan; tell me when to go ahead.', streaming: false },
    ] : [];
    const running = card?.state === 'working';
    if (card?.interruption?.kind === 'limit') items[1] = { kind: 'assistant', id: `${id}-a0`, at, text: card.interruption.reason, streaming: false };
    if (card?.interruption?.kind === 'killed') {
      items.push({ kind: 'tool', id: `${id}-t0`, at, tool: 'command', name: 'Bash', target: 'npm test', status: 'failed', output: null, exitCode: null, diffs: [] });
    }
    if (running) {
      items.push({ kind: 'tool', id: `${id}-t0`, at, tool: 'command', name: 'Bash', target: card.activity ?? 'npm test', status: 'running', output: null, exitCode: null, diffs: [] });
    }
    if (card?.need === 'permission' && owner === 'here') {
      const command = card.activity?.replace(/^Wants to run: /, '') ?? 'npm test';
      items.push({ kind: 'tool', id: `${id}-t0`, at, tool: 'command', name: 'Bash', target: command, status: 'waiting', output: null, exitCode: null, diffs: [] });
      items.push({ kind: 'approval', id: `${id}-p0`, at, toolItemId: `${id}-t0`, title: 'Allow this command?', detail: command, alwaysLabel: "this project's local settings", status: 'pending' });
    }
    const chat: DemoChat = {
      emit: null, timers: [], waiting: card?.need === 'permission' && owner === 'here' ? { approvalId: `${id}-p0`, toolId: `${id}-t0` } : null,
      state: {
        sessionId: id, provider, owner, title: card?.name ?? '', cwd: cwd ?? (card ? (card.folder === '' ? '/Users/demo' : `${HOME}/${card.folder}`) : HOME),
        items, hasOlder: false, turn: running ? 'running' : 'idle', model: DEMO_MODELS[0]!.id, models: DEMO_MODELS,
        mode: 'auto', modes: DEMO_MODES[provider], banner: owner === 'elsewhere' && provider === 'claude' ? DEMO_READ_ONLY : null,
      },
    };
    chats.set(id, chat);
    return chat;
  }

  /** The scripted turn up to the approval: the mockup's thought, reply, read, edit and command. */
  function play(chat: DemoChat): void {
    const thought = nextId(chat, 'r');
    const answer = nextId(chat, 'a');
    const read = nextId(chat, 't');
    const edit = nextId(chat, 't');
    const command = nextId(chat, 't');
    const approval = nextId(chat, 'p');
    const words = ['Found it: ', 'the product ids differ ', 'between sandbox and production. ', 'Fixing the lookup now.'];
    later(chat, [
      () => upsert(chat, { kind: 'reasoning', id: thought, at: now(), text: 'The ids come from products.ts; check which one production uses.', streaming: true, durationMs: null }),
      () => {
        const item = find(chat, thought);
        if (item?.kind === 'reasoning') upsert(chat, { ...item, streaming: false, durationMs: 6000 });
        upsert(chat, { kind: 'assistant', id: answer, at: now(), text: words[0]!, streaming: true });
      },
      ...words.slice(1).map((w) => () => apply(chat, { op: 'append', id: answer, field: 'text', chunk: w })),
      () => {
        const item = find(chat, answer);
        if (item?.kind === 'assistant') upsert(chat, { ...item, streaming: false });
        upsert(chat, { kind: 'tool', id: read, at: now(), tool: 'read', name: 'Read', target: 'src/purchases/products.ts', status: 'done',
          output: DEMO_READ, exitCode: null, diffs: [] });
        upsert(chat, { kind: 'tool', id: edit, at: now(), tool: 'edit', name: 'Edit', target: 'src/purchases/products.ts', status: 'done', output: null, exitCode: null,
          diffs: [{ path: 'src/purchases/products.ts', unified: DEMO_DIFF, added: 2, removed: 1 }] });
      },
      () => {
        upsert(chat, { kind: 'tool', id: command, at: now(), tool: 'command', name: 'Bash', target: 'npm test', status: 'waiting', output: null, exitCode: null, diffs: [] });
        upsert(chat, { kind: 'approval', id: approval, at: now(), toolItemId: command, title: 'Allow this command?', detail: 'npm test\n\nRun the tests',
          alwaysLabel: provider === 'claude' ? "this project's local settings" : 'this session', status: 'pending' });
        chat.waiting = { approvalId: approval, toolId: command };
        opts.onTurn?.(chat.state.sessionId, 'waiting');
      },
    ]);
  }

  /** The agent's scripted turn: it reads the canvas with its own tool, then reports by zone. */
  function playAgent(chat: DemoChat): void {
    const tool = nextId(chat, 't');
    const answer = nextId(chat, 'a');
    const lines = DEMO_AGENT_REPORT.split('\n');
    opts.onAgentTurn?.(chat.state.sessionId, true);
    later(chat, [
      () => upsert(chat, { kind: 'tool', id: tool, at: now(), tool: 'mcp', name: 'mcp__canvas__canvas_overview', target: '', status: 'running', output: null, exitCode: null, diffs: [] }),
      () => {
        const t = find(chat, tool);
        if (t?.kind === 'tool') upsert(chat, { ...t, status: 'done', output: '11 sessions in 4 zones' });
        upsert(chat, { kind: 'assistant', id: answer, at: now(), text: `${lines[0]!}\n`, streaming: true });
      },
      () => apply(chat, { op: 'append', id: answer, field: 'text', chunk: lines.slice(1).join('\n') }),
      () => {
        // The whole report, whatever has streamed so far.
        upsert(chat, { kind: 'assistant', id: answer, at: find(chat, answer)?.at ?? now(), text: DEMO_AGENT_REPORT, streaming: false });
        apply(chat, { op: 'meta', patch: { turn: 'idle' } });
        opts.onAgentTurn?.(chat.state.sessionId, false);
      },
    ]);
  }

  function finish(chat: DemoChat, text: string): void {
    upsert(chat, { kind: 'assistant', id: nextId(chat, 'a'), at: now(), text, streaming: false });
    apply(chat, { op: 'meta', patch: { turn: 'idle' } });
    opts.onTurn?.(chat.state.sessionId, 'done', text);
  }

  const engine: Engine = {
    provider,
    banner: null,
    async open(sessionId, emit) {
      const chat = chats.get(sessionId) ?? create(sessionId);
      chat.emit = emit;
      return chat.state;
    },
    close(sessionId) {
      const chat = chats.get(sessionId);
      if (chat) chat.emit = null;
    },
    async loadOlder() {},
    async send(sessionId: string, text: string, images: ImageRef[]) {
      const chat = get(sessionId);
      if (chat.state.owner === 'elsewhere') {
        // Codex queues with the current writer. Claude writes between the other app’s turns.
        if (provider === 'codex') {
          upsert(chat, { kind: 'user', id: nextId(chat, 'u'), at: now(), text, images, queued: true });
          return;
        }
        if (chat.state.turn === 'running') throw new Error(BUSY_ELSEWHERE);
        upsert(chat, { kind: 'notice', id: nextId(chat, 'n'), at: now(), level: 'info', text: WRITING_ALONGSIDE });
        apply(chat, { op: 'meta', patch: { banner: null } });
      }
      upsert(chat, { kind: 'user', id: nextId(chat, 'u'), at: now(), text, images });
      apply(chat, { op: 'meta', patch: { owner: 'here', turn: 'running' } });
      if (chat.agent) playAgent(chat);
      else {
        opts.onAgentTurn?.(sessionId, true);
        opts.onTurn?.(sessionId, chat.waiting ? 'waiting' : 'working');
        if (!chat.waiting) play(chat);
      }
    },
    async interrupt(sessionId) {
      const chat = get(sessionId);
      cancel(chat);
      chat.waiting = null;
      for (const i of chat.state.items) {
        if (i.kind === 'approval' && i.status === 'pending') upsert(chat, { ...i, status: 'expired' });
        if (i.kind === 'tool' && (i.status === 'running' || i.status === 'waiting')) upsert(chat, { ...i, status: 'failed' });
        if (i.kind === 'assistant' && i.streaming) upsert(chat, { ...i, streaming: false });
      }
      upsert(chat, { kind: 'notice', id: nextId(chat, 'n'), at: now(), level: 'info', text: 'Stopped' });
      apply(chat, { op: 'meta', patch: { turn: 'idle' } });
      if (chat.agent) opts.onAgentTurn?.(sessionId, false);
      else opts.onTurn?.(sessionId, 'stopped');
    },
    async answerApproval(sessionId: string, approvalId: string, answer: ApprovalAnswer) {
      const chat = get(sessionId);
      const approval = find(chat, approvalId);
      if (approval?.kind !== 'approval' || approval.status !== 'pending' || chat.waiting?.approvalId !== approvalId) throw new Error('This approval is no longer waiting');
      const { toolId } = chat.waiting;
      chat.waiting = null;
      upsert(chat, { ...approval, status: answer === 'allow' ? 'allowed' : answer === 'allowAlways' ? 'allowedAlways' : 'denied' });
      const tool = find(chat, toolId);
      if (tool?.kind !== 'tool') return;
      if (answer === 'deny') {
        upsert(chat, { ...tool, status: 'denied' });
        apply(chat, { op: 'meta', patch: { turn: 'running' } });
        later(chat, [() => finish(chat, "Okay, I left the tests alone. The fix is in place; run them when you're ready.")]);
        return;
      }
      upsert(chat, { ...tool, status: 'running' });
      apply(chat, { op: 'meta', patch: { turn: 'running' } });
      opts.onTurn?.(sessionId, 'working');
      later(chat, [
        () => apply(chat, { op: 'append', id: toolId, field: 'output', chunk: '> demo@1.0.0 test\n> vitest run\n\n' }),
        () => {
          const t = find(chat, toolId);
          if (t?.kind === 'tool') {
            upsert(chat, { ...t, output: `${t.output ?? ''} \u001b[32m✓\u001b[39m 42 tests passed\n\n  Preview: \u001b[36m${previewUrl}\u001b[39m\n`, status: 'done', exitCode: 0 });
          }
        },
        () => finish(chat, 'All 42 tests pass. Purchases now use the production product ids outside the sandbox.'),
      ]);
    },
    async answerQuestion(sessionId, questionId, answers) {
      const chat = get(sessionId);
      const q = find(chat, questionId);
      if (q?.kind !== 'question' || q.status !== 'pending') throw new Error('This question is no longer waiting');
      upsert(chat, { ...q, status: 'answered', answers });
    },
    async setModel(sessionId, model) {
      apply(get(sessionId), { op: 'meta', patch: { model } });
    },
    async setMode(sessionId, mode) {
      apply(get(sessionId), { op: 'meta', patch: { mode } });
    },
    async moveHere(sessionId) {
      const chat = get(sessionId);
      if (chat.state.owner === 'elsewhere') apply(chat, { op: 'meta', patch: { owner: 'here', banner: null } });
      return true;
    },
    async rename(id, title) { apply(get(id), { op: 'meta', patch: { title } }); },
    async start(req: NewSessionRequest, options) {
      if (/\/slow-start\/?$/.test(req.cwd)) await new Promise((r) => setTimeout(r, DEMO_SLOW_START_MS));
      const id = `demo-new-${++seq}`;
      const chat = create(id, req.cwd);
      if (options?.title) chat.state.title = options.title;
      chat.agent = isAgentDirectory(DEMO_AGENT_CWD, req.cwd);
      chat.state.apiKeyAuth = provider === 'claude' && req.cwd === agentDirectory(DEMO_AGENT_CWD, 'claude-api');
      apply(chat, { op: 'meta', patch: { model: req.model ?? chat.state.model, mode: req.mode ?? chat.state.mode } });
      await engine.send(id, req.text, req.images);
      return id;
    },
    async options() {
      return { models: DEMO_MODELS, model: DEMO_MODELS[0]!.id, effort: 'medium', modes: DEMO_MODES[provider], mode: 'auto' };
    },
    lost(sessionId) {
      const chat = chats.get(sessionId);
      if (!chat || chat.state.owner === 'elsewhere') return;
      cancel(chat);
      chat.waiting = null;
      apply(chat, { op: 'meta', patch: { owner: 'elsewhere', turn: 'idle', banner: provider === 'claude' ? DEMO_READ_ONLY : null } });
      if (provider === 'claude') upsert(chat, { kind: 'notice', id: nextId(chat, 'n'), at: now(), level: 'warn', text: OPENED_ELSEWHERE });
    },
    owned: () => new Set([...chats.values()].filter((c) => c.state.owner === 'here').map((c) => c.state.sessionId)),
    releasing: () => new Set(),
    busy: () => [...chats.values()].flatMap((c): BusySession[] =>
      c.waiting ? [{ sessionId: c.state.sessionId, reason: 'approval' }] : c.state.turn === 'running' ? [{ sessionId: c.state.sessionId, reason: 'turn' }] : []),
    async account(): Promise<ProviderAccount> {
      const t = now();
      return {
        provider, signedIn: true, email: 'demo@example.com', plan: provider === 'claude' ? 'max' : 'pro', note: null,
        ...(provider === 'codex' ? { availableResets: 2 } : {}),
        // Codex's weekly number is left out, as a provider sometimes does: the page says "Not reported".
        windows: provider === 'claude'
          ? [{ label: '5 h', usedPercent: 12, resetsAt: t + 2 * HOUR }, { label: 'Weekly', usedPercent: 40, resetsAt: t + 3 * DAY }]
          : [{ label: '5 h', usedPercent: 31, resetsAt: t + 4 * HOUR }, { label: 'Weekly', usedPercent: null, resetsAt: t + 5 * DAY }],
      };
    },
    async stop() {
      for (const chat of chats.values()) cancel(chat);
    },
  };
  return engine;
}
