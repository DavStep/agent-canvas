// The end of an interrupted session's thread: what cut its turn off (a usage limit, an error, its
// process ending), with Continue and Abort. Enter on the banner itself continues and Esc aborts,
// as on a permission card; while a usage limit has not reset, Continue waits with a countdown.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SessionInterruption } from '../../../shared/types.ts';
import { countdown, interruptionHeadline, limitPending, limitReady, resetClock } from '../../../shared/interruption.ts';
import { useLiveNow } from './useLiveNow.ts';

/** What a key does on the banner. `onBanner`: the banner itself has focus; `within`: it or a control in it. */
export function bannerKey(e: { key: string; onBanner: boolean; within: boolean; modifiers: boolean }): 'continue' | 'abort' | null {
  if (e.modifiers) return null;
  if (e.key === 'Enter' && e.onBanner) return 'continue';
  if (e.key === 'Escape' && e.within) return 'abort';
  return null;
}

export interface InterruptionBannerProps {
  interruption: SessionInterruption;
  now: number;
  /** Why Continue cannot send now (the session is read-only here, the provider is signed out…), or null. */
  blocked: string | null;
  onContinue(): Promise<void>;
  onAbort(): Promise<void> | void;
}

export function InterruptionBanner({ interruption: i, now: appNow, blocked, onContinue, onAbort }: InterruptionBannerProps) {
  // Counts down by the second while a limit holds, and turns to "Limit reset" on time.
  const now = useLiveNow(appNow, limitPending(i, appNow) ? i.resetsAt : null);
  const ready = limitReady(i, now);
  const box = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = limitPending(i, now);
  const canContinue = !busy && !waiting && blocked === null;

  // It takes focus as a permission card does, unless the owner is busy elsewhere.
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) box.current?.focus({ preventScroll: true });
  }, [i.at]);

  const run = (act: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    Promise.resolve().then(act).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    }).finally(() => setBusy(false));
  };
  const continueTurn = () => { if (canContinue) run(onContinue); };
  const abort = () => run(onAbort);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const act = bannerKey({ key: e.key, onBanner: e.target === e.currentTarget, within: true, modifiers: e.metaKey || e.ctrlKey || e.altKey || e.shiftKey });
    if (act === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (act === 'continue') continueTurn();
    else abort();
  };

  const continueTip = waiting ? `The limit resets at ${resetClock(i.resetsAt!, now)}` : blocked ?? 'Resume the session and finish the interrupted turn';
  return (
    <div ref={box} className={`cs-banner is-interrupted${ready ? ' is-reset' : ''}`} role="group" aria-label="Interrupted turn" tabIndex={0} onKeyDown={onKeyDown}
      data-kind={i.kind}>
      {ready ? <i className="ready-dot" aria-hidden="true" /> : <i className="alert-dot" aria-hidden="true">!</i>}
      <span className="cs-interrupt-text">
        <b>{interruptionHeadline(i, now)}</b>
        <span className="note" title={i.reason}>{i.reason}</span>
        {error !== null && <span className="cs-interrupt-error" role="alert">{error}</span>}
      </span>
      <span className="cs-interrupt-actions">
        <button type="button" className="t-btn ghost" disabled={busy} onClick={abort} title="Dismiss: the session becomes a normal idle one">Abort</button>
        <button type="button" className="t-btn continue" disabled={!canContinue} onClick={continueTurn} title={continueTip}>
          {waiting ? `Continue in ${countdown(i.resetsAt!, now)}` : 'Continue'}
        </button>
        <span className="t-ask-keys" aria-hidden="true"><kbd>↵</kbd><span>continue</span><kbd>esc</kbd><span>abort</span></span>
      </span>
    </div>
  );
}
