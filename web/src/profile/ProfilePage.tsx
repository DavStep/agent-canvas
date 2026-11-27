// The profile page: one panel per provider (email, plan, usage windows as bars in the zone hues,
// or how to sign in), Refresh, and the "Snap to grid" and "Open at login" switches. A native modal <dialog>, mounted
// only while open, so the browser preview hides under it.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { AccountsView, ProviderAccount } from '../../../shared/account.ts';
import type { Provider } from '../../../shared/chat.ts';
import { noteAppearances, type NoteAppearance } from '../notes/appearance.ts';
import { profileBridge } from '../bridge.ts';
import { setSnap, useSnap } from '../canvas/snap.ts';
import { FOLD_CHOICES, setSlotSettings, useSlotSettings } from '../canvas/slotSettings.ts';
import { hueToken } from '../components/ZoneMark.tsx';
import { errorText } from '../preview/BrowserTab.tsx';
import { avatarInitial, barPercent, planLabel, usageLine } from './format.ts';
import { AcpSettings } from './AcpSettings.tsx';
import { AgentSettings } from './AgentSettings.tsx';
import { ModelSettings } from './ModelSettings.tsx';
import { UsageSettings } from './UsageSettings.tsx';
import type { Accounts } from './useAccounts.ts';
import { useClosing } from '../useClosing.ts';

const NAME: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };
/** How to sign in with the provider's own tool; the app never handles a login. */
export const SIGN_IN: Record<Provider, string> = { claude: 'Run `claude`, then `/login`', codex: 'Run `codex login`' };

