// "Run after…": which sessions a card waits for, and the prompt it sends when they have finished.
// Opened by dropping a link from one card's port onto another, or from a card's menu. A native
// modal <dialog> in the New session dialog's shape (overlays.css), so it enters and leaves alike.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { RunMode, RunView } from '../../../shared/runs.ts';
import type { SessionView } from '../../../shared/types.ts';
import { runOp } from '../bridge.ts';
import { titleOf } from '../briefing.ts';
import { useClosing } from '../useClosing.ts';

export interface LinkDialogProps {
  /** The card that waits (a session, or a planned session's card). */
  to: string;
  /** Sessions it waits for to begin with (a dropped link: the card it came from). */
  from: string[];
  /** The run already queued for `to`, if any: its waits and prompt are edited. */
  run: RunView | null;
  /** The sessions that may be waited for. */
  sessions: SessionView[];
  nameOf(id: string): string;
  onClose(): void;
}

const errorText = (err: unknown): string => {
  const text = err instanceof Error ? err.message : String(err);
  // Electron prefixes a rejected handler's message with where it came from.
  return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
};

export function LinkDialog({ to, from, run, sessions, nameOf, onClose }: LinkDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const exit = useClosing(onClose);
  const close = exit.close;
  const initial = useMemo(() => [...new Set([...(run?.edges.map((e) => e.from) ?? []), ...from])], []);
  const [chosen, setChosen] = useState<string[]>(initial);
  const [text, setText] = useState(run?.prompt ?? '');
  const [mode, setMode] = useState<RunMode>(run?.mode ?? 'all');
  const [handOff, setHandOff] = useState(run?.handOff ?? false);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    (from.length > 0 || initial.length > 0 ? prompt.current : dialog.current?.querySelector<HTMLInputElement>('.lk-filter'))?.focus();
  }, []);

  const toName = nameOf(to);
  const q = filter.trim().toLowerCase();
  const choices = sessions
    .filter((s) => s.id !== to && (chosen.includes(s.id) || q === '' || titleOf(s).toLowerCase().includes(q) || s.folder.toLowerCase().includes(q)))
    .sort((a, b) => Number(chosen.includes(b.id)) - Number(chosen.includes(a.id)) || b.stateSince - a.stateSince)
    .slice(0, 40);
  // A planned session waited for stays listed even though it is no card's session yet.
  const plannedChosen = chosen.filter((id) => !sessions.some((s) => s.id === id));
  const ready = chosen.length > 0 && text.trim() !== '' && !saving;

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError(null);
    const extras = { prompt: text, mode: chosen.length > 1 ? mode : 'all' as RunMode, handOff };
    try {
      const before = run?.edges.map((x) => x.from) ?? [];
      const added = chosen.filter((id) => !before.includes(id));
      if (!run || added.length > 0) await runOp({ type: 'link', from: added.length > 0 ? added : chosen, to, ...extras });
      else await runOp({ type: 'editRun', id: run.id, ...extras });
      for (const gone of before.filter((id) => !chosen.includes(id))) await runOp({ type: 'unlink', from: gone, to });
      close();
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  };

  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  return (
    <dialog
      ref={dialog}
      className={`ns lk${exit.closing ? ' is-closing' : ''}`}
      aria-labelledby="lk-title"
      onCancel={(e) => { e.preventDefault(); close(); }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <form className="ns-panel lk-panel" onSubmit={save}>
        <header className="ns-head">
          <h2 id="lk-title">Run “{toName}” after…</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
          </button>
        </header>
        <p className="lk-note">When {chosen.length > 1 ? (mode === 'any' ? 'the first of these finishes' : 'all of these finish') : 'this finishes'} its turn, the prompt below is sent to “{toName}” by itself. If one is interrupted, it waits and shows blocked.</p>

        <fieldset className="lk-sessions">
          <legend>Waits for</legend>
          <input className="lk-filter" type="search" placeholder="Find a session" aria-label="Find a session to wait for" value={filter}
            onChange={(e) => setFilter(e.target.value)} autoComplete="off" spellCheck={false} />
          <ul role="list">
            {plannedChosen.map((id) => (
              <li key={id}><label className="lk-row"><input type="checkbox" checked onChange={() => toggle(id)} /><span className="name">{nameOf(id)}</span><span className="lk-state">planned</span></label></li>
            ))}
            {choices.map((s) => (
              <li key={s.id}>
                <label className="lk-row">
                  <input type="checkbox" checked={chosen.includes(s.id)} onChange={() => toggle(s.id)} />
                  <span className="name" title={titleOf(s)}>{titleOf(s)}</span>
                  <span className="lk-state">{s.state === 'needs_you' ? (s.need === 'interrupted' ? 'interrupted' : 'needs you') : s.state}</span>
                </label>
              </li>
            ))}
            {choices.length === 0 && plannedChosen.length === 0 && <li className="lk-empty">No session matches.</li>}
          </ul>
        </fieldset>

        {chosen.length > 1 && (
          <div className="lk-mode" role="radiogroup" aria-label="Start when">
            <label><input type="radio" name="lk-mode" checked={mode === 'all'} onChange={() => setMode('all')} />All of them finish</label>
            <label><input type="radio" name="lk-mode" checked={mode === 'any'} onChange={() => setMode('any')} />The first one finishes</label>
          </div>
        )}

        <label className="lk-prompt">Then send
          <textarea ref={prompt} rows={4} value={text} placeholder="What it should do next" onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); } }} />
        </label>
        <label className="lk-check"><input type="checkbox" checked={handOff} onChange={(e) => setHandOff(e.target.checked)} />Add their last answers to the prompt</label>
        {error && <p className="lk-error" role="alert">{error}</p>}

        <footer className="ns-foot">
          <span className="hint"><kbd>↵</kbd> save<span className="sep">·</span><kbd>⇧↵</kbd> new line</span>
          <button type="button" className="t-btn ghost" onClick={close}>Cancel</button>
          <button type="submit" className={`t-btn ns-start${ready ? ' is-ready' : ''}`} disabled={!ready}>{saving ? 'Saving…' : run ? 'Save' : 'Run after'}</button>
        </footer>
      </form>
    </dialog>
  );
}
