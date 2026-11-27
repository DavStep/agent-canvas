// A usage summary as the canvas agent's get_usage_summary answers it: a few plain lines.
import { compact, percent, totalTokens, usd, type UsageSummary, type UsageTotals } from '../../shared/usage.ts';

const PERIOD: Record<UsageSummary['period'], string> = { today: 'today', '7d': 'in the last 7 days', '30d': 'in the last 30 days', all: 'in all recorded history' };

const tokens = (t: UsageTotals) =>
  `${compact(totalTokens(t))} tokens (${compact(t.input)} input, ${compact(t.output)} output, ${compact(t.cacheRead)} cache read, ${compact(t.cacheWrite)} cache write)`;

export function usageReport(s: UsageSummary): string {
  const lines = [
    `Agent canvas overhead ${PERIOD[s.period]}: ${compact(totalTokens(s.overhead))} tokens, about ${usd(s.overhead.cost)}, ${percent(s.share)} of all estimated usage.`,
    `Work sessions: ${compact(totalTokens(s.work))} tokens, about ${usd(s.work.cost)}.`,
    '',
    ...s.rows.map(r => `- ${r.label}${r.detail && r.kind !== 'orchestrator' ? ` (${r.detail})` : ''}: ${r.turns} turns, ${tokens(r)}, about ${usd(r.cost)} (${percent(r.share)}), paid by ${r.billing === 'api' ? 'API key' : 'plan'}.`),
  ];
  if (s.rows.length === 0) lines.push('No usage recorded in this period.');
  if (s.top.length > 0) lines.push('', 'Costliest overhead turns:', ...s.top.map(t => `- ${t.label}, ${new Date(t.at).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${compact(t.tokens)} tokens, about ${usd(t.cost)} (chat ${t.session})`));
  lines.push('', `Costs are estimates at API prices checked ${s.pricesChecked}; on a subscription they stand for a share of plan usage, not money.`);
  if (s.backfilling) lines.push('History is still being read from the transcripts, so these totals are still growing.');
  return lines.join('\n');
}
