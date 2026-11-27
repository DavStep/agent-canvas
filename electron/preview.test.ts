import { describe, expect, it } from 'vitest';
import type { PreviewState } from '../shared/bridge.ts';
import {
  checkPreviewUrl, clipPage, PREVIEW_PARTITION, previewPartition, previewWebPreferences, PreviewController, type PreviewHost, type PreviewView,
} from './preview.ts';

type Listener = (...args: unknown[]) => void;
type PermissionHandler = (wc: unknown, permission: string, cb: (ok: boolean) => void) => void;
type CheckHandler = (...args: unknown[]) => boolean;
type OpenHandler = (d: { url: string }) => { action: string };

/** How the next loads behave, for every view the controller makes. */
interface Script {
  /** Loads to hold: each waits for commit/finish/fail/abort instead of loading at once. */
  holdNext: number;
  failNext: { code: number; desc: string } | null;
}

/** A stand-in for a WebContentsView: records what the controller asks of it, and emits Chromium's
    events in Chromium's order (did-navigate, did-finish-load, did-stop-loading; or did-fail-load,
    did-stop-loading). */
function fakeView(script: Script) {
  const listeners = new Map<string, Listener[]>();
  const sessionListeners = new Map<string, Listener[]>();
  const history: string[] = [];
  const emit = (event: string, ...args: unknown[]) => { for (const l of listeners.get(event) ?? []) l(...args); };
  const view = {
    bounds: null as { x: number; y: number; width: number; height: number } | null,
    visible: false,
    closed: false,
    removed: false,
    loads: [] as string[],
    get history() { return [...history]; },
    reloads: 0,
    loading: false,
    permissionHandler: null as PermissionHandler | null,
    checkHandler: null as CheckHandler | null,
    openHandler: null as OpenHandler | null,
    held: new Map<string, { resolve: () => void; reject: (e: Error) => void }>(),
    emit,
    emitSession(event: string, ...args: unknown[]) { for (const l of sessionListeners.get(event) ?? []) l(...args); },
    /** A page commits (did-navigate); its load is not over yet. */
    commit(url: string) {
      history.push(url);
      emit('did-navigate', {}, url);
    },
    /** The load in flight ends: did-finish-load, did-stop-loading, and loadURL resolves. */
    finish(url: string) {
      view.loading = false;
      emit('did-finish-load');
      emit('did-stop-loading');
      const h = view.held.get(url);
      view.held.delete(url);
      h?.resolve();
    },
    /** The load fails with an error page. */
    fail(url: string, code: number, desc: string) {
      view.loading = false;
      history.push(url);
      emit('did-fail-load', {}, code, desc, url, true);
      emit('did-stop-loading');
      const h = view.held.get(url);
      view.held.delete(url);
      h?.reject(Object.assign(new Error(`${desc} (${code}) loading '${url}'`), { code: desc, errno: code }));
    },
    /** The load is replaced by another navigation of the page itself (a redirect by script). */
    abort(url: string) {
      emit('did-fail-load', {}, -3, 'ERR_ABORTED', url, true);
      const h = view.held.get(url);
      view.held.delete(url);
      h?.reject(Object.assign(new Error(`ERR_ABORTED (-3) loading '${url}'`), { code: 'ERR_ABORTED', errno: -3 }));
    },
    setBounds(b: { x: number; y: number; width: number; height: number }) { view.bounds = b; },
    setVisible(v: boolean) { view.visible = v; },
    webContents: {
      loadURL(url: string): Promise<void> {
        view.loads.push(url);
        view.loading = true;
        emit('did-start-loading');
        if (script.holdNext > 0) {
          script.holdNext--;
          return new Promise<void>((resolve, reject) => { view.held.set(url, { resolve, reject }); });
        }
        const fail = script.failNext;
        script.failNext = null;
        if (fail) {
          view.held.set(url, { resolve: () => {}, reject: () => {} });
          view.fail(url, fail.code, fail.desc);
          return Promise.reject(Object.assign(new Error(fail.desc), { code: fail.desc }));
        }
        view.commit(url);
        view.finish(url);
        return Promise.resolve();
      },
      getURL: (): string => history[history.length - 1] ?? '',
      reload() { view.reloads++; },
      isLoading: () => view.loading,
      close() { view.closed = true; },
      navigationHistory: {
        canGoBack: () => history.length > 1,
        goBack() { history.pop(); },
      },
      setWindowOpenHandler(h: OpenHandler) { view.openHandler = h; },
      on(event: string, l: Listener) { listeners.set(event, [...(listeners.get(event) ?? []), l]); },
      session: {
        setPermissionRequestHandler(h: PermissionHandler) { view.permissionHandler = h; },
        setPermissionCheckHandler(h: CheckHandler) { view.checkHandler = h; },
        on(event: string, l: Listener) { sessionListeners.set(event, [...(sessionListeners.get(event) ?? []), l]); },
      },
    },
  };
  return view;
}
type FakeView = ReturnType<typeof fakeView>;

