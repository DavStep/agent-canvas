// "New session": Claude, Codex or an ACP agent from Settings, a folder (a zone's, or one chosen), a model, a permission mode
// and the first message, with any images or files pasted, dropped or attached. Start sends it; the card appears in the folder's zone and its chat opens.
// A native modal <dialog>, mounted only while open, so the browser preview hides under it.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { showsInNewSession } from '../../../shared/acp.ts';
import type { ProviderOptions } from '../../../shared/bridge.ts';
import type { Layout, SessionView } from '../../../shared/types.ts';
import { newSessionBridge } from '../bridge.ts';
import { AUTO_EFFORT, effortChoices, visibleModels } from '../../../shared/settings.ts';
import { composerKey, Picker, ThinkingIcon } from '../chat/Composer.tsx';
import { useSettings } from '../settings.ts';
import { AttachButton, FileStrip, ImageStrip, useAttachments } from '../chat/images.tsx';
import { zoneHue, ZoneMark } from '../components/ZoneMark.tsx';
import { useClosing } from '../useClosing.ts';
import { errorText } from '../preview/BrowserTab.tsx';
import { canStart, choiceOf, chooseModel, folderChoices, fromChoice, initialForm, startRequest, switchProvider, withOptions, type NewSessionForm, type ProviderChoice } from './form.ts';
import { namedModels } from '../../../shared/modelLabel.ts';

/** `missing`: why it cannot be chosen (an ACP agent not installed), else null. */
const PROVIDERS: { id: ProviderChoice; name: string; missing: string | null }[] = [{ id: 'claude', name: 'Claude', missing: null }, { id: 'codex', name: 'Codex', missing: null }];
const CHOOSE = '\u0000choose';

function Chevron() {
  return <svg className="i chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5l3-3" /></svg>;
}

export interface NewSessionDialogProps {
  sessions: SessionView[];
  layout: Layout;
  /** The folder to start in (a zone's "+"), or null for the most recent one. */
  cwd: string | null;
  after?: { id: string; name: string };
  onClose(): void;
  /** The new card's id: the page opens its chat. */
  onStarted(cardId: string): void;
}

