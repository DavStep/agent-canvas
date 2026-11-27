// Which chats are Agent canvas's own (the canvas agent, the project orchestrators, internal calls)
// and which do the work, and the period's totals, rows, days and costliest overhead turns. Pure:
// the store hands it the buckets and what it knows of the chats.
import path from 'node:path';
import { agentDirectory, type AgentConnection } from '../../shared/agentConnection.ts';
import {
  emptyTotals, totalTokens, type UsageBilling, type UsageDay, type UsageGroup, type UsageKind, type UsagePeriod,
  type UsageRow, type UsageSummary, type UsageTotals, type UsageTurn,
} from '../../shared/usage.ts';
import type { UsageProvider } from './parse.ts';
import { costOf, PRICES_CHECKED } from './pricing.ts';

/** Usage summed per chat, turn, model and price band (see UsageStore). */
export interface UsageBucket {
  provider: UsageProvider;
  session: string;
  cwd: string;
  model: string;
  turn: string;
  long: boolean;
  /** The first and last call. */
  at: number;
  last: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  calls: number;
  kind?: 'internal';
  label?: string;
}

export interface ProjectRoleInfo { folder: string; connection: AgentConnection }

export interface ClassifyContext {
  /** The canvas agent's folder (its API connections run in subfolders, agentConnection.ts). */
  agentCwd: string | null;
  /** Orchestrator chats by card id, including ones a newer orchestrator replaced. */
  roles: Record<string, ProjectRoleInfo>;
}

export interface Classified { group: UsageGroup; kind: UsageKind; rowId: string; label: string; detail: string | null; billing: UsageBilling }

const PROVIDER_NAME: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex', acp: 'ACP agents' };
const CONNECTION: Record<AgentConnection, string> = { 'claude-login': 'Claude login', 'claude-api': 'Claude API key', 'codex-api': 'OpenAI API key' };

export function classify(b: Pick<UsageBucket, 'provider' | 'session' | 'cwd' | 'kind' | 'label'>, ctx: ClassifyContext): Classified {
  if (b.kind === 'internal') {
    const label = b.label || 'Internal call';
    return { group: 'overhead', kind: 'internal', rowId: `internal:${label}`, label, detail: null, billing: 'plan' };
  }
  const role = ctx.roles[b.session];
  if (role) {
    const name = path.basename(role.folder) || role.folder;
    return { group: 'overhead', kind: 'orchestrator', rowId: `orchestrator:${role.folder}`, label: `Orchestrator · ${name}`, detail: role.folder,
      billing: role.connection === 'claude-login' ? 'plan' : 'api' };
  }
  const root = ctx.agentCwd;
  if (root && (b.cwd === root || b.cwd.startsWith(root + path.sep))) {
    const connection: AgentConnection = b.cwd === agentDirectory(root, 'claude-api') ? 'claude-api'
      : b.cwd === agentDirectory(root, 'codex-api') ? 'codex-api' : 'claude-login';
    return { group: 'overhead', kind: 'agent', rowId: `agent:${connection}`, label: 'Canvas agent', detail: CONNECTION[connection],
      billing: connection === 'claude-login' ? 'plan' : 'api' };
  }
  return { group: 'work', kind: 'work', rowId: `work:${b.provider}`, label: `${PROVIDER_NAME[b.provider]} sessions`, detail: PROVIDER_NAME[b.provider], billing: 'plan' };
}

const DAY = 86_400_000;
const PERIOD_DAYS: Record<Exclude<UsagePeriod, 'all'>, number> = { today: 1, '7d': 7, '30d': 30 };

