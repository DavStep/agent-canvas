// A native widget covers exactly the visible part of the preview. Its private HTML document
// clips a full-size browser guest, so scrolling the canvas never resizes the guest's viewport.
import { WebContentsView, type BrowserWindow, type WebContents, type WebPreferences } from 'electron';
import { once } from 'node:events';
import path from 'node:path';
import { clipPage, type PreviewHost, type PreviewView } from './preview.ts';
import { forwardPreviewZoom, type HostZoom, type Placement } from './previewZoom.ts';

const allowedGuest = new WeakMap<WebContents, WebPreferences>();

/** Each private clip document may attach exactly its initial blank guest. The canvas and
    remote pages cannot attach one. All guest preferences come from the main process. */
export function restrictPreviewGuests(contents: WebContents) {
  contents.on('will-attach-webview', (event, prefs, params) => {
    const allowed = allowedGuest.get(contents);
    if (!allowed || params.src !== 'about:blank' || params.partition !== allowed.partition) { event.preventDefault(); return; }
    allowedGuest.delete(contents);
    Object.assign(prefs, allowed);
  });
}

export function previewSurfaces(window: BrowserWindow, preloadDir: string, onZoom: (event: HostZoom) => void):
  Pick<PreviewHost, 'createView' | 'removeView'> {
  const surfaces = new WeakMap<PreviewView, () => void>();
  return {
    async createView(prefs, signal) {
      const host = new WebContentsView({ webPreferences: { partition: 'preview-clip', sandbox: true, contextIsolation: true,
        nodeIntegration: false, webviewTag: true, preload: path.join(preloadDir, 'previewClip.cjs') } });
      const wc = host.webContents;
      host.setVisible(false);
      window.contentView.addChildView(host);
      const dispose = () => {
        allowedGuest.delete(wc);
        if (!window.isDestroyed()) window.contentView.removeChildView(host);
        if (!wc.isDestroyed()) wc.close();
      };
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-navigate', event => event.preventDefault());
      allowedGuest.set(wc, { ...prefs, preload: path.join(preloadDir, 'previewPreload.cjs') });
      // The partition is one of the app's two preview partitions. No site or user content
      // goes in this document, and it has no bridge or scripts of its own.
      const html = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; frame-src about:">' +
        '<style>html,body{margin:0;overflow:clip}webview{position:absolute}</style>' +
        // Let the guest's setWindowOpenHandler route links to the default browser.
        '<webview allowpopups src="about:blank" partition="' + prefs.partition + '"></webview>';
      const closed = new AbortController();
      const cancel = () => closed.abort();
      wc.once('destroyed', cancel);
      wc.once('render-process-gone', cancel);
      const startup = AbortSignal.any([signal, closed.signal, AbortSignal.timeout(15_000)]);
      const attached = once(wc, 'did-attach-webview', { signal: startup }).then(async ([, guest]: unknown[]) => {
        const page = guest as WebContents;
        page.once('destroyed', cancel);
        page.once('render-process-gone', cancel);
        try { await once(page, 'dom-ready', { signal: startup }); }
        finally { page.off('destroyed', cancel); page.off('render-process-gone', cancel); }
        return page;
      });
      let guest: WebContents;
      try {
        [guest] = await Promise.all([attached, wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))]);
      } catch (err) {
        cancel();
        dispose();
        throw err;
      } finally {
        wc.off('destroyed', cancel);
        wc.off('render-process-gone', cancel);
      }
      // The empty document allowed to attach the guest is not a Back destination.
      guest.once('did-navigate', () => guest.navigationHistory.clear());
      let placed: Placement | null = null;
      forwardPreviewZoom(guest, () => placed, onZoom);
      let lastPage: ReturnType<typeof clipPage>['page'] | undefined;
      const surface: PreviewView = {
        webContents: guest,
        setVisible(visible) { host.setVisible(visible); },
        setBounds(bounds, clip, zoom) {
          const { widget, page } = clipPage(bounds, clip);
          placed = { ...bounds, zoom, hostZoom: window.webContents.getZoomFactor(), visible: widget };
          if (guest.getZoomFactor() !== zoom) guest.setZoomFactor(zoom);
          host.setBounds(widget);
          if (!lastPage || lastPage.x !== page.x || lastPage.y !== page.y || lastPage.width !== page.width || lastPage.height !== page.height) {
            wc.send('preview:clip', page);
            lastPage = page;
          }
        },
      };
      surfaces.set(surface, dispose);
      return surface;
    },
    removeView(view) { surfaces.get(view)?.(); surfaces.delete(view); },
  };
}
