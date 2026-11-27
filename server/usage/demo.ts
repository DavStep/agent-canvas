// The demo's usage: a made-up fortnight of canvas agent, orchestrator and work turns, so Settings →
// Usage has something to show without reading any real transcript.
import type { UsagePeriod, UsageSummary } from '../../shared/usage.ts';
import type { UsageProvider } from './parse.ts';
import { summarize, type UsageBucket } from './summary.ts';

const DAY = 86_400_000;

function bucket(provider: UsageProvider, session: string, cwd: string, model: string, turn: string, at: number, scale: number): UsageBucket {
  return {
    provider, session, cwd, model, turn, long: false, at, last: at + 60_000,
    input: Math.round(40 * scale), output: Math.round(3_000 * scale), cacheRead: Math.round(400_000 * scale),
    cacheWrite: Math.round(30_000 * scale), cacheWrite1h: Math.round(30_000 * scale), calls: Math.max(1, Math.round(6 * scale)),
  };
}

export function demoUsageSummary(period: UsagePeriod, now: number, agentCwd: string): UsageSummary {
  const buckets: UsageBucket[] = [];
  const roles = {
    'demo-orch-web': { folder: '/Users/demo/code/storefront', connection: 'claude-login' as const },
    'demo-orch-api': { folder: '/Users/demo/code/billing-api', connection: 'claude-login' as const },
  };
  for (let d = 13; d >= 0; d--) {
    const day = now - d * DAY;
    const busy = 0.6 + ((d * 7) % 5) / 4;
    for (let t = 0; t < 3; t++) buckets.push(bucket('claude', 'demo-agent', agentCwd, 'claude-opus-5-5', `a${d}-${t}`, day - t * 3_600_000, 0.5 * busy));
    buckets.push(bucket('claude', 'demo-orch-web', '/Users/demo/code/storefront', 'claude-opus-5-5', `w${d}`, day - 1_800_000, 0.7 * busy));
    if (d % 2 === 0) buckets.push(bucket('claude', 'demo-orch-api', '/Users/demo/code/billing-api', 'claude-opus-5-5', `p${d}`, day - 5_400_000, 0.6 * busy));
    for (let t = 0; t < 6; t++) buckets.push(bucket('claude', `demo-work-${t}`, '/Users/demo/code/storefront', 'claude-opus-5-5', `c${d}-${t}`, day - t * 2_400_000, 3 * busy));
    for (let t = 0; t < 3; t++) buckets.push(bucket('codex', `codex:demo-${t}`, '/Users/demo/code/billing-api', 'gpt-6.2-sol', `x${d}-${t}`, day - t * 4_000_000, 4 * busy));
  }
  return summarize(buckets, { period, now, agentCwd, roles });
}
