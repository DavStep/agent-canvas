// The profile page's accounts: both engines asked at once, each on its own, so one provider that
// fails or hangs never hides the other.
import type { AccountsView, ProviderAccount } from '../shared/account.ts';
import type { Provider } from '../shared/chat.ts';
import type { Engine } from '../server/engines/engine.ts';

export const ACCOUNTS_TIMEOUT_MS = 10_000;
const NAME: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };

const signedOut = (provider: Provider, note: string): ProviderAccount =>
  ({ provider, signedIn: false, email: null, plan: null, windows: [], note });

/** One provider's account, or a signed-out panel saying why there is none. Never rejects. */
async function one(provider: Provider, engine: Pick<Engine, 'account'>, timeoutMs: number): Promise<ProviderAccount> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), timeoutMs);
    timer.unref?.();
  });
  try {
    const answer = await Promise.race([engine.account(), late]);
    if (answer === 'late') return signedOut(provider, `${NAME[provider]} did not answer within ${Math.round(timeoutMs / 1000)} s`);
    if (typeof answer !== 'object' || answer === null) return signedOut(provider, 'Could not read the account: no answer');
    return { ...answer, provider };
  } catch (err) {
    return signedOut(provider, `Could not read the account: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function gatherAccounts(engines: Record<Provider, Pick<Engine, 'account'>>, timeoutMs = ACCOUNTS_TIMEOUT_MS): Promise<AccountsView> {
  const [claude, codex] = await Promise.all([one('claude', engines.claude, timeoutMs), one('codex', engines.codex, timeoutMs)]);
  return { claude, codex };
}
