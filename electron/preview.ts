// The Browser tab's page: a WebContentsView of its own over the chat's right column. It lives in
// its own partition with no preload but the zoom forwarder (previewPreload.cts, which exposes
// nothing), so it never reaches window.canvas; it gets no permissions and
// no downloads, and leaves http(s) for nothing. The main process decides what it may open: by
// itself only a loopback dev server's address; anything else on the web only when the owner typed it.
import type { PreviewState } from '../shared/bridge.ts';

export interface Rect { x: number; y: number; width: number; height: number }

export const PREVIEW_PARTITION = 'persist:preview';
/** Demo mode reads and writes nothing: its preview session lives in memory (no `persist:`). */
export const DEMO_PREVIEW_PARTITION = 'preview-demo';
export const previewPartition = (demo: boolean): string => (demo ? DEMO_PREVIEW_PARTITION : PREVIEW_PARTITION);

/** No `preload`: the page gets nothing from this app. */
export function previewWebPreferences(partition: string) {
  return Object.freeze({
    partition,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    safeDialogs: true,
    navigateOnDragDrop: false,
    spellcheck: false,
  });
}

/** The widget occupies the visible intersection. The full page's origin inside it can
    be negative when the left or top of the preview has moved outside the workspace. */
export function clipPage(bounds: Rect, clip: Rect): { widget: Rect; page: Rect } {
  const x = Math.max(bounds.x, clip.x);
  const y = Math.max(bounds.y, clip.y);
  const width = Math.max(0, Math.min(bounds.x + bounds.width, clip.x + clip.width) - x);
  const height = Math.max(0, Math.min(bounds.y + bounds.height, clip.y + clip.height) - y);
  return { widget: { x, y, width, height }, page: { ...bounds, x: bounds.x - x, y: bounds.y - y } };
}

/** Chromium's code for a load that another navigation replaced. */
const ERR_ABORTED = -3;
const WEB = new Set(['http:', 'https:']);
const LOOPBACK = new Set(['localhost', '127.0.0.1']);

type Listener = (...args: never[]) => void;
/** The part of Electron's WebContentsView the controller uses (a fake stands in for it in tests). */
export interface PreviewView {
  setBounds(bounds: Rect, clip: Rect, zoom: number): void;
  setVisible(visible: boolean): void;
  webContents: {
    loadURL(url: string): Promise<void>;
    getURL(): string;
    reload(): void;
    isLoading(): boolean;
    navigationHistory: { canGoBack(): boolean; goBack(): void };
    close(): void;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
    on(event: string, listener: Listener): unknown;
    session: {
      setPermissionRequestHandler(handler: (wc: unknown, permission: string, cb: (granted: boolean) => void) => void): void;
      setPermissionCheckHandler(handler: () => boolean): void;
      on(event: 'will-download', listener: (e: { preventDefault(): void }, item: { cancel(): void }) => void): unknown;
    };
  };
}

export interface PreviewHost {
  createView(webPreferences: ReturnType<typeof previewWebPreferences>, signal: AbortSignal): PreviewView | Promise<PreviewView>;
  /** Removes the native surface after the guest closes. */
  removeView(view: PreviewView): void;
  /** Hands an http(s) link to the real browser. */
  openExternal(url: string): void;
  /** CSS pixels of the canvas page per window point (the page's zoom factor). */
  scale(): number;
  /** The state changed without the page asking (a link followed, a load finished). */
  changed(state: PreviewState): void;
}

const isWeb = (url: string): boolean => {
  try {
    return WEB.has(new URL(url).protocol);
  } catch {
    return false;
  }
};

/** The address to load, or a refusal. Typed: any http(s). Otherwise: http://localhost:<port> or
    http://127.0.0.1:<port>. Never credentials in the address; never file:, javascript:, data: or the like. */
