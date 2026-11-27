// The chat's right column: Live work (default) and Browser, as two tabs. Tabs change only when
// the owner picks one.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatItem, ChatState } from '../../../shared/chat.ts';
import { openExternal, previewBridge } from '../bridge.ts';
import type { ToolItem } from '../chat/items/ToolRow.tsx';
import { MediaPreview } from '../chat/ChatMedia.tsx';
import { BrowserTab } from './BrowserTab.tsx';
import { LiveWork } from './LiveWork.tsx';
import { holder, pageOf, remember, sessionPages, switchCommand } from './sessionPages.ts';

export type PreviewTab = 'live' | 'browser' | 'capture';

/** Anything drawn over the page that the native preview view would hide. */
const OVERLAY = 'dialog[open]:not(.preview-full-view), [popover]:popover-open, [role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-resizing]';

/** Whether a dialog is open anywhere on the page. */
function useOverlayOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const check = () => setOpen(document.querySelector(OVERLAY) !== null);
    check();
    const watch = new MutationObserver(check);
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'role', 'aria-modal', 'data-resizing'] });
    document.addEventListener('toggle', check, true);
    return () => { watch.disconnect(); document.removeEventListener('toggle', check, true); };
  }, []);
  return open;
}

export interface PreviewPaneProps {
  handle(views: ReactNode): ReactNode;
  expanded: boolean;
  boardPicker: ReactNode;
  onTypedAddress?(url: string): void;
  onCollapse(): void;
  onExpand(): void;
  sessionId: string;
  localUrl: string | null;
  preferBrowser: boolean;
  choice: PreviewTab | null;
  onChoose(tab: PreviewTab): void;
  capture: NonNullable<ChatState['browserCapture']> | null;
  plan?: ChatState['plan'];
  items: ChatItem[];
  cwd: string;
  /** The call Live work shows (the newest while following). */
  shown: ToolItem | null;
  follow: boolean;
  onFollow(on: boolean): void;
  onPick(id: string): void;
  /** The pane is still arriving or already leaving: the native view waits until it stands still. */
  moving?: boolean;
}

export function PreviewPane({ handle, expanded, boardPicker, onTypedAddress, onCollapse, onExpand, sessionId, localUrl, preferBrowser, choice, onChoose, capture, plan, items, cwd, shown, follow, onFollow, onPick, moving }: PreviewPaneProps) {
  const automatic = localUrl && preferBrowser ? 'browser' : capture ? 'capture' : 'live';
  const tab = choice === 'capture' && !capture ? automatic : choice ?? automatic;
  const [canOpenInEditor, setCanOpenInEditor] = useState(false);
  const toolbar = useRef<HTMLDivElement>(null);
  const [barSlot, setBarSlot] = useState<HTMLDivElement | null>(null);
  const covered = useOverlayOpen() || moving === true;

  useEffect(() => {
    let live = true;
    previewBridge.canOpenInEditor().then((ok) => { if (live) setCanOpenInEditor(ok); }, () => {});
    return () => { live = false; };
  }, []);
  // This session's page in the one preview view. A layout effect, so it is sent before the
  // Browser tab's own effects (an address this turn printed) for the same session.
  const page = pageOf(sessionPages, sessionId);
  const current = useRef(sessionId);
  const switching = useRef<Promise<unknown> | null>(null);
  useLayoutEffect(() => {
    current.current = sessionId;
    const cmd = switchCommand(sessionPages, holder.get(), sessionId);
    holder.set(sessionId);
    if (cmd === null) return;
    const done = previewBridge.command(cmd).then(
      (s) => { if (current.current === sessionId) remember(sessionPages, sessionId, { url: s.url }); },
      // A remembered page the rules no longer allow: show nothing rather than the last session's.
      () => previewBridge.command({ kind: 'clear' }).then(() => remember(sessionPages, sessionId, { url: null }), () => {}),
    );
    switching.current = done;
    void done.finally(() => { if (switching.current === done) switching.current = null; });
  }, [sessionId]);
  // Afterwards, whatever opens (a link, back, a typed or printed address) is this session's page.
  // Changes while switching may still be the last session's page, so they are left out.
  useEffect(() => previewBridge.onState((s) => {
    if (switching.current === null && holder.get() === current.current) remember(sessionPages, current.current, { url: s.url });
  }), []);

  const tabButton = (id: PreviewTab, label: string) => (
    <button type="button" role="tab" tabIndex={tab === id ? 0 : -1} onKeyDown={e => {
      const tabs: PreviewTab[] = capture ? ['live', 'browser', 'capture'] : ['live', 'browser'];
      const index = tabs.indexOf(id);
      const next = e.key === 'ArrowRight' ? (index + 1) % tabs.length
        : e.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
      if (next < 0) return;
      e.preventDefault();
      const chosen = tabs[next]!;
      onChoose(chosen);
      toolbar.current?.querySelector<HTMLButtonElement>(`#pv-tab-${chosen}`)?.focus();
    }} id={`pv-tab-${id}`} aria-controls="pv-panel" aria-selected={tab === id}
      className={`pv-tab${tab === id ? ' is-on' : ''}`} onClick={() => onChoose(id)}>{label}</button>
  );

  return (
    <aside className="cs-preview" aria-label="Preview" data-selected-tool={shown?.id}>
      <div className="pv-toolbar" ref={toolbar}
        onKeyDown={e => {
          if (expanded && e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault();
            toolbar.current?.querySelector<HTMLButtonElement>('button[aria-expanded]')?.focus();
            onCollapse();
          }
        }}>
        {handle(<div id="pv-views" hidden={!expanded}>
          <div className="pv-tabs" role="tablist" aria-label="Preview">
            {tabButton('live', 'Live work')}
            {tabButton('browser', 'Browser')}
            {capture && tabButton('capture', 'Capture')}
          </div>
        </div>)}
        <div id="pv-options" hidden={!expanded}>
          {tab === 'live' && <button type="button" className={`pv-follow${follow ? ' is-on' : ''}`} aria-pressed={follow}
            aria-label="Follow newest" title="Follow newest" onClick={() => onFollow(!follow)}>Follow newest</button>}
          {boardPicker}
          <div ref={setBarSlot} />
        </div>
      </div>
      <div id="pv-panel" className="pv-panel" role="tabpanel" aria-label={tab === 'live' ? 'Live work' : tab === 'capture' ? 'Capture' : 'Browser'}>
        {tab === 'capture' && capture
          ? <div className="pv-capture"><MediaPreview media={{ kind: 'image', src: capture.src, label: 'Browser capture' }} /></div>
          : tab === 'live'
          ? <LiveWork plan={plan} items={items} cwd={cwd} shown={shown} canOpenInEditor={canOpenInEditor} onPick={onPick}
              onOpenInEditor={(url) => { openExternal(url).catch(() => {}); }} />
          : <BrowserTab onTypedAddress={onTypedAddress} onEditAddress={() => { onExpand(); requestAnimationFrame(() => toolbar.current?.querySelector<HTMLInputElement>('.pv-address')?.focus()); }} barSlot={barSlot} localUrl={localUrl} page={page} covered={covered} onOpened={(s) => {
              // The result of a command this session's tab sent, unless the chat moved on since.
              if (current.current === sessionId) remember(sessionPages, sessionId, { url: s.url });
            }} />}
      </div>
    </aside>
  );
}