function setup(scale = 1, partition?: string) {
  const script: Script = { holdNext: 0, failNext: null };
  const views: FakeView[] = [];
  const prefs: unknown[] = [];
  const opened: string[] = [];
  const pushed: PreviewState[] = [];
  const host: PreviewHost = {
    createView(webPreferences) {
      prefs.push(webPreferences);
      const v = fakeView(script);
      views.push(v);
      return v as unknown as PreviewView;
    },
    removeView(view) { (view as unknown as FakeView).removed = true; },
    openExternal: (url) => { opened.push(url); },
    scale: () => scale,
    changed: (s) => { pushed.push(s); },
  };
  const live = () => views.filter((v) => !v.closed);
  return { controller: new PreviewController(host, partition), script, views, live, prefs, opened, pushed };
}

const EMPTY: PreviewState = { url: null, canGoBack: false, loading: false, error: null };
const A = 'http://localhost:5173/';
const B = 'http://127.0.0.1:4747/';
const C = 'http://127.0.0.1:4848/';
const PANE = { x: 0, y: 0, width: 100, height: 100 };

describe('checkPreviewUrl', () => {
  it('auto navigation accepts only loopback http', () => {
    expect(checkPreviewUrl('http://localhost:5173/', false)).toBe('http://localhost:5173/');
    expect(checkPreviewUrl('http://127.0.0.1:4747', false)).toBe('http://127.0.0.1:4747/');
    for (const bad of [
      'https://localhost:5173/', 'http://example.com:8080/', 'https://example.com/', 'http://localhost/',
      'http://localhost.evil.test:5173/', 'http://user:pw@localhost:5173/', 'http://[::1]:5173/', 'http://0.0.0.0:5173/',
    ]) {
      expect(() => checkPreviewUrl(bad, false), bad).toThrow();
    }
  });

  it('typed navigation accepts http(s)', () => {
    expect(checkPreviewUrl('https://example.com/docs', true)).toBe('https://example.com/docs');
    expect(checkPreviewUrl('http://example.com:8080/', true)).toBe('http://example.com:8080/');
    expect(checkPreviewUrl('http://localhost:5173/', true)).toBe('http://localhost:5173/');
    expect(() => checkPreviewUrl('ftp://example.com/', true)).toThrow();
    expect(() => checkPreviewUrl('https://user:pw@example.com/', true)).toThrow();
    expect(() => checkPreviewUrl('not a url', true)).toThrow();
  });

  it('file:, javascript:, data: refused', () => {
    for (const typed of [true, false]) {
      expect(() => checkPreviewUrl('file:///etc/passwd', typed)).toThrow(/file:/);
      expect(() => checkPreviewUrl('javascript:alert(1)', typed)).toThrow(/javascript:/);
      expect(() => checkPreviewUrl('data:text/html,<h1>hi</h1>', typed)).toThrow(/data:/);
    }
  });
});

