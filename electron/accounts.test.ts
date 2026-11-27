import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccount } from '../shared/account.ts';
import { gatherAccounts } from './accounts.ts';

const signedIn = (provider: 'claude' | 'codex'): ProviderAccount =>
  ({ provider, signedIn: true, email: `${provider}@example.com`, plan: 'pro', windows: [{ label: '5 h', usedPercent: 10, resetsAt: null }], note: null });

afterEach(() => { vi.useRealTimers(); });

describe('gatherAccounts', () => {
  it("asks both engines at once and returns each provider's account", async () => {
    const claude = vi.fn(async () => signedIn('claude'));
    const codex = vi.fn(async () => signedIn('codex'));
    await expect(gatherAccounts({ claude: { account: claude }, codex: { account: codex } })).resolves.toEqual({
      claude: signedIn('claude'), codex: signedIn('codex'),
    });
    expect(claude).toHaveBeenCalledTimes(1);
    expect(codex).toHaveBeenCalledTimes(1);
  });

  it('one engine throwing gives that panel a signed-out note; the other still shows', async () => {
    const view = await gatherAccounts({
      claude: { account: async () => { throw new Error('spawn claude ENOENT'); } },
      codex: { account: async () => signedIn('codex') },
    });
    expect(view.claude).toEqual({ provider: 'claude', signedIn: false, email: null, plan: null, windows: [], note: 'Could not read the account: spawn claude ENOENT' });
    expect(view.codex).toEqual(signedIn('codex'));
  });

  it('an engine that does not answer within the time limit is cut off; the call never rejects', async () => {
    vi.useFakeTimers();
    const pending = gatherAccounts({
      claude: { account: async () => signedIn('claude') },
      codex: { account: () => new Promise<ProviderAccount>(() => {}) },
    }, 10_000);
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const view = await pending;
    expect(view.claude).toEqual(signedIn('claude'));
    expect(view.codex).toEqual({ provider: 'codex', signedIn: false, email: null, plan: null, windows: [], note: 'Codex did not answer within 10 s' });
  });

  it('a malformed answer is replaced too, so the page always gets the right provider', async () => {
    const view = await gatherAccounts({
      claude: { account: async () => signedIn('codex') },
      codex: { account: async () => null as unknown as ProviderAccount },
    });
    expect(view.claude).toMatchObject({ provider: 'claude', signedIn: true });
    expect(view.codex).toMatchObject({ provider: 'codex', signedIn: false, note: 'Could not read the account: no answer' });
  });
});
