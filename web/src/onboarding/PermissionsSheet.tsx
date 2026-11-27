import { useEffect, useRef, useState } from 'react';
import type { AccountsView } from '../../../shared/account.ts';
import type { PermissionsView } from '../../../shared/permissions.ts';
import { permissionsBridge } from '../bridge.ts';
import { useSettings } from '../settings.ts';
import { useClosing } from '../useClosing.ts';
import { buildRows, loadDismissal, missingIds, saveDismissal, shouldAutoOpen } from './onboarding.ts';

interface Props {
  accounts: AccountsView | null;
  open: boolean;
  blocked: boolean;
  setOpen(value: boolean): void;
}

export function PermissionsSheet({ accounts, open, blocked, setOpen }: Props) {
  const [permissions, setPermissions] = useState<PermissionsView | null>(null);
  const agents = useSettings()?.acpAgents ?? null;
  const [dismissal, setDismissal] = useState(() => loadDismissal());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);

  useEffect(() => {
    const refresh = () => {
      const id = ++generation.current;
      permissionsBridge.read().then(value => {
        if (generation.current === id) { setPermissions(value); setError(''); }
      }, () => { if (generation.current === id) setError('Could not check notification settings.'); });
    };
    refresh();
    if (open) window.addEventListener('focus', refresh);
    return () => { generation.current++; window.removeEventListener('focus', refresh); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, [open]);

  useEffect(() => {
    if (!blocked && !open && shouldAutoOpen(buildRows(permissions, accounts, agents), dismissal)) setOpen(true);
  }, [permissions, accounts, agents, dismissal, blocked, open, setOpen]);

  if (!open) return null;
  const rows = buildRows(permissions, accounts, agents);
  const dismiss = (never: boolean) => {
    const value = { never: never || dismissal.never, skipped: missingIds(rows) };
    saveDismissal(value);
    setDismissal(value);
    setOpen(false);
  };
  const allow = async () => {
    setBusy(true);
    try {
      const value = await permissionsBridge.ask('notifications');
      generation.current++;
      setPermissions(value);
      setError('');
    } catch { setError('Could not open notification settings. Try again.'); }
    finally { setBusy(false); }
  };
  return <SheetContent dialog={dialog} dismiss={dismiss} done={missingIds(rows).length === 0}>
    {rows.map(r => <div key={r.id} className="pf-setting permission-row">
      <div><strong className="pf-setting-name">{r.title}</strong>
        <span className="pf-quiet">{r.why}</span>
        {r.how && <span>{r.how.replaceAll('`', '')}</span>}
      </div>
      <div className="permission-status"><span>{r.status}</span>
        {r.action && <button type="button" className="t-btn outline" onClick={allow} disabled={busy}>{r.action.label}</button>}
      </div>
    </div>)}
    {error && <p role="alert" className="pf-error">{error}</p>}
    <p className="permission-help pf-quiet">macOS asks for folder access when you use a protected project folder. New sessions default to Auto, which lets your agent handle routine actions and ask when it needs approval.</p>
  </SheetContent>;
}

function SheetContent({ dialog, children, dismiss, done }: {
  dialog: React.RefObject<HTMLDialogElement | null>; children: React.ReactNode; dismiss(never: boolean): void; done: boolean;
}) {
  const never = useRef(false);
  const { closing, close } = useClosing(() => dismiss(never.current));
  return <dialog ref={dialog} className={`pf${closing ? ' is-closing' : ''}`} aria-labelledby="permissions-title"
    onCancel={e => { e.preventDefault(); close(); }}>
    <div className="pf-sheet permission-sheet">
      <header className="pf-head"><h2 id="permissions-title">Permissions and agent setup</h2></header>
      {children}
      <footer className="ns-foot">
        <button type="button" className="t-btn" onClick={() => { never.current = true; close(); }}>Don’t show again</button>
        <button type="button" className="t-btn outline" onClick={close}>{done ? 'Done' : 'Skip for now'}</button>
      </footer>
    </div>
  </dialog>;
}
