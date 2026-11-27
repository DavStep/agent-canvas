import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountsView, ProviderAccount } from '../../../shared/account.ts';
import { avatarInitial, barPercent, planLabel, resetLabel, usageLine } from './format.ts';

// Local time is the owner's; the tests pin it so the labels are the same on every machine.
beforeAll(() => { vi.stubEnv('TZ', 'Europe/Berlin'); });
afterAll(() => { vi.unstubAllEnvs(); });

const DAY = 86_400_000;
/** Monday 23 November 2026, 14:00 in Berlin (13:00 UTC). */
const NOW = Date.UTC(2026, 10, 23, 13, 0);

describe('usageLine', () => {
  it('usedPercent 10, resets in 3 days → "10% used · resets Thu 14:00"', () => {
    expect(usageLine({ label: 'Weekly', usedPercent: 10, resetsAt: NOW + 3 * DAY }, NOW)).toBe('10% used · resets Thu 14:00');
  });

  it('a null usage value → "Not reported"', () => {
    expect(usageLine({ label: '5 h', usedPercent: null, resetsAt: NOW + DAY }, NOW)).toBe('Not reported');
    expect(usageLine({ label: '5 h', usedPercent: null, resetsAt: null }, NOW)).toBe('Not reported');
  });

  it('rounds the percentage and leaves out an unknown reset time', () => {
    expect(usageLine({ label: '5 h', usedPercent: 12.6, resetsAt: null }, NOW)).toBe('13% used');
  });

  it('says the time in local time, from a UTC instant', () => {
    // 21:30 UTC is 22:30 in Berlin.
    expect(resetLabel(Date.UTC(2026, 10, 23, 21, 30), NOW)).toBe('Mon 22:30');
    // After midnight Berlin time it is already Tuesday.
    expect(resetLabel(Date.UTC(2026, 10, 23, 23, 5), NOW)).toBe('Tue 00:05');
  });

  it('a reset a week or more away also names the date; one already past says "now"', () => {
    expect(resetLabel(NOW + 8 * DAY, NOW)).toBe('Tue 1 Dec 14:00');
    expect(resetLabel(NOW - 1000, NOW)).toBe('now');
  });
});

describe('planLabel', () => {
  it('pro → "Pro", max → "Max"', () => {
    expect(planLabel('pro')).toBe('Pro');
    expect(planLabel('max')).toBe('Max');
  });

  it('other plan names read as words; none stays none', () => {
    expect(planLabel('plus')).toBe('Plus');
    expect(planLabel('enterprise')).toBe('Enterprise');
    expect(planLabel('claude_team')).toBe('Claude team');
    expect(planLabel('API key')).toBe('API key');
    expect(planLabel(null)).toBeNull();
    expect(planLabel('')).toBeNull();
  });
});

describe('barPercent', () => {
  it('clamps to 0–100, and null draws an empty bar', () => {
    expect(barPercent(40)).toBe(40);
    expect(barPercent(140)).toBe(100);
    expect(barPercent(-5)).toBe(0);
    expect(barPercent(null)).toBe(0);
  });
});

describe('avatarInitial', () => {
  const account = (provider: 'claude' | 'codex', email: string | null): ProviderAccount =>
    ({ provider, signedIn: email !== null, email, plan: null, windows: [], note: null });
  const view = (claude: string | null, codex: string | null): AccountsView => ({ claude: account('claude', claude), codex: account('codex', codex) });

  it("the Claude email's initial, else Codex's, else none (a neutral glyph)", () => {
    expect(avatarInitial(view('dana@example.com', 'ops@example.com'))).toBe('D');
    expect(avatarInitial(view(null, 'ops@example.com'))).toBe('O');
    expect(avatarInitial(view(null, null))).toBeNull();
    expect(avatarInitial(view('', '  '))).toBeNull();
    expect(avatarInitial(null)).toBeNull();
  });
});
