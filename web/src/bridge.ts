// The page's access to the main process: window.canvas, set by the app's preload.
import { useEffect, useState } from 'react';
import type { ThreadOp } from '../../shared/threads.ts';
import type { AccountsView } from '../../shared/account.ts';
import type { DirListing, FilePreview } from '../../shared/files.ts';
import type { AppSettings, BoardImageImport, CanvasBridge, CanvasFiles, NewSessionRequest, PreviewCommand, PreviewState, PreviewZoom, ProviderOptions, SettingsPatch } from '../../shared/bridge.ts';
import type { ApprovalAnswer, ChatUpdate, ImageRef, Provider, SessionProvider } from '../../shared/chat.ts';
import type { LayoutOp, Snapshot } from '../../shared/types.ts';
import type { NoteImage } from '../../shared/boardNotes.ts';
import type { RunOp } from '../../shared/runs.ts';
import type { UsagePeriod, UsageSummary } from '../../shared/usage.ts';
import type { PermissionKind, PermissionsView } from '../../shared/permissions.ts';

declare global {
  interface Window { canvas?: CanvasBridge; canvasFiles?: CanvasFiles }
}

/** Absent only when the page is opened outside the app (say, Vite's URL in a browser). */
const canvas: CanvasBridge | undefined = typeof window === 'undefined' ? undefined : window.canvas;

const missing = (): Promise<never> => Promise.reject(new Error('Agent canvas: not running inside the app'));

/** A dropped, pasted or picked file's path on disk; '' when it has none (a pasted screenshot) or
    outside the app. */
export function pathForFile(file: File): string {
  return typeof window === 'undefined' ? '' : window.canvasFiles?.pathForFile(file) ?? '';
}

/** "Show in Finder" for a file sent with a message. */
export function revealFile(path: string): Promise<void> {
  return canvas ? canvas.revealFile(path) : missing();
}

/** The latest snapshot. The main process lives as long as the page, so the link is up while the bridge exists. */
export function useSnapshot(): { snapshot: Snapshot | null; connected: boolean } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => canvas?.onSnapshot(setSnapshot), []);
  return { snapshot, connected: canvas !== undefined };
}

export function layoutOp(op: LayoutOp): Promise<void> {
  return canvas ? canvas.layoutOp(op) : missing();
}

/** A change to the links between sessions and their queued prompts (shared/runs.ts). */
export function runOp(op: RunOp): Promise<void> {
  return canvas ? canvas.runOp(op) : missing();
}

/** An open-threads ticket dismissed, restored or marked done (shared/threads.ts). */
export function threadOp(op: ThreadOp): Promise<void> {
  return canvas ? canvas.threadOp(op) : missing();
}

export function markSeen(ids: string[]): Promise<void> {
  return canvas ? canvas.markSeen(ids) : missing();
}

/** Abort on an interrupted session (Undo with `undo`). */
export function dismissInterruption(sessionId: string, undo = false): Promise<void> {
  return canvas ? canvas.dismissInterruption(sessionId, undo) : missing();
}

export function openExternal(url: string): Promise<void> {
  return canvas ? canvas.openExternal(url) : missing();
}

/** "Show in Terminal": main brings the app the card's session runs in to the front. */
export function showHost(sessionId: string): Promise<void> {
  return canvas ? canvas.showHost(sessionId) : missing();
}

/** One chat's calls. Outside the app every call fails and no update ever comes. */
export const chatBridge = {
  open: (id: string) => (canvas ? canvas.openChat(id) : missing()),
  onChat: (id: string, cb: (u: ChatUpdate) => void): (() => void) => (canvas ? canvas.onChat(id, cb) : () => {}),
  close: (id: string): void => { canvas?.closeChat(id); },
  loadOlder: (id: string) => (canvas ? canvas.loadOlder(id) : missing()),
  send: (id: string, text: string, images: ImageRef[]) => (canvas ? canvas.send(id, text, images) : missing()),
  interrupt: (id: string) => (canvas ? canvas.interrupt(id) : missing()),
  answerApproval: (id: string, approvalId: string, answer: ApprovalAnswer) => (canvas ? canvas.answerApproval(id, approvalId, answer) : missing()),
  answerQuestion: (id: string, questionId: string, answers: Record<string, string>) =>
    (canvas ? canvas.answerQuestion(id, questionId, answers) : missing()),
  setModel: (id: string, model: string) => (canvas ? canvas.setModel(id, model) : missing()),
  setMode: (id: string, mode: string) => (canvas ? canvas.setMode(id, mode) : missing()),
  moveHere: (id: string): Promise<boolean> => (canvas ? canvas.moveHere(id) : missing()),
};

