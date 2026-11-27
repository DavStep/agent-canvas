// What the profile page shows for each provider's account.
import type { Provider } from './chat.ts';

export interface UsageWindow { label: string; usedPercent: number | null; resetsAt: number | null }
export interface ProviderAccount {
  provider: Provider; signedIn: boolean; email: string | null; plan: string | null;
  /** Manual usage resets remaining, when the provider reports a count. */
  availableResets?: number;
  windows: UsageWindow[]; note: string | null;   // e.g. "Log in with `claude` then /login"
}
export interface AccountsView { claude: ProviderAccount; codex: ProviderAccount }
