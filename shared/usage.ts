// Token usage of this app's own agents (the canvas agent, the project orchestrators, any internal
// model call) against the sessions doing the actual work: what Settings → Usage and the canvas
// agent's get_usage_summary show. Costs are estimates from server/usage/pricing.ts.

export type UsagePeriod = 'today' | '7d' | '30d' | 'all';
export const USAGE_PERIODS: readonly UsagePeriod[] = ['today', '7d', '30d', 'all'];
export const isUsagePeriod = (v: unknown): v is UsagePeriod => typeof v === 'string' && (USAGE_PERIODS as readonly string[]).includes(v);

/** Overhead: what working through Agent canvas adds. Work: the sessions doing project work. */
export type UsageGroup = 'overhead' | 'work';
/** agent: the canvas agent's chats; orchestrator: one project's orchestrator chat; internal:
    other model calls the app makes on its own; work: every other session, by provider. */
export type UsageKind = 'agent' | 'orchestrator' | 'internal' | 'work';
/** How a row is paid for: a subscription's plan usage, or money on an API key. */
export type UsageBilling = 'plan' | 'api' | 'mixed';

export interface UsageTotals {
  /** Prompts answered (a turn may make many model calls). */
  turns: number;
  /** Uncached input. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Estimated USD at API prices. */
  cost: number;
  /** Tokens of models the price table does not know: counted, but not in `cost`. */
  unpriced: number;
}

export interface UsageRow extends UsageTotals {
  id: string;
  group: UsageGroup;
  kind: UsageKind;
  label: string;
  /** The project folder (orchestrator), or the provider (work). */
  detail: string | null;
  billing: UsageBilling;
  /** Share of the period's estimated cost, 0–1. */
  share: number;
}

/** One local day's estimated cost, split. `day`: YYYY-MM-DD in local time. */
export interface UsageDay { day: string; overhead: number; work: number }

export interface UsageTurn {
  /** The card id of the chat, for opening it. */
  session: string;
  kind: UsageKind;
  label: string;
  at: number;
  tokens: number;
  cost: number;
}

export interface UsageSummary {
  period: UsagePeriod;
  /** Start of the period (ms), or null for all of history. */
  from: number | null;
  to: number;
  overhead: UsageTotals;
  work: UsageTotals;
  /** Overhead's share of the period's estimated cost, 0–1 (0 when nothing was used). */
  share: number;
  rows: UsageRow[];
  days: UsageDay[];
  /** What one entry of `days` covers: a day, or a week (from Monday) for a long period. */
  dayUnit: 'day' | 'week';
  /** The costliest overhead turns of the period, costliest first. */
  top: UsageTurn[];
  /** When the per-model prices were last checked against the providers' pricing pages. */
  pricesChecked: string;
  /** The first usage on record (ms), or null when there is none. */
  since: number | null;
  /** The first read of the transcripts has not finished: totals are still growing. */
  backfilling: boolean;
}

export const emptyTotals = (): UsageTotals => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 });
export const totalTokens = (t: Pick<UsageTotals, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): number =>
  t.input + t.output + t.cacheRead + t.cacheWrite;

/** 950, 12K, 4.2M, 13B. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}K`;
  return Math.round(n).toLocaleString('en-US');
}

/** Estimated dollars: $0, <$0.01, $3.46, $1,235. */
export function usd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`;
}

/** A share as a percentage: 0%, <0.1%, 4.6%, 31%. */
export const percent = (share: number): string =>
  share === 0 ? '0%' : share < 0.001 ? '<0.1%' : `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
