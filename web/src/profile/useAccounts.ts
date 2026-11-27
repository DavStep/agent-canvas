// Both accounts for the avatar and the profile page: read once when the page loads, again on
// Refresh and whenever the profile page opens, and after a rate limit event while it is open.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountsView } from '../../../shared/account.ts';
import { profileBridge } from '../bridge.ts';
import { errorText } from '../preview/BrowserTab.tsx';

export interface Accounts {
  accounts: AccountsView | null;
  loading: boolean;
  error: string | null;
  /** When the accounts shown were read (for the reset times' "now"). */
  readAt: number | null;
  refresh(): void;
}

export function useAccounts(profileOpen: boolean): Accounts {
  const [accounts, setAccounts] = useState<AccountsView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  // One read at a time; a refresh asked for meanwhile runs once the current one is back.
  const inFlight = useRef(false);
  const again = useRef(false);

  const refresh = useCallback(() => {
    if (inFlight.current) { again.current = true; return; }
    inFlight.current = true;
    setLoading(true);
    profileBridge.accounts().then(
      (a) => { setAccounts(a); setError(null); setReadAt(Date.now()); },
      (err: unknown) => setError(errorText(err)),
    ).finally(() => {
      inFlight.current = false;
      setLoading(false);
      if (again.current) { again.current = false; refresh(); }
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!profileOpen) return;
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [profileOpen, refresh]);
  useEffect(() => (profileOpen ? profileBridge.onChanged(refresh) : undefined), [profileOpen, refresh]);

  return { accounts, loading, error, readAt, refresh };
}