describe('PreviewController', () => {
  it("the view's webPreferences have no preload and partition persist:preview", async () => {
    const { controller, prefs } = setup();
    await controller.navigate(A, { typed: false });
    expect(prefs).toHaveLength(1);
    const p = prefs[0] as Record<string, unknown>;
    expect(p).toEqual(previewWebPreferences(PREVIEW_PARTITION));
    expect(p.partition).toBe('persist:preview');
    expect(p).not.toHaveProperty('preload');
    expect(p).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false });
  });

  it('demo mode keeps the preview in memory: its partition is not persist:', async () => {
    expect(previewPartition(false)).toBe('persist:preview');
    expect(previewPartition(true)).not.toMatch(/^persist:/);
    const { controller, prefs } = setup(1, previewPartition(true));
    await controller.navigate(A, { typed: false });
    await controller.navigate(B, { typed: false, fresh: true });
    expect(prefs.map((p) => (p as { partition: string }).partition)).toEqual([previewPartition(true), previewPartition(true)]);
    for (const p of prefs) expect(p).not.toHaveProperty('preload');
  });

  it('makes no view until something opens; within a session one view serves', async () => {
    const { controller, views } = setup();
    expect(controller.state()).toEqual(EMPTY);
    expect(controller.show(PANE)).toEqual(EMPTY);
    expect(views).toHaveLength(0);
    await controller.navigate(A, { typed: false });
    await controller.navigate('http://localhost:5174/', { typed: false });
    expect(views).toHaveLength(1);
  });

  it('refuses a navigation it may not make, and loads nothing', async () => {
    const { controller, views } = setup();
    await expect(controller.navigate('https://example.com/', { typed: false })).rejects.toThrow();
    await expect(controller.navigate('file:///etc/passwd', { typed: true })).rejects.toThrow();
    await expect(controller.navigate('about:blank', { typed: true })).rejects.toThrow(/about:/);
    expect(views).toHaveLength(0);
  });

  it('shows the view over the pane once its page has loaded, at the scaled bounds; null hides it', async () => {
    const { controller, views } = setup(1.25);
    controller.show({ x: 1076, y: 120, width: 348, height: 700 });
    const state = await controller.navigate(A, { typed: false });
    const view = views[0]!;
    expect(state).toEqual({ url: A, canGoBack: false, loading: false, error: null });
    expect(view.visible).toBe(true);
    expect(view.bounds).toEqual({ x: 1345, y: 150, width: 435, height: 875 });
    controller.show(null);
    expect(view.visible).toBe(false);
    controller.show({ x: 0.4, y: 10.6, width: 100.5, height: 50 });
    expect(view.visible).toBe(true);
    expect(view.bounds).toEqual({ x: 1, y: 13, width: 126, height: 63 });
  });

  it('a failed load is an error, with the view hidden so the pane can say so', async () => {
    const { controller, views, script, pushed } = setup();
    controller.show(PANE);
    script.failNext = { code: -102, desc: 'ERR_CONNECTION_REFUSED' };
    const state = await controller.navigate('http://localhost:5999/', { typed: true });
    expect(state.error).toMatch(/ERR_CONNECTION_REFUSED/);
    expect(views[0]!.visible).toBe(false);
    expect(pushed.at(-1)?.error).toMatch(/ERR_CONNECTION_REFUSED/);
    // The page's next navigation clears it.
    expect(await controller.navigate(A, { typed: true })).toMatchObject({ url: A, error: null });
    expect(views.at(-1)!.visible).toBe(true);
  });

  it('retries the failed main-frame address even if Chromium still reports the previous page', async () => {
    const { controller, views } = setup();
    await controller.navigate(A, { typed: false });
    views[0]!.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', B, true);
    expect(controller.state()).toMatchObject({ url: B, error: 'ERR_CONNECTION_REFUSED' });
    expect(await controller.reload()).toMatchObject({ url: B, error: null });
    expect(views[0]!.loads).toEqual([A, B]);
  });

  it('back and reload act on the view', async () => {
    const { controller, views } = setup();
    expect(controller.back().canGoBack).toBe(false);
    await controller.navigate(A, { typed: false });
    await controller.navigate(`${A}about`, { typed: true });
    expect(controller.state()).toMatchObject({ url: `${A}about`, canGoBack: true });
    expect(controller.back().url).toBe(A);
    controller.reload();
    expect(views[0]!.reloads).toBe(1);
  });

  it('every view is hardened: permissions denied, downloads cancelled, windows and schemes held', async () => {
    const { controller, views, opened } = setup();
    await controller.navigate(A, { typed: false });
    await controller.navigate(B, { typed: false, fresh: true });
    expect(views).toHaveLength(2);
    for (const view of views) {
      for (const permission of ['media', 'notifications', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write', 'midi', 'openExternal']) {
        let answer: boolean | null = null;
        view.permissionHandler!({}, permission, (ok) => { answer = ok; });
        expect(answer, permission).toBe(false);
      }
      expect(view.checkHandler!({}, 'media', A, {})).toBe(false);

      let prevented = false;
      let cancelled = false;
      view.emitSession('will-download', { preventDefault: () => { prevented = true; } }, { cancel: () => { cancelled = true; } });
      expect(prevented && cancelled).toBe(true);

      const open = view.openHandler!;
      expect(open({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
      expect(open({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
      expect(open({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });

      for (const event of ['will-navigate', 'will-redirect']) {
        for (const [url, allowed] of [['https://example.com/', true], [`${A}x`, true], ['file:///etc/passwd', false],
          ['javascript:alert(1)', false], ['data:text/html,hi', false], ['claude://code', false]] as const) {
          let stopped = false;
          view.emit(event, { url, preventDefault: () => { stopped = true; } }, url);
          expect(stopped, `${event} ${url}`).toBe(!allowed);
        }
      }
    }
    expect(opened).toEqual(['https://example.com/', 'https://example.com/']);
  });

  it('tells the page when its state changes', async () => {
    const { controller, views, pushed } = setup();
    await controller.navigate(A, { typed: false });
    pushed.length = 0;
    views[0]!.emit('did-navigate-in-page', {}, `${A}#x`);
    views[0]!.emit('did-stop-loading');
    expect(pushed.length).toBeGreaterThanOrEqual(2);
  });

  it('clear: the view goes (taken out of the window and closed); nothing open, nothing to go back to', async () => {
    const { controller, views, live, pushed } = setup();
    expect(await controller.clear()).toEqual(EMPTY);
    expect(views).toHaveLength(0);
    controller.show(PANE);
    await controller.navigate(A, { typed: false });
    await controller.navigate('https://example.com/', { typed: true });
    const view = views[0]!;
    expect(await controller.clear()).toEqual(EMPTY);
    expect(view).toMatchObject({ removed: true, closed: true });
    expect(live()).toHaveLength(0);
    expect(pushed.at(-1)).toEqual(EMPTY);
    expect(controller.back()).toEqual(EMPTY);
    expect(controller.show(PANE)).toEqual(EMPTY);
    // Its late events change nothing.
    view.emit('did-navigate', {}, A);
    view.emit('did-stop-loading');
    expect(controller.state()).toEqual(EMPTY);
    // The next page gets a new view with a history of its own.
    expect(await controller.navigate(B, { typed: false })).toEqual({ url: B, canGoBack: false, loading: false, error: null });
    expect(views).toHaveLength(2);
    expect(views[1]!.visible).toBe(true);
  });

  it('a switch (fresh) makes a new view and closes the old one', async () => {
    const { controller, views, live } = setup();
    controller.show(PANE);
    await controller.navigate(A, { typed: false });
    await controller.navigate(`${A}b`, { typed: true });
    const old = views[0]!;
    const state = await controller.navigate(B, { typed: false, fresh: true });
    expect(views).toHaveLength(2);
    expect(old).toMatchObject({ removed: true, closed: true, visible: false });
    expect(live()).toEqual([views[1]]);
    expect(state).toEqual({ url: B, canGoBack: false, loading: false, error: null });
    expect(views[1]!.visible).toBe(true);
    expect(controller.back().url).toBe(B);
  });

  it("the new view shows only once its own load stops, with no way back; the old view's events change nothing", async () => {
    const { controller, views, script, pushed } = setup();
    controller.show(PANE);
    await controller.navigate(A, { typed: false });
    const old = views[0]!;
    script.holdNext = 1;
    const switching = controller.navigate(B, { typed: false, fresh: true });
    const view = views[1]!;
    const pendingB = { url: B, canGoBack: false, loading: true, error: null };
    expect(view.visible).toBe(false);
    expect(controller.state()).toEqual(pendingB);
    // The old page finishing, redirecting or failing after the switch: nothing happens.
    pushed.length = 0;
    old.emit('did-navigate', {}, `${A}after-refresh`);
    old.emit('did-finish-load');
    old.emit('did-stop-loading');
    old.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', A, true);
    expect(view.visible).toBe(false);
    expect(old.visible).toBe(false);
    expect(controller.state()).toEqual(pendingB);
    expect(pushed).toEqual([]);
    // Resizing meanwhile keeps it hidden, and back leads nowhere.
    controller.show({ ...PANE, width: 120 });
    expect(view.visible).toBe(false);
    expect(controller.back()).toEqual(pendingB);
    // Its own first commit shows it (a page that never stops loading still appears); the load
    // stopping afterwards only reports the state.
    view.commit(B);
    expect(view.visible).toBe(true);
    expect(await switching).toEqual({ url: B, canGoBack: false, loading: true, error: null });
    view.finish(B);
    expect(view.visible).toBe(true);
    expect(pushed.at(-1)).toEqual({ url: B, canGoBack: false, loading: false, error: null });
  });

  it('a first load that never stops (a page streaming for ever) still settles at its commit: shown, and the switch is over', async () => {
    const { controller, views, script } = setup();
    controller.show(PANE);
    script.holdNext = 1;
    const switching = controller.navigate(B, { typed: false, fresh: true });
    const view = views[0]!;
    view.commit(B); // no did-stop-loading ever
    expect(await switching).toMatchObject({ url: B, error: null });
    expect(view.visible).toBe(true);
  });

  it("a redirect by the new page's own script is an ordinary navigation: no error", async () => {
    const { controller, views, script } = setup();
    controller.show(PANE);
    script.holdNext = 1;
    const switching = controller.navigate(B, { typed: false, fresh: true });
    const view = views[0]!;
    view.abort(B);
    expect(view.visible).toBe(false);
    view.commit(`${B}login`);
    expect(await switching).toEqual({ url: `${B}login`, canGoBack: false, loading: true, error: null });
    view.finish(`${B}login`);
    expect(controller.state()).toEqual({ url: `${B}login`, canGoBack: false, loading: false, error: null });
    expect(view.visible).toBe(true);
  });

  it('a real failure of the new view shows the error, view hidden', async () => {
    const { controller, views, script } = setup();
    controller.show(PANE);
    await controller.navigate(A, { typed: false });
    script.holdNext = 1;
    const switching = controller.navigate(B, { typed: false, fresh: true });
    views[1]!.fail(B, -102, 'ERR_CONNECTION_REFUSED');
    const state = await switching;
    expect(state.error).toMatch(/ERR_CONNECTION_REFUSED/);
    expect(state.canGoBack).toBe(false);
    expect(views[1]!.visible).toBe(false);
    expect(views[0]!.visible).toBe(false);
  });

  it('A → B → C quickly: exactly one live view, C\'s; B ending late changes nothing', async () => {
    const { controller, views, live, script } = setup();
    controller.show(PANE);
    await controller.navigate(A, { typed: false });
    script.holdNext = 2;
    const toB = controller.navigate(B, { typed: false, fresh: true });
    const toC = controller.navigate(C, { typed: true, fresh: true });
    const [, viewB, viewC] = views;
    expect(live()).toEqual([viewC]);
    expect(viewB).toMatchObject({ removed: true, closed: true });
    // B's navigate returns once it is overtaken; its late load does nothing.
    expect(await toB).toEqual({ url: C, canGoBack: false, loading: true, error: null });
    viewB!.commit(B);
    viewB!.finish(B);
    expect(viewB!.visible).toBe(false);
    expect(viewC!.visible).toBe(false);
    expect(controller.state()).toEqual({ url: C, canGoBack: false, loading: true, error: null });
    viewC!.commit(C);
    viewC!.finish(C);
    expect(await toC).toEqual({ url: C, canGoBack: false, loading: false, error: null });
    expect(viewC!.visible).toBe(true);
  });

  it('clear supersedes a switch in flight', async () => {
    const { controller, views, live, script } = setup();
    controller.show(PANE);
    script.holdNext = 1;
    const toB = controller.navigate(B, { typed: false, fresh: true });
    expect(await controller.clear()).toEqual(EMPTY);
    expect(await toB).toEqual(EMPTY);
    views[0]!.commit(B);
    views[0]!.finish(B);
    expect(controller.state()).toEqual(EMPTY);
    expect(live()).toHaveLength(0);
  });
});

describe('clipPage', () => {
  // A parent view does not clip a WebContentsView, so the page itself must cover only what shows.
  const tile = { x: 100, y: 50, width: 300, height: 400 };

  it('shows the whole page, at its own size, when nothing cuts it', () => {
    expect(clipPage(tile, tile)).toEqual({ widget: tile, page: { ...tile, x: 0, y: 0 } });
    expect(clipPage(tile, { x: 0, y: 0, width: 1000, height: 1000 })).toEqual({ widget: tile, page: { ...tile, x: 0, y: 0 } });
  });

  it('crops a page cut off at its right or bottom edge (the chat panel beside the workspace) at its whole size', () => {
    expect(clipPage(tile, { x: 0, y: 0, width: 340, height: 1000 }))
      .toEqual({ widget: { x: 100, y: 50, width: 240, height: 400 }, page: { ...tile, x: 0, y: 0 } });
    expect(clipPage(tile, { x: 0, y: 0, width: 1000, height: 300 }))
      .toEqual({ widget: { x: 100, y: 50, width: 300, height: 250 }, page: { ...tile, x: 0, y: 0 } });
  });

  it('keeps the layout size and shifts the page under a left or top crop', () => {
    expect(clipPage(tile, { x: 0, y: 120, width: 1000, height: 1000 }))
      .toEqual({ widget: { x: 100, y: 120, width: 300, height: 330 }, page: { ...tile, x: 0, y: -70 } });
    expect(clipPage(tile, { x: 160, y: 0, width: 100, height: 1000 }))
      .toEqual({ widget: { x: 160, y: 50, width: 100, height: 400 }, page: { ...tile, x: -60, y: 0 } });
  });

  it('never covers anything past the clip, even with no overlap', () => {
    expect(clipPage(tile, { x: 500, y: 0, width: 100, height: 100 }).widget.width).toBe(0);
    expect(clipPage(tile, { x: 0, y: 600, width: 1000, height: 100 }).widget.height).toBe(0);
  });
});