export function NewSessionDialog({ sessions, layout, cwd, after, onClose, onStarted }: NewSessionDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [picked, setPicked] = useState<string[]>(() => (cwd !== null ? [cwd] : []));
  const choices = folderChoices(sessions, layout, picked);
  const [form, setForm] = useState<NewSessionForm>(() => initialForm('claude', cwd ?? choices.find((c) => c.kind === 'folder')?.path ?? null));
  const [options, setOptions] = useState<Partial<Record<ProviderChoice, ProviderOptions>>>({});
  const [optionsError, setOptionsError] = useState<Partial<Record<ProviderChoice, string>>>({});
  const [starting, setStarting] = useState(false);
  const [orchestrate, setOrchestrate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attach = useAttachments(starting);
  const choice = choiceOf(form);
  const current = options[choice] ?? null;
  const settings = useSettings();
  const thinking = effortChoices(current?.models.find((m) => m.id === form.model));
  // The ACP agents in Settings join Claude and Codex; one whose command is not on this Mac is
  // listed, but cannot be chosen, and says why.
  const agents = settings?.acpAgents.filter(showsInNewSession) ?? [];
  const starters = [...PROVIDERS, ...agents.map((a) => ({ id: `acp:${a.id}`, name: a.name, missing: a.path === null ? `${a.name} is not installed: \`${a.command}\` was not found` : null }))];
  const name = starters.find((p) => p.id === choice)?.name ?? 'the agent';

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    field.current?.focus();
  }, []);

  // Each provider's models and modes, asked for once, when it is first chosen.
  const asked = useRef(new Set<ProviderChoice>());
  useEffect(() => {
    if (orchestrate) return;
    const key = choice;
    if (asked.current.has(key)) return;
    asked.current.add(key);
    const { provider, agent } = fromChoice(key);
    newSessionBridge.options(provider, agent ?? undefined).then((o) => {
      setOptions((all) => ({ ...all, [key]: o }));
      setForm((f) => withOptions(f, key, o));
    }, (err: unknown) => {
      asked.current.delete(key);
      setOptionsError((all) => ({ ...all, [key]: errorText(err) }));
    });
  }, [choice, orchestrate]);

  // Closing never waits for a start: one still on its way carries on, and its card appears with
  // the next snapshot, but its chat is not opened (nor its error shown) once the dialog is gone.
  const gone = useRef(false);
  // Set again on every mount: StrictMode mounts, cleans up and mounts again in development.
  useEffect(() => {
    gone.current = false;
    return () => { gone.current = true; };
  }, []);
  const exit = useClosing(onClose);
  const close = () => { gone.current = true; exit.close(); };

  const chooseProvider = (next: ProviderChoice) => {
    setOrchestrate(false);
    if (next === choice) return;
    setError(null);
    setOptionsError((all) => ({ ...all, [next]: undefined }));
    setForm((f) => switchProvider(f, next, options[next] ?? null));
  };

  const chooseFolder = (value: string) => {
    setError(null);
    if (value !== CHOOSE) { setForm((f) => ({ ...f, cwd: value })); return; }
    newSessionBridge.pickFolder().then((path) => {
      if (path === null) return;
      setPicked((p) => [path, ...p.filter((x) => x !== path)]);
      setForm((f) => ({ ...f, cwd: path }));
    }, (err: unknown) => setError(errorText(err)));
  };

  const start = () => {
    if (!canStart(form, starting, attach.images, attach.files)) return;
    setStarting(true);
    setError(null);
    const req = startRequest(form, current, attach.images, attach.files);
    const request = orchestrate ? newSessionBridge.projectTask(req.cwd, req.text, req.images) : newSessionBridge.start(req, after?.id);
    request.then(
      (cardId) => { if (!gone.current) { setStarting(false); onStarted(cardId); } },
      (err: unknown) => { if (!gone.current) { setStarting(false); setError(errorText(err)); } },
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composerKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode }) === 'send') {
      e.preventDefault();
      start();
    }
  };

  const folder = choices.find((c) => c.path === form.cwd) ?? null;
  const ready = canStart(form, starting, attach.images, attach.files);
  const note = error ?? attach.error ?? (orchestrate ? null : optionsError[choice]) ?? null;

  return (
    <dialog
      ref={dialog}
      className={`ns${exit.closing ? ' is-closing' : ''}`}
      aria-labelledby="ns-title"
      // Esc closes, even while a start is on its way.
      onCancel={(e) => { e.preventDefault(); close(); }}
      // A press on the backdrop (the dialog element itself, outside its panel) closes too.
      onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="ns-panel">
        <header className="ns-head">
          <h2 id="ns-title">New session</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
          </button>
        </header>

        {after && <p className="lk-note">The first message will run after “{after.name}” finishes.</p>}
        <div className="ns-fields">
          <div className="ns-seg" role="radiogroup" aria-label="Start with">
            {starters.map((p) => {
              const on = !orchestrate && choice === p.id;
              const { missing } = p;
              return (
                <button key={p.id} type="button" role="radio" aria-checked={on} disabled={missing !== null} title={missing ?? undefined}
                  className={`ns-seg-btn is-${p.id.startsWith('acp:') ? 'acp' : p.id}${on ? ' is-on' : ''}${missing ? ' is-missing' : ''}`} onClick={() => chooseProvider(p.id)}>
                  <i aria-hidden="true" />{p.name}{missing !== null && <span className="ns-seg-note">Not installed</span>}
                </button>
              );
            })}
            {!after && <button type="button" role="radio" aria-checked={orchestrate} className={`ns-seg-btn${orchestrate ? ' is-on' : ''}`}
              onClick={() => { setError(null); setOrchestrate(true); }}>Orchestrator</button>}
          </div>

          <span className="ns-folder" style={{ '--zone-hue': zoneHue({ color: folder?.color, hueIndex: folder?.hueIndex ?? 6 }) } as CSSProperties}>
            <ZoneMark icon={folder?.icon} />
            <span className="label">{folder?.label ?? form.cwd ?? 'Choose a folder'}</span>
            {form.cwd !== null && <span className="path" title={form.cwd}>{form.cwd}</span>}
            <Chevron />
            <select aria-label="Folder" value={form.cwd ?? ''} onChange={(e) => chooseFolder(e.target.value)}>
              {form.cwd === null && <option value="" disabled>Choose a folder</option>}
              {choices.map((c) => <option key={c.path ?? CHOOSE} value={c.path ?? CHOOSE}>{c.path === null ? c.label : `${c.label} — ${c.path}`}</option>)}
            </select>
          </span>
        </div>

        <div className="composer ns-composer" onDragOver={attach.onDragOver} onDrop={attach.onDrop}>
          <ImageStrip images={attach.images} label="Images to send" onRemove={attach.remove} />
          <FileStrip files={attach.files} label="Files to send" onRemove={attach.removeFile} />
          <textarea
            ref={field}
            className="cp-field"
            rows={4}
            value={form.text}
            placeholder={orchestrate ? 'What should the project orchestrator coordinate?' : `What should ${name} do?`}
            aria-label="First message"
            onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
            onKeyDown={onKeyDown}
            onPaste={attach.onPaste}
          />
          <div className="cp-bar">
            <AttachButton disabled={starting || attach.full} onClick={attach.pick} />
            {attach.pickerInput}
            {note !== null && <span className="cp-error ns-error" role="alert" title={note}>{note}</span>}
            {!orchestrate && current && form.model !== null && (
              <Picker label="Model" value={form.model} options={namedModels(form.provider, visibleModels(current.models, form.provider === 'acp' || settings?.availableModelProfiles ? null : settings?.shownModels[form.provider], form.model))}
                disabled={starting} push onChange={(model) => setForm((f) => chooseModel(f, current, model))} />
            )}
            {!orchestrate && thinking.length > 0 && (
              <Picker label="Thinking" icon={<ThinkingIcon />} value={form.effort ?? AUTO_EFFORT} options={thinking} disabled={starting}
                onChange={(effort) => setForm((f) => ({ ...f, effort: effort === AUTO_EFFORT ? null : effort }))} />
            )}
            {!orchestrate && current && form.mode !== null && (
              <Picker label="Permissions" value={form.mode} options={current.modes} disabled={starting} push={form.model === null}
                onChange={(mode) => setForm((f) => ({ ...f, mode }))} />
            )}
          </div>
        </div>

        <footer className="ns-foot">
          <span className="hint"><kbd>↵</kbd> {after ? 'queue' : orchestrate ? 'send' : 'start'}<span className="sep">·</span><kbd>⇧↵</kbd> new line</span>
          <button type="button" className="t-btn ghost" onClick={close}>Cancel</button>
          <button type="button" className={`t-btn ns-start${ready ? ' is-ready' : ''}`} disabled={!ready} onClick={start}>
            {after ? (starting ? 'Queuing…' : 'Queue session') : orchestrate ? (starting ? 'Sending…' : 'Send to orchestrator') : (starting ? 'Starting…' : 'Start')}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
