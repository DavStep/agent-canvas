// The Browser tab: an address field, back, reload and "Open in browser" over a frame the main
// process covers with its own view (electron/preview.ts). The page only says where the frame is;
// what may open is the main process's call.
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { loadFailure } from './loadFailure.ts';
import { createPortal } from 'react-dom';
import type { PreviewState } from '../../../shared/bridge.ts';
import { openExternal, previewBridge } from '../bridge.ts';
import type { SessionPage } from './sessionPages.ts';

const EMPTY: PreviewState = { url: null, canGoBack: false, loading: false, error: null };
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** What the owner typed → an address: loopback hosts get http://, other bare hosts https://. A
    scheme given is kept as it is (the main process refuses what it does not open). */
export function addressToUrl(text: string): string | null {
  const t = text.trim();
  if (t === '') return null;
  if (LOOPBACK.test(t)) return `http://${t}`;
  if (SCHEME.test(t) && !/^[^/:]+:\d/.test(t)) return t;
  return `https://${t}`;
}

/** The main process's refusal, without Electron's "Error invoking remote method …" wrapping. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}

const sameState = (a: PreviewState, b: PreviewState): boolean =>
  a.url === b.url && a.canGoBack === b.canGoBack && a.loading === b.loading && a.error === b.error;

const isWeb = (url: string | null): url is string => url !== null && /^https?:\/\//i.test(url);

export interface BrowserTabProps {
  barSlot: HTMLElement | null;
  /** The first local address in this turn's command output. */
  localUrl: string | null;
  /** The open session's page: whether the owner typed an address, and what opened by itself. */
  page: SessionPage;
  /** The state a command of this tab's ended in. */
  onOpened(state: PreviewState): void;
  /** Something (a dialog) is over the pane: the native view must not draw over it. */
  covered: boolean;
  onEditAddress(): void;
  onTypedAddress?(url: string): void;
}

