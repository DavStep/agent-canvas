// The Browser tab's page's only preload. It gives the page nothing (no contextBridge, nothing on
// window; it runs in its own isolated world) and does one thing: a ⌘/Ctrl wheel or a trackpad pinch
// (Chromium hands the page a pinch as a Ctrl wheel) is stopped here, before the page can scroll or
// zoom with it, and sent to the main process, which zooms the canvas with it (see previewZoom.ts).
// Plain scrolling is left to the page. Sandboxed preloads must be CommonJS and load only `electron`.
import electron = require('electron');

const CHANNEL = 'preview:zoomWheel'; // PREVIEW_ZOOM_WHEEL in previewZoom.ts
const LINE_PX = 16;

window.addEventListener('wheel', (e) => {
  if (!e.isTrusted || (!e.ctrlKey && !e.metaKey)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const scale = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_PX : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1;
  electron.ipcRenderer.send(CHANNEL, {
    x: e.clientX, y: e.clientY, dx: e.deltaX * scale, dy: e.deltaY * scale,
    ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey,
  });
}, { capture: true, passive: false });
