// The message field: Enter sends, Shift+Enter breaks the line; images and files by paste, drop or
// the attach button; the provider's models and permission modes; Stop while a turn runs.
import { allowedProfiles, profileId, profileLabel } from '../../../shared/modelPolicy.ts';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ImageRef, ModelOption, ModeOption, SessionProvider } from '../../../shared/chat.ts';
import { withFiles, type FileRef } from '../../../shared/attachments.ts';
import { errorText } from '../preview/BrowserTab.tsx';
import { visibleModels } from '../../../shared/settings.ts';
import { namedModels } from '../../../shared/modelLabel.ts';
import { useSettings } from '../settings.ts';
import { AttachButton, FileStrip, ImageStrip, useAttachments } from './images.tsx';

export { admitAttachments, admitImages, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES } from './images.tsx';

export function composerKey(e: { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number }): 'send' | 'newline' | 'none' {
  if (e.key !== 'Enter') return 'none';
  // An input method (Japanese, Chinese…) uses Enter to pick its text: never send then.
  if (e.isComposing || e.keyCode === 229) return 'none';
  return e.shiftKey ? 'newline' : 'send';
}

/** Something to send, and nothing in the way. Blank text with no images is never sent. */
/** What the composer holds once a send went through: the field is cleared only if it still holds
    what was sent, and only the images sent are taken away (more may have been typed or added
    while the send was under way). */
export function afterSend(now: { text: string; images: ImageRef[] }, sent: { text: string; images: ImageRef[] }): { text: string; images: ImageRef[] } {
  return { text: now.text === sent.text ? '' : now.text, images: now.images.filter((i) => !sent.images.includes(i)) };
}

export function canSend(text: string, images: ImageRef[], blocked: string | null, files: FileRef[] = []): boolean {
  return blocked === null && (text.trim() !== '' || images.length > 0 || files.length > 0);
}

function Chevron() {
  return <svg className="i" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5l3-3" /></svg>;
}

/** The thinking menu's mark: a small spark beside the level. */
export function ThinkingIcon() {
  return (
    <svg className="i" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1.5v2M6 8.5v2M1.5 6h2M8.5 6h2M3 3l1.2 1.2M7.8 7.8 9 9M9 3 7.8 4.2M4.2 7.8 3 9" />
    </svg>
  );
}

/** A quiet button-look over a native select, so the menu is the system's own. */
export function Picker({ label, value, options, onChange, disabled, push, icon }: {
  label: string; value: string; options: { id: string; label: string }[]; onChange(v: string): void; disabled: boolean; push?: boolean;
  /** Drawn before the current choice, to say what the menu picks (the thinking level). */
  icon?: ReactNode;
}) {
  const current = options.find((o) => o.id === value)?.label ?? (value || label);
  return (
    <span className={`picker${push ? ' push' : ''}${disabled ? ' is-disabled' : ''}`} title={label}>
      {icon}{current}<Chevron />
      <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </span>
  );
}

export interface ComposerProps {
  provider: SessionProvider;
  models: ModelOption[];
  model: string | null;
  effort?: string | null;
  modes: ModeOption[];
  mode: string;
  running: boolean;
  queueInCodex?: boolean;
  /** Why sending is off (read only, provider banner), or null. */
  blocked: string | null;
  /** The placeholder while sending is off ("Read-only — open in Terminal to reply"); "Sending is
      off" when not given. */
  offHint?: string;
  /** Who the field writes to, when that is not simply the provider ("the canvas agent"). */
  name?: string;
  /** A text to put in the field and the caret after it (an example prompt pressed). A new object
      fills again, even with the same text. `append`: added after what the field holds (an open
      thread dropped in), not in its place. */
  fill?: { text: string; append?: boolean } | null;
  autoFocus: boolean;
  onSend(text: string, images: ImageRef[]): Promise<void>;
  onStop(): Promise<void>;
  onModel(model: string): Promise<void>;
  onMode(mode: string): Promise<void>;
}

