// Only the app-owned clip document receives this preload. The embedded website remains a
// separate sandboxed WebContents with its own session and zoom forwarder.
import electron = require('electron');
electron.ipcRenderer.on('preview:clip', (_event, rect: { x: number; y: number; width: number; height: number }) => {
  const guest = document.querySelector<HTMLElement>('webview');
  if (!guest) return;
  Object.assign(guest.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
});