export function BrowserTab({ barSlot, localUrl, page, covered, onOpened, onEditAddress, onTypedAddress }: BrowserTabProps) {
  const opened = useRef(onOpened);
  opened.current = onOpened;
  const frame = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PreviewState>(EMPTY);
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => previewBridge.onState(setState), []);
  // Another session's chat: its own page (put back by PreviewPane), and none of the last one's notes.
  useEffect(() => { setRefusal(null); }, [page]);
  useEffect(() => { if (!editing) setAddress(state.url ?? ''); }, [state.url, editing]);

  // The native view sits over the frame while this tab is shown and nothing covers it.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const hide = () => { previewBridge.command({ kind: 'show', bounds: null }).catch(() => {}); };
    if (covered) { hide(); return; }
    // Inside the frame's border, so the border and its rounded corners stay drawn by the page.
    const shell = el.closest<HTMLElement>('.preview-window');
    const workspace = el.closest<HTMLElement>('.workspace');
    // What the page is seen through: the canvas for a tile on it, the area beside the chat for a
    // dock (which slides out from under the chat's edge, its rest clipped).
    const port = workspace ?? el.closest<HTMLElement>('.canvas-area');
    const zone = el.closest<HTMLElement>('.zone');
    const board = zone?.closest<HTMLElement>('.board');
    const place = () => {
      // A card or another zone dragged over the page would pass under it; the tile's own zone in
      // the hand carries the page along.
      if (board?.classList.contains('is-dragging') && !zone?.classList.contains('is-moving')) { hide(); return; }
      const r = el.getBoundingClientRect();
      const zoom = workspace && el.offsetWidth ? r.width / el.offsetWidth : 1;
      if (!r.width || !r.height || !zoom) { hide(); return; }
      const bounds = { x: r.left + el.clientLeft * zoom, y: r.top + el.clientTop * zoom, width: el.clientWidth * zoom, height: el.clientHeight * zoom };
      const edge = port?.getBoundingClientRect();
      const x = Math.max(bounds.x, edge ? edge.left + port!.clientLeft : bounds.x);
      const y = Math.max(bounds.y, edge ? edge.top + port!.clientTop : bounds.y);
      const width = Math.min(bounds.x + bounds.width, edge ? edge.left + port!.clientLeft + port!.clientWidth : Infinity) - x;
      const height = Math.min(bounds.y + bounds.height, edge ? edge.top + port!.clientTop + port!.clientHeight : Infinity) - y;
      if (width <= 0 || height <= 0) { hide(); return; }
      // Sent every frame while the tile moves: only a changed state renders the tab.
      previewBridge.command({ kind: 'show', bounds, clip: { x, y, width, height }, zoom }).then(next => setState(prev => sameState(prev, next) ? prev : next), () => {});
    };
    place();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    watch?.observe(el);
    if (workspace) watch?.observe(workspace);
    if (zone) watch?.observe(zone);
    // A zone's translate/entrance, or a dock opening and closing beside the chat, moves the frame
    // without resizing it. Follow only while that zone or the dock is moving, and leave the
    // renderer idle once it settles.
    let frameId = 0;
    const running = (target: HTMLElement | null | undefined) => target?.getAnimations?.().some(a => a.playState === 'running') ?? false;
    const slot = el.closest<HTMLElement>('.board-tile');
    const trackZone = () => {
      cancelAnimationFrame(frameId);
      place();
      if (running(zone) || running(shell) || running(slot)) frameId = requestAnimationFrame(trackZone);
    };
    const shellMoves = (event: Event) => { if (event.target === shell) trackZone(); };
    if (running(shell)) frameId = requestAnimationFrame(trackZone);
    const moves = zone ? new MutationObserver(trackZone) : null;
    if (zone) moves?.observe(zone, { attributes: true, attributeFilter: ['style', 'class'] });
    // A pan or zoom changes only the board transform. Read after the DOM write, regardless
    // of the order in which the board and the preview subscribed to the camera.
    if (board) moves?.observe(board, { attributes: true, attributeFilter: ['style', 'class'] });
    if (slot) moves?.observe(slot, { attributes: true, attributeFilter: ['style'] });
    zone?.addEventListener('transitionrun', trackZone);
    zone?.addEventListener('animationstart', trackZone);
    shell?.addEventListener('preview-layout', place);
    shell?.addEventListener('transitionrun', shellMoves);
    shell?.addEventListener('transitionend', shellMoves);
    const panel = el.closest('.chat-screen');
    panel?.addEventListener('animationend', placed);
    function placed(event: Event) { if (event.target === panel) place(); }
    window.addEventListener('resize', place);
    return () => {
      watch?.disconnect();
      moves?.disconnect();
      cancelAnimationFrame(frameId);
      zone?.removeEventListener('transitionrun', trackZone);
      zone?.removeEventListener('animationstart', trackZone);
      shell?.removeEventListener('preview-layout', place);
      shell?.removeEventListener('transitionrun', shellMoves);
      shell?.removeEventListener('transitionend', shellMoves);
      panel?.removeEventListener('animationend', placed);
      window.removeEventListener('resize', place);
      hide();
    };
  }, [covered]);

  // A local address the session printed opens by itself, unless the owner typed one.
  useEffect(() => {
    if (localUrl === null || page.typed || page.autoLoaded === localUrl) return;
    page.autoLoaded = localUrl;
    setRefusal(null);
    // Bound now: the result belongs to this session even if the chat moves on before it comes.
    const record = opened.current;
    previewBridge.command({ kind: 'navigate', url: localUrl, typed: false })
      .then((s) => { setState(s); record(s); }, (err: unknown) => setRefusal(errorText(err)));
  }, [localUrl, page]);

  const run = (p: Promise<PreviewState>, typed?: (url: string) => void) => {
    setRefusal(null);
    const record = opened.current;
    p.then((s) => { setState(s); record(s); if (s.url) typed?.(s.url); }, (err: unknown) => setRefusal(errorText(err)));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const url = addressToUrl(address);
    if (url === null) return;
    page.typed = true;
    (document.activeElement as HTMLElement | null)?.blur();
    run(previewBridge.command({ kind: 'navigate', url, typed: true }), onTypedAddress);
  };

  const failure = state.error ? loadFailure(state.error, state.url) : null;
  return (
    <div className="pv-browser">
      {barSlot && createPortal(<><form className="pv-bar" onSubmit={submit}>
        <button type="button" className="pv-icon" aria-label="Back" disabled={!state.canGoBack} onClick={() => run(previewBridge.command({ kind: 'back' }))}>
          <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
        </button>
        <button type="button" className="pv-icon" aria-label="Reload" disabled={state.url === null} onClick={() => run(previewBridge.command({ kind: 'reload' }))}>
          <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.5H10" /></svg>
        </button>
        <input
          className={`pv-address${state.loading ? ' is-loading' : ''}`}
          aria-label="Address"
          placeholder="localhost:5173"
          spellCheck={false}
          autoComplete="off"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => { setEditing(true); e.currentTarget.select(); }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setAddress(state.url ?? ''); e.currentTarget.blur(); } }}
        />
        <button type="button" className="pv-icon" title="Open in browser" aria-label="Open in browser" disabled={!isWeb(state.url)} onClick={() => { if (isWeb(state.url)) openExternal(state.url).catch(() => {}); }}>
          <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2h5v5M14 2 7 9M7 3H3v10h10V9"/></svg>
        </button>
      </form>
      {refusal !== null && state.error === null && state.url !== null && <p className="pv-refusal" role="status">{refusal}</p>}</>, barSlot)}
      <div ref={frame} className="pv-frame">
        {/* Seen only while the native view is hidden: nothing opened yet, or it failed. */}
        {failure ? (
          <div className="pv-failure">
            <div role="status"><strong>{failure.title}</strong><p>{failure.detail}</p><code>{failure.code}</code></div>
            <div className="pv-recovery">
              {state.url && <button type="button" onClick={() => run(previewBridge.command({ kind: 'reload' }))}>Retry</button>}
              <button type="button" onClick={onEditAddress}>Edit address</button>
            </div>
          </div>
        ) : state.url === null ? (
          <p className={`pv-note${refusal !== null ? ' is-error' : ''}`} role={refusal !== null ? 'status' : undefined}>
            {refusal ?? 'No page open. Enter an address in preview controls.'}
          </p>
        ) : null}
      </div>
    </div>
  );
}
