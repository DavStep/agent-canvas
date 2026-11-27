// Per-model token prices, USD per million tokens, at the providers' standard API rates (global
// routing, no batch, no fast mode, no data-residency premium). The one place to update when prices
// change: edit a row, add a model, and move PRICES_CHECKED.
//
// Sources, checked 2026-11-27:
//   Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI:    https://developers.openai.com/api/docs/pricing (Standard tier, short context)
//
// These are estimates. On a Claude or ChatGPT subscription the app pays no per-token price: the
// figure then stands for the share of plan usage the tokens would cost at API rates.

export const PRICES_CHECKED = '2026-11-27';

export interface Price {
  input: number;
  output: number;
  /** Cache hits and refreshes. */
  cacheRead: number;
  /** A cache write at the provider's default lifetime (Anthropic 5 minutes, OpenAI 30 minutes). */
  cacheWrite: number;
  /** Anthropic's 1-hour cache write. */
  cacheWrite1h?: number;
  /** A model priced by prompt length: a call whose whole prompt (input, cache reads and writes)
      is over `above` tokens pays `prices` instead. */
  long?: { above: number; prices: Omit<Price, 'long'> };
}

const claude = (input: number, output: number, cacheRead: number): Price =>
  ({ input, output, cacheRead, cacheWrite: input * 1.25, cacheWrite1h: input * 2 });
const openai = (input: number, cacheRead: number, cacheWrite: number, output: number): Price =>
  ({ input, output, cacheRead, cacheWrite });

/** Keys are model ids without a date suffix; see priceFor. */
export const PRICES: Record<string, Price> = {
  // Anthropic
  'claude-fable-5-2': claude(8, 40, 0.20),
  'claude-mythos-5-2': claude(8, 40, 0.20),
  'claude-fable-5-1': claude(10, 50, 0.25),
  'claude-mythos-5-1': claude(10, 50, 0.25),
  'claude-fable-5': claude(10, 50, 1),
  'claude-mythos-5': claude(10, 50, 1),
  'claude-opus-5-5': claude(4, 20, 0.20),
  'claude-opus-5': claude(5, 25, 0.50),
  'claude-opus-4-8': claude(5, 25, 0.50),
  'claude-opus-4-7': claude(5, 25, 0.50),
  'claude-opus-4-6': claude(5, 25, 0.50),
  'claude-opus-4-5': claude(5, 25, 0.50),
  'claude-opus-4-1': claude(15, 75, 1.50),
  'claude-opus-4': claude(15, 75, 1.50),
  'claude-sonnet-5-5': claude(2, 10, 0.10),
  'claude-sonnet-5': claude(2, 10, 0.20),
  'claude-sonnet-4-6': claude(3, 15, 0.30),
  'claude-sonnet-4-5': claude(3, 15, 0.30),
  'claude-sonnet-4': claude(3, 15, 0.30),
  'claude-haiku-5-5': { ...claude(0.10, 0.50, 0.01), long: { above: 100_000, prices: claude(0.50, 2.50, 0.05) } },
  'claude-haiku-4-5': claude(1, 5, 0.10),
  // OpenAI (Codex). Prompts over 272K tokens cost more; Codex rarely sends them, and they are
  // counted here at the short-context rates.
  'gpt-6.2-astra': openai(8, 0.40, 10, 40),
  'gpt-6.2-sol': openai(2, 0.10, 2.50, 10),
  'gpt-6-astra': openai(10, 1, 12.50, 50),
  'gpt-6.1-sol': openai(2, 0.10, 2.50, 10),
  'gpt-6.1-terra': openai(1, 0.05, 1.25, 5),
  'gpt-6-luna': openai(0.10, 0.01, 0.125, 0.50),
  'gpt-6-sol': openai(2, 0.20, 2.50, 10),
};

/** A model id as the price table keys it: no date suffix (claude-haiku-4-5-20251001), no
    context tag (claude-opus-5-5[1m]), no provider prefix (anthropic.claude-…, openai/gpt-…). */
export function modelKey(model: string): string {
  return model.trim().toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^(?:anthropic\.|openai\/|us\.anthropic\.)/, '')
    .replace(/-\d{8}$/, '')
    .replace(/@\d{8}$/, '');
}

export function priceFor(model: string): Price | null {
  return PRICES[modelKey(model)] ?? null;
}

/** Whether a call with this whole prompt pays the model's long-prompt prices. */
export function isLong(model: string, prompt: number): boolean {
  const p = priceFor(model);
  return !!p?.long && prompt > p.long.above;
}

export interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number }

/** Estimated USD for these tokens of one model, or null for a model the table does not know.
    `long`: they were spent in calls over the model's long-prompt threshold. */
export function costOf(model: string, t: Tokens, long = false): number | null {
  const base = priceFor(model);
  if (!base) return null;
  const p = long && base.long ? base.long.prices : base;
  const hour = Math.min(t.cacheWrite1h ?? 0, t.cacheWrite);
  const usd = t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead
    + (t.cacheWrite - hour) * p.cacheWrite + hour * (p.cacheWrite1h ?? p.cacheWrite);
  return usd / 1_000_000;
}