/** Text with `code` spans, as the engines write their notes. */
function withCode(text: string): ReactNode[] {
  return text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

/** The circle in the top bar: the account's initial, or a neutral person glyph. */
export function Avatar({ accounts, onOpen }: { accounts: AccountsView | null; onOpen(): void }) {
  const initial = avatarInitial(accounts);
  return (
    <button type="button" className="avatar" aria-label="Profile and usage" title="Profile and usage" onClick={onOpen}>
      <span>
        {initial ?? (
          <svg className="i" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="5" r="2.5" /><path d="M2.5 12.5c.6-2.3 2.4-3.5 4.5-3.5s3.9 1.2 4.5 3.5" /></svg>
        )}
      </span>
      <svg className="i" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5l3-3" /></svg>
    </button>
  );
}

function Panel({ account, now }: { account: ProviderAccount; now: number }) {
  const plan = planLabel(account.plan);
  const name = NAME[account.provider];
  const signIn = SIGN_IN[account.provider];
  // The engines' signed-out notes usually say how already; otherwise the instructions follow.
  const saysHow = account.note !== null && account.note.replace(/`/g, '').includes(signIn.replace(/`/g, '').replace(/^Run /, ''));
  return (
    <section className={`pf-panel is-${account.provider}${account.signedIn ? '' : ' is-out'}`} aria-label={name}>
      <header className="pf-panel-head">
        <i className="pf-mark" aria-hidden="true" />
        <h3>{name}</h3>
        {account.signedIn ? (plan !== null && <span className="pf-plan">{plan}</span>) : <span className="pf-plan is-out">Signed out</span>}
      </header>
      {account.signedIn ? (<>
        <p className="pf-email">{account.email ?? 'No email reported'}</p>
        {account.windows.length > 0 ? (
          <ul className="pf-windows" aria-label={`${name} usage`}>
            {account.windows.map((w, i) => (
              <li key={`${w.label}-${i}`} className="pf-window" style={{ '--bar-hue': `var(${hueToken(i)})` } as CSSProperties}>
                <div className="pf-window-row">
                  <span className="pf-window-label">{w.label}</span>
                  <span className={`pf-window-text${w.usedPercent === null ? ' is-quiet' : ''}`}>{usageLine(w, now)}</span>
                </div>
                <div className="pf-bar" role="meter" aria-label={`${w.label} used`} aria-valuemin={0} aria-valuemax={100}
                  aria-valuenow={w.usedPercent === null ? undefined : Math.round(barPercent(w.usedPercent))}
                  aria-valuetext={usageLine(w, now)}>
                  <i style={{ width: `${barPercent(w.usedPercent)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="pf-quiet">Usage not reported</p>}
        {account.provider === 'codex' && <div className="pf-window-row">
          <span className="pf-window-label">Available resets</span>
          <span className="pf-window-text">{account.availableResets ?? 'Not reported'}</span>
        </div>}
        {account.note !== null && <p className="pf-quiet">{withCode(account.note)}</p>}
      </>) : (<>
        {account.note !== null && <p className="pf-note">{withCode(account.note)}</p>}
        {!saysHow && <p className="pf-how">{withCode(`${signIn} in a terminal.`)}</p>}
      </>)}
    </section>
  );
}

function LoginSwitch() {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    profileBridge.getSettings().then((s) => setOn(s.openAtLogin), (err: unknown) => setError(errorText(err)));
  }, []);
  const toggle = () => {
    if (on === null) return;
    const next = !on;
    setOn(next);
    setError(null);
    profileBridge.setSettings({ openAtLogin: next })
      .then(() => profileBridge.getSettings())
      .then((s) => setOn(s.openAtLogin), (err: unknown) => { setOn(!next); setError(errorText(err)); });
  };
  return (
    <div className="pf-setting">
      <div>
        <span className="pf-setting-name" id="pf-login">Open at login</span>
        <span className="pf-quiet">{error ?? 'Start Agent canvas when you log in to this Mac.'}</span>
      </div>
      <button type="button" role="switch" className={`pf-switch${on ? ' is-on' : ''}`} aria-checked={on ?? false} aria-labelledby="pf-login"
        disabled={on === null} onClick={toggle}>
        <i />
      </button>
    </div>
  );
}

/** "When a limit resets": Ask (the default: a notification, Continue in each chat), or continue
    the sessions it cut off, as many at a time as each project's max running allows. */
function LimitResetSetting() {
  const [choice, setChoice] = useState<'ask' | 'continue' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    profileBridge.getSettings().then((s) => setChoice(s.limitReset ?? 'ask'), (err: unknown) => setError(errorText(err)));
  }, []);
  const choose = (next: 'ask' | 'continue') => {
    const before = choice;
    setChoice(next);
    setError(null);
    profileBridge.setSettings({ limitReset: next })
      .then(() => profileBridge.getSettings())
      .then((s) => setChoice(s.limitReset ?? 'ask'), (err: unknown) => { setChoice(before); setError(errorText(err)); });
  };
  return (
    <div className="pf-setting">
      <div>
        <span className="pf-setting-name" id="pf-limit-reset">When a limit resets</span>
        <span className="pf-quiet">{error ?? 'Sessions a usage limit cut off: ask in each chat, or continue them automatically, up to each project’s max running at a time.'}</span>
      </div>
      <select className="pf-select" aria-labelledby="pf-limit-reset" data-testid="limit-reset" value={choice ?? 'ask'} disabled={choice === null}
        onChange={(e) => choose(e.target.value === 'continue' ? 'continue' : 'ask')}>
        <option value="ask">Ask</option>
        <option value="continue">Continue cut-off sessions automatically</option>
      </select>
    </div>
  );
}

function SnapSwitch() {
  const on = useSnap();
  return (
    <div className="pf-setting">
      <div>
        <span className="pf-setting-name" id="pf-snap">Snap to grid</span>
        <span className="pf-quiet">Dragged zones move in grid steps, their corner between four dots.</span>
      </div>
      <button type="button" role="switch" className={`pf-switch${on ? ' is-on' : ''}`} aria-checked={on} aria-labelledby="pf-snap"
        onClick={() => setSnap(!on)}>
        <i />
      </button>
    </div>
  );
}

const foldLabel = (h: number | null): string => h === null ? 'Never' : h < 48 ? `After ${h} hours` : `After ${h / 24} days`;

/** How the canvas keeps its cards: they never re-sort while the owner looks (web/src/canvas/cardSlots.ts). */
function CardOrderSettings() {
  const { autoTidy, foldAfterHours } = useSlotSettings();
  const choices = FOLD_CHOICES.includes(foldAfterHours) ? FOLD_CHOICES : [...FOLD_CHOICES, foldAfterHours];
  return (<>
    <div className="pf-setting">
      <div>
        <span className="pf-setting-name" id="pf-autotidy">Tidy zones while away</span>
        <span className="pf-quiet">While the window is in the background, order each zone’s cards by recent activity. Cards never move while you look.</span>
      </div>
      <button type="button" role="switch" className={`pf-switch${autoTidy ? ' is-on' : ''}`} aria-checked={autoTidy} aria-labelledby="pf-autotidy"
        onClick={() => setSlotSettings({ autoTidy: !autoTidy })}>
        <i />
      </button>
    </div>
    <div className="pf-setting">
      <div>
        <span className="pf-setting-name" id="pf-fold">Fold idle sessions into Earlier</span>
        <span className="pf-quiet">Idle sessions untouched this long fold at the end of their zone, on start or while you are away.</span>
      </div>
      <select className="pf-select" aria-labelledby="pf-fold" value={foldAfterHours === null ? '' : String(foldAfterHours)}
        onChange={(e) => setSlotSettings({ foldAfterHours: e.target.value === '' ? null : Number(e.target.value) })}>
        {choices.map((h) => <option key={h ?? 'never'} value={h === null ? '' : String(h)}>{foldLabel(h)}</option>)}
      </select>
    </div>
  </>);
}

export interface ProfilePageProps {
  onPermissions(): void;
  data: Accounts;
  noteAppearance: NoteAppearance;
  onNoteAppearanceChange(value: NoteAppearance): void;
  onClose(): void;
  /** Usage's costliest turns: whether a chat is a card, and opening it (the page closes first). */
  canOpenChat?(sessionId: string): boolean;
  onOpenChat?(sessionId: string): void;
}

export function ProfilePage({ onPermissions, data, noteAppearance, onNoteAppearanceChange, onClose: onClosed, canOpenChat, onOpenChat }: ProfilePageProps) {
  const { closing, close: onClose } = useClosing(onClosed);
  const dialog = useRef<HTMLDialogElement>(null);
  const { accounts, loading, error, readAt, refresh } = data;
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);
  const now = readAt ?? Date.now();
  const initial = avatarInitial(accounts);
  const email = accounts?.claude.email ?? accounts?.codex.email ?? null;

  return (
    <dialog
      ref={dialog}
      className={`pf${closing ? ' is-closing' : ''}`}
      aria-labelledby="pf-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="pf-sheet">
        <header className="pf-head">
          <span className="pf-avatar" aria-hidden="true">{initial ?? '·'}</span>
          <div className="pf-who">
            <h2 id="pf-title">Profile</h2>
            <span className="pf-quiet">{email ?? 'Accounts and plan usage'}</span>
          </div>
          <button type="button" className="t-btn outline pf-refresh" onClick={refresh} disabled={loading}>
            <svg className={`i${loading ? ' is-spinning' : ''}`} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.9h-2.9" /></svg>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
          </button>
        </header>
        {error !== null && <p className="pf-error" role="alert">Could not read the accounts: {error}</p>}
        <div className="pf-panels">
          {accounts ? (<>
            <Panel account={accounts.claude} now={now} />
            <Panel account={accounts.codex} now={now} />
          </>) : <p className="pf-quiet">{loading ? 'Reading the accounts…' : 'No accounts read yet.'}</p>}
        </div>
        <div className="pf-setting"><div><span className="pf-setting-name">Permissions</span><span className="pf-quiet">Notification access and agent setup</span></div>
          <button type="button" className="t-btn outline" onClick={onPermissions}>Review permissions</button>
        </div>
        <UsageSettings canOpen={canOpenChat} onOpenChat={onOpenChat && ((id) => { onClose(); onOpenChat(id); })} />
        <AgentSettings />
        <AcpSettings />
        <ModelSettings />
        <div className="pf-setting pf-appearance">
          <div>
            <span className="pf-setting-name" id="pf-appearance">Note appearance</span>
            <span className="pf-quiet" id="pf-appearance-help">Applies to board notes and open threads.</span>
          </div>
          <span className="ns-seg" role="radiogroup" aria-labelledby="pf-appearance" aria-describedby="pf-appearance-help">
            {(Object.keys(noteAppearances) as NoteAppearance[]).map((value) => (
              <label key={value} className={`ns-seg-btn${value === noteAppearance ? ' is-on' : ''}`}>
                <input type="radio" name="note-appearance" value={value} checked={noteAppearance === value}
                  onChange={() => onNoteAppearanceChange(value)} />
                {noteAppearances[value]}
              </label>
            ))}
          </span>
        </div>
        <SnapSwitch />
        <CardOrderSettings />
        <LoginSwitch />
        <LimitResetSetting />
      </div>
    </dialog>
  );
}