export function checkPreviewUrl(raw: string, typed: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a web address: ${raw}`);
  }
  if (!WEB.has(url.protocol)) throw new Error(`${url.protocol} addresses are not opened here`);
  if (url.username !== '' || url.password !== '') throw new Error('Addresses with a user name or password are not opened here');
  if (!typed && (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.port === '')) {
    throw new Error('Only http://localhost:<port> and http://127.0.0.1:<port> open by themselves');
  }
  return url.href;
}

export class PreviewController {
  /** The one live view. A switch to another session's page, the first page after a start or a
      clear, gets a brand-new view: no document, history or events of the last page come with it. */
  private view: PreviewView | null = null;
  private creating: AbortController | null = null;
  private bounds: Rect | null = null;
  private clip: Rect | null = null;
  private zoom = 1;
  /** The view has a page of the current session (loaded, or failed with its error). */
  private opened = false;
  /** A new view's first load, not yet committed (or stopped): the view stays hidden meanwhile. */
  private pending: string | null = null;
  private error: string | null = null;
  // getURL() may still point at the previous document when the requested page never commits.
  private failedUrl: string | null = null;
  /** Navigates waiting for their new view's first commit, or its load to end (or for the view to be replaced). */
  private waiting: (() => void)[] = [];
  /** Sessions already given their handlers (views of one partition share one). */
  private readonly hardened = new WeakSet<object>();

  constructor(private readonly host: PreviewHost, private readonly partition: string = PREVIEW_PARTITION) {}

  state(): PreviewState {
    if (this.pending !== null) return { url: this.pending, canGoBack: false, loading: true, error: this.error };
    const wc = this.view?.webContents;
    if (!wc || !this.opened) return { url: null, canGoBack: false, loading: false, error: this.error };
    return { url: this.failedUrl ?? (wc.getURL() || null), canGoBack: wc.navigationHistory.canGoBack(), loading: wc.isLoading(), error: this.error };
  }

  /** Places the view over the pane (CSS pixels of the page), or hides it with null. */
  show(bounds: Rect | null, clip = bounds, zoom = 1): PreviewState {
    this.bounds = bounds;
    this.clip = clip;
    this.zoom = zoom;
    this.place();
    return this.state();
  }

  /** Opens an address. `fresh` (a switch to another session's page), and any page when none of
      this session is open, gets a new view that stays hidden until its first commit (or, failing that, its load stopping). */
  async navigate(url: string, { typed, fresh = false }: { typed: boolean; fresh?: boolean }): Promise<PreviewState> {
    const href = checkPreviewUrl(url, typed);
    this.failedUrl = null;
    this.error = null;
    if (!fresh && this.opened && this.view) {
      // Within the session's page: its own events report how it went.
      const view = this.view;
      this.place();
      await view.webContents.loadURL(href).catch(() => {});
      return this.state();
    }
    this.retire();
    const creation = new AbortController();
    this.creating = creation;
    this.pending = href;
    let view: PreviewView;
    try {
      const result = this.host.createView(previewWebPreferences(this.partition), creation.signal);
      view = result instanceof Promise ? await result : result;
    } catch (error) {
      if (creation.signal.aborted) return this.state();
      this.pending = null;
      this.creating = null;
      this.error = error instanceof Error ? error.message : 'Could not open the preview.';
      this.changed();
      return this.state();
    }
    if (creation.signal.aborted) { this.closeView(view); return this.state(); }
    this.creating = null;
    this.view = view;
    this.configure(view);
    this.place();
    const over = new Promise<void>((resolve) => { this.waiting.push(resolve); });
    // How it ends is read from this view's own events (see configure), not from this promise.
    view.webContents.loadURL(href).catch(() => {});
    await over;
    return this.state();
  }

  /** Empties the pane: the view goes (out of the window, closed), so nothing of the cleared page,
      not even its history, remains to reach; the next page gets a new view. */
  async clear(): Promise<PreviewState> {
    this.retire();
    this.error = null;
    this.changed();
    return this.state();
  }

  back(): PreviewState {
    const wc = this.view?.webContents;
    if (wc && this.opened && wc.navigationHistory.canGoBack()) {
      this.error = null;
      this.failedUrl = null;
      wc.navigationHistory.goBack();
      this.place();
    }
    return this.state();
  }

  reload(): PreviewState | Promise<PreviewState> {
    if (this.failedUrl) return this.navigate(this.failedUrl, { typed: true });
    if (this.view && this.opened) {
      this.error = null;
      this.view.webContents.reload();
      this.place();
    }
    return this.state();
  }

  private place(): void {
    const view = this.view;
    if (!view) return;
    const visible = this.bounds !== null && this.opened && this.error === null;
    if (visible) {
      const k = this.host.scale();
      const scaled = (b: Rect) => ({ x: Math.round(b.x * k), y: Math.round(b.y * k), width: Math.round(b.width * k), height: Math.round(b.height * k) });
      view.setBounds(scaled(this.bounds!), scaled(this.clip!), this.zoom * k);
    }
    view.setVisible(visible);
  }

  private changed(): void {
    this.host.changed(this.state());
  }

  /** The new view's first load is over: shown, or its error with the view hidden. */
  private settle(error: string | null): void {
    this.pending = null;
    this.opened = true;
    this.error = error;
    this.place();
    this.changed();
    this.wake();
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const resolve of waiting) resolve();
  }

  /** Takes the live view out of the window and closes it; its later events find it is not the
      live one and do nothing. */
  private retire(): void {
    const view = this.view;
    this.creating?.abort();
    this.creating = null;
    this.view = null;
    this.opened = false;
    this.failedUrl = null;
    this.pending = null;
    if (view) this.closeView(view);
    this.wake();
  }

  private closeView(view: PreviewView): void {
    view.setVisible(false);
    view.webContents.close();
    this.host.removeView(view);
  }

  /** A new view, hardened: no preload (see previewWebPreferences), no permissions, no downloads,
      new windows to the real browser for http(s) only, navigation and redirects on http(s) only. */
  private configure(view: PreviewView): void {
    const wc = view.webContents;
    const live = () => this.view === view;
    if (!this.hardened.has(wc.session)) {
      this.hardened.add(wc.session);
      // Camera, microphone, notifications, location, clipboard, MIDI…: all refused, asked or checked.
      wc.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
      wc.session.setPermissionCheckHandler(() => false);
      wc.session.on('will-download', (e, item) => { e.preventDefault(); item.cancel(); });
    }
    // New windows: a web link goes to the real browser; nothing opens here.
    wc.setWindowOpenHandler(({ url }) => {
      if (isWeb(url)) this.host.openExternal(url);
      return { action: 'deny' };
    });
    // The page and its redirects stay on the web (whether or not the view is still the live one).
    const stayOnWeb = (e: { preventDefault(): void; url?: string }, url?: string) => {
      if (!isWeb(e.url ?? url ?? '')) e.preventDefault();
    };
    wc.on('will-navigate', stayOnWeb as Listener);
    wc.on('will-redirect', stayOnWeb as Listener);
    wc.on('did-fail-load', ((_e: unknown, code: number, description: string, url: string, isMainFrame: boolean) => {
      // ERR_ABORTED: another navigation of the page took over (its own redirect): not a failure.
      if (!live() || !isMainFrame || code === ERR_ABORTED) return;
      const error = description || `Network error ${code}`;
      this.failedUrl = isWeb(url) ? url : this.pending;
      if (this.pending !== null) { this.settle(error); return; }
      this.error = error;
      this.place();
      this.changed();
    }) as Listener);
    wc.on('did-stop-loading', (() => {
      if (!live()) return;
      if (this.pending !== null) { this.settle(null); return; }
      this.changed();
    }) as Listener);
    wc.on('did-navigate', (() => {
      if (!live()) return;
      this.failedUrl = null;
      // The new view's own first main-frame commit: its page is there, so it shows now (a page
      // that keeps loading, such as one that streams, would otherwise never appear).
      if (this.pending !== null) { this.settle(null); return; }
      this.error = null;
      this.place();
      this.changed();
    }) as Listener);
    for (const event of ['did-navigate-in-page', 'did-start-loading']) {
      wc.on(event, (() => { if (live() && this.pending === null) this.changed(); }) as Listener);
    }
  }
}