function localMidnight(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
const dayKey = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function addDays(t: number, n: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** Where a period starts: local midnight, today and the days before it; null for all of history. */
export function periodStart(period: UsagePeriod, now: number): number | null {
  if (period === 'all') return null;
  return addDays(localMidnight(now), -(PERIOD_DAYS[period] - 1));
}

/** The bars: one per local day, or per week (starting Monday) past 62 days. */
function daySlots(from: number, now: number): { unit: 'day' | 'week'; starts: number[] } {
  let start = localMidnight(from);
  const end = localMidnight(now);
  const unit = (end - start) / DAY > 62 ? 'week' : 'day';
  if (unit === 'week') start = addDays(start, -((new Date(start).getDay() + 6) % 7));
  const starts: number[] = [];
  for (let t = start; t <= end; t = addDays(t, unit === 'week' ? 7 : 1)) starts.push(t);
  return { unit, starts };
}

function add(t: UsageTotals, b: UsageBucket, cost: number | null): void {
  t.input += b.input; t.output += b.output; t.cacheRead += b.cacheRead; t.cacheWrite += b.cacheWrite;
  if (cost === null) t.unpriced += totalTokens(b);
  else t.cost += cost;
}

const TOP = 5;
const KIND_ORDER: Record<UsageKind, number> = { agent: 0, orchestrator: 1, internal: 2, work: 3 };

export interface SummaryOptions extends ClassifyContext {
  period: UsagePeriod;
  now: number;
  backfilling?: boolean;
}

export function summarize(buckets: Iterable<UsageBucket>, opts: SummaryOptions): UsageSummary {
  const from = periodStart(opts.period, opts.now);
  const rows = new Map<string, UsageRow>();
  const turns = new Map<string, Set<string>>();       // row id → turn keys
  const groupTurns: Record<UsageGroup, Set<string>> = { overhead: new Set(), work: new Set() };
  const totals: Record<UsageGroup, UsageTotals> = { overhead: emptyTotals(), work: emptyTotals() };
  const perTurn = new Map<string, UsageTurn>();
  const byDay = new Map<number, { overhead: number; work: number }>();
  const slots = daySlots(from ?? opts.now, opts.now);
  let since: number | null = null;
  let first: number | null = null;
  const inPeriod: { b: UsageBucket; c: Classified; cost: number | null }[] = [];

  for (const b of buckets) {
    since = since === null ? b.at : Math.min(since, b.at);
    if (from !== null && b.at < from) continue;
    first = first === null ? b.at : Math.min(first, b.at);
    inPeriod.push({ b, c: classify(b, opts), cost: costOf(b.model, b, b.long) });
  }
  // For all of history the bars start at the first usage on record.
  const bars = from === null && first !== null ? daySlots(first, opts.now) : slots;
  for (const t of bars.starts) byDay.set(t, { overhead: 0, work: 0 });

  for (const { b, c, cost } of inPeriod) {
    let row = rows.get(c.rowId);
    if (!row) {
      row = { ...emptyTotals(), id: c.rowId, group: c.group, kind: c.kind, label: c.label, detail: c.detail, billing: c.billing, share: 0 };
      rows.set(c.rowId, row);
    }
    add(row, b, cost);
    add(totals[c.group], b, cost);
    const turnKey = `${b.session}\t${b.turn}`;
    if (!b.turn.startsWith('sub:')) {
      let set = turns.get(c.rowId);
      if (!set) turns.set(c.rowId, set = new Set());
      set.add(turnKey);
      groupTurns[c.group].add(turnKey);
    }
    if (c.group === 'overhead') {
      const prev = perTurn.get(turnKey);
      const tokens = totalTokens(b);
      if (prev) { prev.tokens += tokens; prev.cost += cost ?? 0; prev.at = Math.min(prev.at, b.at); }
      else perTurn.set(turnKey, { session: b.session, kind: c.kind, label: c.label, at: b.at, tokens, cost: cost ?? 0 });
    }
    if (cost !== null) {
      let slot = bars.starts[0]!;
      for (const s of bars.starts) { if (s <= b.at) slot = s; else break; }
      const day = byDay.get(slot);
      if (day) day[c.group] += cost;
    }
  }

  for (const [id, set] of turns) rows.get(id)!.turns = set.size;
  totals.overhead.turns = groupTurns.overhead.size;
  totals.work.turns = groupTurns.work.size;
  const all = totals.overhead.cost + totals.work.cost;
  for (const row of rows.values()) row.share = all > 0 ? row.cost / all : 0;
  const sorted = [...rows.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.cost - a.cost || a.label.localeCompare(b.label));
  const days: UsageDay[] = [...byDay].map(([t, v]) => ({ day: dayKey(t), overhead: v.overhead, work: v.work }));
  const top = [...perTurn.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens).slice(0, TOP);

  return {
    period: opts.period, from, to: opts.now, overhead: totals.overhead, work: totals.work,
    share: all > 0 ? totals.overhead.cost / all : 0, rows: sorted, days, dayUnit: bars.unit, top,
    pricesChecked: PRICES_CHECKED, since, backfilling: opts.backfilling === true,
  };
}