/** The Browser tab's native view and "Open in editor". Outside the app nothing opens. */
export const previewBridge = {
  command: (cmd: PreviewCommand): Promise<PreviewState> => (canvas ? canvas.preview(cmd) : missing()),
  onState: (cb: (s: PreviewState) => void): (() => void) => (canvas ? canvas.onPreview(cb) : () => {}),
  onZoom: (cb: (z: PreviewZoom) => void): (() => void) => (canvas ? canvas.onPreviewZoom(cb) : () => {}),
  canOpenInEditor: (): Promise<boolean> => (canvas ? canvas.canOpenInEditor() : Promise.resolve(false)),
};

/** The New session dialog's calls. */
export const newSessionBridge = {
  projectChat: (cwd: string): Promise<string | null> => canvas ? canvas.projectChat(cwd) : missing(),
  projectTask: (cwd: string, text: string, images: ImageRef[]): Promise<string> => canvas ? canvas.projectTask(cwd, text, images) : missing(),
  options: (provider: SessionProvider, agent?: string): Promise<ProviderOptions> => (canvas ? canvas.options(provider, agent) : missing()),
  pickFolder: (): Promise<string | null> => (canvas ? canvas.pickFolder() : missing()),
  start: (req: NewSessionRequest, after?: string): Promise<string> => (canvas ? canvas.newSession(req, after) : missing()),
};

/** The canvas agent's own calls; once it has a session, its chat goes through chatBridge. */
export const agentBridge = {
  info: (): ReturnType<CanvasBridge['agentInfo']> => (canvas ? canvas.agentInfo() : missing()),
  start: (text: string, images: ImageRef[]): Promise<string> => (canvas ? canvas.startAgent(text, images) : missing()),
  /** The agent's open_session asks for a card; outside the app nothing asks. */
  onOpenSession: (cb: (id: string) => void): (() => void) => (canvas ? canvas.onOpenSession(cb) : () => {}),
};

/** The profile page's calls. */
export const profileBridge = {
  accounts: (): Promise<AccountsView> => (canvas ? canvas.accounts() : missing()),
  onChanged: (cb: () => void): (() => void) => (canvas ? canvas.onAccountsChanged(cb) : () => {}),
  getSettings: (): Promise<AppSettings> => (canvas ? canvas.getSettings() : missing()),
  setSettings: (s: SettingsPatch): Promise<void> => (canvas ? canvas.setSettings(s) : missing()),
  usage: (period: UsagePeriod): Promise<UsageSummary> => (canvas ? canvas.usage(period) : missing()),
};

/** The permissions sheet's calls (web/src/onboarding/). */
export const permissionsBridge = {
  read: (): Promise<PermissionsView> => (canvas ? canvas.permissions() : missing()),
  ask: (kind: PermissionKind): Promise<PermissionsView> => (canvas ? canvas.askPermission(kind) : missing()),
};

export const gitBridge = {
  status: (root: string) => canvas ? canvas.gitStatus(root) : missing(),
  diff: (root: string, file: string) => canvas ? canvas.gitDiff(root, file) : missing(),
  act: (root: string, action: import('../../shared/projectGit.ts').GitAction) => canvas ? canvas.gitAction(root, action) : missing(),
};

/** Read-only access to the zone's folder. */
export const filesBridge = {
  list: (root: string, dir: string): Promise<DirListing> => (canvas ? canvas.listFiles(root, dir) : missing()),
  preview: (root: string, file: string): Promise<FilePreview> => (canvas ? canvas.previewFile(root, file) : missing()),
};

/** Board images: a copy kept in the app's data folder, and an image as a chat takes one. */
export const boardImagesBridge = {
  import: (source: BoardImageImport): Promise<{ file: string; name: string; mime: string }> => (canvas ? canvas.importBoardImage(source) : missing()),
  chatImage: (itemId: string): Promise<{ name: string; mime: string; data: Uint8Array }> => (canvas ? canvas.boardChatImage(itemId) : missing()),
};

/** Note pictures: copies kept in the app's data folder (electron/noteImages.ts), one as a chat
    takes it, and the clipboard's image for "Paste image as note". */
export const notesBridge = {
  importImage: (name: string, data: Uint8Array): Promise<NoteImage> => (canvas ? canvas.importNoteImage(name, data) : missing()),
  chatImage: (noteId: string, imageId: string): Promise<{ name: string; mime: string; data: Uint8Array }> => (canvas ? canvas.noteChatImage(noteId, imageId) : missing()),
  clipboardHasImage: (): Promise<boolean> => (canvas ? canvas.clipboardHasImage() : Promise.resolve(false)),
  importClipboardImage: (): Promise<NoteImage | null> => (canvas ? canvas.importClipboardImage() : Promise.resolve(null)),
};
