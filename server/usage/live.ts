// Usage of an internal model call that leaves no transcript (persistSession: false, such as the
// open-threads judge), from the Agent SDK's result message, for UsageStore.record(). A caller does:
//
//   if (message.type === 'result') for (const d of internalUsage(message, 'Open threads')) usage.record(d);
//
// modelUsage covers every call the query made (auxiliary ones too), per model; it is cumulative
// over one query(), so a one-shot query's single result is read once.
import type { UsageDelta } from './parse.ts';

interface ModelUsageLike {
  inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number;
  cacheCreationEphemeral1hInputTokens?: number;
}
export interface SdkResultLike { session_id?: string; modelUsage?: Record<string, ModelUsageLike> }

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** One delta per model the query used, as overhead under `label` (a row of its own in Settings → Usage). */
export function internalUsage(result: SdkResultLike, label: string, at = Date.now()): UsageDelta[] {
  const turn = `${label}:${result.session_id ?? at}`;
  return Object.entries(result.modelUsage ?? {}).flatMap(([model, u]) => {
    const d: UsageDelta = {
      provider: 'claude', session: `internal:${label}`, cwd: '', model, turn, at, long: false,
      input: n(u.inputTokens), output: n(u.outputTokens), cacheRead: n(u.cacheReadInputTokens), cacheWrite: n(u.cacheCreationInputTokens),
      cacheWrite1h: Math.min(n(u.cacheCreationEphemeral1hInputTokens), n(u.cacheCreationInputTokens)), calls: 1, kind: 'internal', label,
    };
    return d.input + d.output + d.cacheRead + d.cacheWrite > 0 ? [d] : [];
  });
}