export function Composer(p: ComposerProps) {
  const [text, setText] = useState('');
  const shown = useSettings();
  const provider = p.provider;
  const available = provider !== 'acp' ? shown?.availableModelProfiles?.[provider] : undefined;
  const profiles = provider !== 'acp' && available
    ? allowedProfiles(provider, shown?.modelPermissions?.[provider])
    : null;
  const profile = profiles?.find(x => x.model === p.model && x.effort === p.effort);
  const attach = useAttachments(p.blocked !== null);
  const { images, setImages, files, setFiles, error, setError } = attach;
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const ready = canSend(text, images, p.blocked, files) && !sending;
  const name = p.name ?? (p.provider === 'codex' ? 'Codex' : 'Claude');

  // Only when the chat opens: later changes of autoFocus must not pull focus.
  const focusOnOpen = useRef(p.autoFocus);
  useEffect(() => { if (focusOnOpen.current) field.current?.focus(); }, []);

  // An example prompt replaces what the field holds, ready to be finished or sent.
  const fill = p.fill ?? null;
  useEffect(() => {
    if (fill === null) return;
    const el = field.current;
    const before = fill.append ? (el?.value ?? '').trimEnd() : '';
    const next = before === '' ? fill.text : `${before}\n\n${fill.text}`;
    setText(next);
    if (!el) return;
    el.focus();
    // After the render that shows the text, so the caret lands at its end.
    requestAnimationFrame(() => el.setSelectionRange(next.length, next.length));
  }, [fill]);

  // The field grows with its text, up to a third of the window.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight / 3))}px`;
  }, [text]);

  const send = async () => {
    if (!ready) return;
    setSending(true);
    setError(null);
    try {
      const sent = { text, images };
      const sentFiles = files;
      // Files go by path, written into the text the way the provider's own app writes them.
      await p.onSend(withFiles(p.provider, text, files), images);
      setText((now) => afterSend({ text: now, images: [] }, sent).text);
      setImages((now) => afterSend({ text: '', images: now }, sent).images);
      setFiles((now) => now.filter((f) => !sentFiles.includes(f)));
    } catch (err) {
      setError(`Not sent: ${errorText(err)}`);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { e.currentTarget.blur(); return; }
    const action = composerKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode });
    if (action === 'send') { e.preventDefault(); void send(); }
  };

  const run = (call: Promise<void>) => { call.catch((err: unknown) => setError(errorText(err))); };

  return (
    <div className="composer-wrap">
      <div className={`composer${p.blocked !== null ? ' is-blocked' : ''}`} onDragOver={attach.onDragOver} onDrop={attach.onDrop}>
        <ImageStrip images={images} label="Images to send" onRemove={attach.remove} />
        <FileStrip files={files} label="Files to send" onRemove={attach.removeFile} />
        <textarea
          ref={field}
          className="cp-field"
          rows={2}
          value={text}
          placeholder={p.blocked !== null ? p.offHint ?? 'Sending is off' : p.queueInCodex ? 'Queue a message in Codex…' : `Message ${name}…`}
          aria-label={`Message ${name}`}
          disabled={p.blocked !== null}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={attach.onPaste}
        />
        {error !== null && <div className="cp-error" role="status">{error}</div>}
        <div className="cp-bar">
          <AttachButton disabled={p.blocked !== null || attach.full} onClick={attach.pick} />
          {attach.pickerInput}
          {profiles && profiles.length > 0 ? (
            <Picker label="Model and thinking" value={profile ? profileId(profile) : ''} options={profiles.map(x => ({ id: profileId(x), label: profileLabel(x) }))}
              disabled={p.running || p.blocked !== null || !!p.queueInCodex} push onChange={(v) => run(p.onModel(v))} />
          ) : p.models.length > 0 && p.model !== null && (
            <Picker label="Model" value={p.model} options={namedModels(p.provider, visibleModels(p.models, p.provider === 'acp' ? null : shown?.shownModels[p.provider], p.model))} disabled={p.blocked !== null || !!p.queueInCodex} push
              onChange={(v) => run(p.onModel(v))} />
          )}
          {p.modes.length > 0 && (
            <Picker label="Permissions" value={p.mode} options={p.modes} disabled={p.blocked !== null || !!p.queueInCodex} push={p.models.length === 0 || p.model === null}
              onChange={(v) => run(p.onMode(v))} />
          )}
          {p.running ? (
            <button type="button" className="send is-stop" aria-label="Stop" onClick={() => run(p.onStop())}>
              <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" /></svg>
            </button>
          ) : (
            <button type="button" className={`send${ready ? ' is-ready' : ''}`} aria-label={p.queueInCodex ? "Queue message" : "Send"} disabled={!ready} onClick={() => void send()}>
              <svg className="i" width="16" height="16" viewBox="0 0 16 16" style={{ strokeWidth: 1.75 }} aria-hidden="true"><path d="M8 13V3.5M4 7.5l4-4 4 4" /></svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
