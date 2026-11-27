// Exposes CanvasBridge to the page as `window.canvas`. Sandboxed preloads must be CommonJS and may
// load only `electron`, so build-electron bundles ipc.ts into this file.
import electron = require('electron');
import ipc = require('./ipc.ts');
import type { CanvasBridge, CanvasFiles, PreviewState, PreviewZoom } from '../shared/bridge.ts';
import type { ChatUpdate } from '../shared/chat.ts';
import type { Snapshot } from '../shared/types.ts';

const { contextBridge, ipcRenderer } = electron;
const { CHANNELS, chatChannel } = ipc;

/** Listens to a pushed channel; the page gets the payload only, never the IPC event. */
function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

const bridge: CanvasBridge = {
  onSnapshot(cb) {
    let pushed = false;
    const off = listen<Snapshot>(CHANNELS.onSnapshot, (s) => { pushed = true; cb(s); });
    // The current snapshot, unless a newer one was pushed while this was on its way. A refusal
    // (the page is not the app's) leaves only the pushes.
    ipcRenderer.invoke(CHANNELS.onSnapshot).then((s: Snapshot) => { if (!pushed) cb(s); }).catch(() => {});
    return off;
  },
  layoutOp: (op) => ipcRenderer.invoke(CHANNELS.layoutOp, op),
  markSeen: (ids) => ipcRenderer.invoke(CHANNELS.markSeen, ids),
  dismissInterruption: (sessionId, undo) => ipcRenderer.invoke(CHANNELS.dismissInterruption, sessionId, undo === true),
  openChat: (sessionId) => ipcRenderer.invoke(CHANNELS.openChat, sessionId),
  // One chat's updates come on a channel of its own (see openChat for its current state).
  onChat: (sessionId, cb) => listen<ChatUpdate>(chatChannel(String(sessionId)), cb),
  closeChat: (sessionId) => { ipcRenderer.send(CHANNELS.closeChat, sessionId); },
  loadOlder: (sessionId) => ipcRenderer.invoke(CHANNELS.loadOlder, sessionId),
  send: (sessionId, text, images) => ipcRenderer.invoke(CHANNELS.send, sessionId, text, images),
  interrupt: (sessionId) => ipcRenderer.invoke(CHANNELS.interrupt, sessionId),
  answerApproval: (sessionId, approvalId, answer) => ipcRenderer.invoke(CHANNELS.answerApproval, sessionId, approvalId, answer),
  answerQuestion: (sessionId, questionId, answers) => ipcRenderer.invoke(CHANNELS.answerQuestion, sessionId, questionId, answers),
  setModel: (sessionId, model) => ipcRenderer.invoke(CHANNELS.setModel, sessionId, model),
  setMode: (sessionId, mode) => ipcRenderer.invoke(CHANNELS.setMode, sessionId, mode),
  moveHere: (sessionId) => ipcRenderer.invoke(CHANNELS.moveHere, sessionId),
  projectChat: cwd => ipcRenderer.invoke(CHANNELS.projectChat, cwd),
  projectTask: (cwd, text, images) => ipcRenderer.invoke(CHANNELS.projectTask, cwd, text, images),
  newSession: (req, after) => ipcRenderer.invoke(CHANNELS.newSession, req, after),
  agentInfo: () => ipcRenderer.invoke(CHANNELS.agentInfo),
  startAgent: (text, images) => ipcRenderer.invoke(CHANNELS.startAgent, text, images),
  onOpenSession: (cb) => listen<string>(CHANNELS.onOpenSession, (id) => { if (typeof id === 'string') cb(id); }),
  accounts: () => ipcRenderer.invoke(CHANNELS.accounts),
  onAccountsChanged: (cb) => listen<undefined>(CHANNELS.onAccountsChanged, () => cb()),
  options: (provider, agent) => ipcRenderer.invoke(CHANNELS.options, provider, agent),
  pickFolder: () => ipcRenderer.invoke(CHANNELS.pickFolder),
  preview: (cmd) => ipcRenderer.invoke(CHANNELS.preview, cmd),
  onPreview: (cb) => listen<PreviewState>(CHANNELS.onPreview, cb),
  onPreviewZoom: (cb) => listen<PreviewZoom>(CHANNELS.onPreviewZoom, cb),
  openExternal: (url) => ipcRenderer.invoke(CHANNELS.openExternal, url),
  canOpenInEditor: () => ipcRenderer.invoke(CHANNELS.canOpenInEditor),
  getSettings: () => ipcRenderer.invoke(CHANNELS.getSettings),
  setSettings: (s) => ipcRenderer.invoke(CHANNELS.setSettings, s),
  showHost: (sessionId) => ipcRenderer.invoke(CHANNELS.showHost, sessionId),
  revealFile: (path) => ipcRenderer.invoke(CHANNELS.revealFile, path),
  gitStatus: root => ipcRenderer.invoke(CHANNELS.gitStatus, root),
  gitDiff: (root, file) => ipcRenderer.invoke(CHANNELS.gitDiff, root, file),
  gitAction: (root, action) => ipcRenderer.invoke(CHANNELS.gitAction, root, action),
  listFiles: (root, dir) => ipcRenderer.invoke(CHANNELS.listFiles, root, dir),
  previewFile: (root, file) => ipcRenderer.invoke(CHANNELS.previewFile, root, file),
  importBoardImage: (source) => ipcRenderer.invoke(CHANNELS.importBoardImage, source),
  boardChatImage: (itemId) => ipcRenderer.invoke(CHANNELS.boardChatImage, itemId),
  usage: (period) => ipcRenderer.invoke(CHANNELS.usage, period),
  runOp: (op) => ipcRenderer.invoke(CHANNELS.runOp, op),
  importNoteImage: (name, data) => ipcRenderer.invoke(CHANNELS.importNoteImage, name, data),
  noteChatImage: (noteId, imageId) => ipcRenderer.invoke(CHANNELS.noteChatImage, noteId, imageId),
  clipboardHasImage: () => ipcRenderer.invoke(CHANNELS.clipboardHasImage),
  importClipboardImage: () => ipcRenderer.invoke(CHANNELS.importClipboardImage),
  threadOp: (op) => ipcRenderer.invoke(CHANNELS.threadOp, op),
  permissions: () => ipcRenderer.invoke(CHANNELS.permissions),
  askPermission: (kind) => ipcRenderer.invoke(CHANNELS.askPermission, kind),
};

contextBridge.exposeInMainWorld('canvas', bridge);

// A file's path lives only on this side of the bridge (webUtils); the page asks for it by File.
const files: CanvasFiles = {
  pathForFile: (file) => {
    try {
      return electron.webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
};
contextBridge.exposeInMainWorld('canvasFiles', files);
