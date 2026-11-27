import { catalogProfiles, profileId } from '../shared/modelPolicy.ts';
import { acpAgentList, isAcpAgentId } from '../shared/acp.ts';
import { isAgentConnection } from '../shared/agentConnection.ts';
// Channel names and argument checks shared by the main process and the preload. The preload is
// bundled from this file, so runtime imports must also be sandbox-safe.
import type { CanvasBridge, NewSessionRequest, PreviewCommand, PreviewRect, SettingsPatch } from '../shared/bridge.ts';
import type { ApprovalAnswer, ImageRef, Provider, SessionProvider } from '../shared/chat.ts';
import type { LayoutOp } from '../shared/types.ts';
import { isUsagePeriod, type UsagePeriod } from '../shared/usage.ts';
import { isZoneColor, isZoneIcon } from '../shared/zoneAppearance.ts';
import { isItemOpType, parseItemOp } from '../shared/boardItems.ts';
import { parseNoteOp } from '../shared/boardNotes.ts';
import { parseSlotOp } from '../shared/cardSlots.ts';
import { parseRunOp } from '../shared/runs.ts';
import { isThreadOp, type ThreadOp } from '../shared/threads.ts';
import { isPermissionKind, type PermissionKind } from '../shared/permissions.ts';

type Method = keyof CanvasBridge;

export const BRIDGE_METHODS = [
  'onSnapshot', 'layoutOp', 'markSeen', 'dismissInterruption', 'openChat', 'onChat', 'closeChat', 'loadOlder', 'send', 'interrupt',
  'answerApproval', 'answerQuestion', 'setModel', 'setMode', 'moveHere', 'newSession', 'projectTask', 'projectChat', 'agentInfo', 'startAgent', 'onOpenSession', 'accounts', 'onAccountsChanged',
  'options', 'pickFolder', 'preview', 'onPreview', 'onPreviewZoom', 'openExternal', 'canOpenInEditor', 'getSettings', 'setSettings', 'showHost', 'revealFile', 'listFiles', 'previewFile', 'gitStatus', 'gitDiff', 'gitAction',
  'importBoardImage', 'boardChatImage', 'usage', 'runOp',
  'importNoteImage', 'noteChatImage', 'clipboardHasImage', 'importClipboardImage', 'threadOp', 'permissions', 'askPermission',
] as const satisfies readonly Method[];

// A method added to CanvasBridge but not listed above fails to compile here.
type Unlisted = Exclude<Method, (typeof BRIDGE_METHODS)[number]>;
const allListed: [Unlisted] extends [never] ? true : Unlisted = true;
void allListed;

/** One channel per method. `onSnapshot`, `onChat`, `onPreview`, `onPreviewZoom`, `onOpenSession` and `onAccountsChanged` are pushed by the main process on
    these names (one chat's updates on `canvas:chat:<id>`, see chatChannel); `onSnapshot`'s is also
    invoked once for the current snapshot. */
export const CHANNELS: Record<Method, string> = {
  onSnapshot: 'canvas:snapshot',
  layoutOp: 'canvas:layoutOp',
  markSeen: 'canvas:markSeen',
  dismissInterruption: 'canvas:dismissInterruption',
  openChat: 'canvas:openChat',
  onChat: 'canvas:chat',
  closeChat: 'canvas:closeChat',
  loadOlder: 'canvas:loadOlder',
  send: 'canvas:send',
  interrupt: 'canvas:interrupt',
  answerApproval: 'canvas:answerApproval',
  answerQuestion: 'canvas:answerQuestion',
  setModel: 'canvas:setModel',
  setMode: 'canvas:setMode',
  moveHere: 'canvas:moveHere',
  newSession: 'canvas:newSession',
  projectChat: 'canvas:projectChat',
  projectTask: 'canvas:projectTask',
  agentInfo: 'canvas:agentInfo',
  startAgent: 'canvas:startAgent',
  onOpenSession: 'canvas:openSession',
  accounts: 'canvas:accounts',
  onAccountsChanged: 'canvas:accountsChanged',
  options: 'canvas:options',
  pickFolder: 'canvas:pickFolder',
  preview: 'canvas:preview',
  onPreview: 'canvas:previewState',
  onPreviewZoom: 'canvas:previewZoom',
  openExternal: 'canvas:openExternal',
  canOpenInEditor: 'canvas:canOpenInEditor',
  getSettings: 'canvas:getSettings',
  setSettings: 'canvas:setSettings',
  showHost: 'canvas:showHost',
  revealFile: 'canvas:revealFile',
  gitStatus: 'canvas:gitStatus',
  gitDiff: 'canvas:gitDiff',
  gitAction: 'canvas:gitAction',
  listFiles: 'canvas:listFiles',
  previewFile: 'canvas:previewFile',
  importBoardImage: 'canvas:importBoardImage',
  boardChatImage: 'canvas:boardChatImage',
  usage: 'canvas:usage',
  runOp: 'canvas:runOp',
  importNoteImage: 'canvas:importNoteImage',
  noteChatImage: 'canvas:noteChatImage',
  clipboardHasImage: 'canvas:clipboardHasImage',
  importClipboardImage: 'canvas:importClipboardImage',
  threadOp: 'canvas:threadOp',
  permissions: 'canvas:permissions',
  askPermission: 'canvas:askPermission',
};

/** Longest string and list the page may send; far above anything the canvas produces. */
const MAX_STRING = 4096;
const MAX_IDS = 10_000;
/** A message, or a question's answer, the owner types. */
const MAX_MESSAGE = 200_000;
const MAX_IMAGES = 20;
/** About 7.5 MB of image once decoded. */
const MAX_IMAGE_URL = 10_000_000;
const MAX_ANSWERS = 100;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const APPROVAL_ANSWERS = new Set<string>(['allow', 'allowAlways', 'deny']);

/** The channel one chat's updates are pushed on. */
export const chatChannel = (sessionId: string): string => `${CHANNELS.onChat}:${sessionId}`;
/** Schemes handed to macOS: the web, and the Claude and Codex desktop apps' links. */
const EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:', 'claude:', 'codex:']);
/** "Open in editor": VS Code's link to one file, `vscode://file/<absolute path>`, and nothing else
    of VS Code's (its other links run commands and clone repositories). */
const EDITOR_PREFIX = 'vscode://file/';
/** The preview pane's rectangle in CSS pixels; far above any screen. */
const MAX_COORD = 100_000;

const isString = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_STRING;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isName = (v: unknown): v is string => isString(v) && v !== '';
const isText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_MESSAGE;
const isCoord = (v: unknown): v is number => isNumber(v) && Math.abs(v) <= MAX_COORD;
const isSize = (v: unknown): v is number => isCoord(v) && v >= 0;
const record = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError(`${what} must be an object`);
  return v as Record<string, unknown>;
};

/** A file path in a vscode://file/ link: absolute, with no `.` or `..` step, no query or fragment. */
function editorLink(value: string): string {
  if (value.includes('?') || value.includes('#')) throw new TypeError('an editor link takes no query or fragment');
  let path: string;
  try {
    path = decodeURIComponent(value.slice(EDITOR_PREFIX.length - 1));
  } catch {
    throw new TypeError('not a file path');
  }
  const steps = path.split('/').slice(1);
  if (steps.length === 0 || steps.every((s) => s === '') || steps.some((s) => s === '.' || s === '..') || path.includes('\0')) {
    throw new TypeError('an editor link must name an absolute file path');
  }
  return value;
}

function images(value: unknown): ImageRef[] {
  if (!Array.isArray(value) || value.length > MAX_IMAGES) throw new TypeError(`images must be a list of at most ${MAX_IMAGES}`);
  return value.map((v) => {
    const img = record(v, 'image');
    if (typeof img.mime !== 'string' || !IMAGE_TYPES.has(img.mime)) throw new TypeError('images must be PNG, JPEG, GIF or WebP');
    if (typeof img.dataUrl !== 'string' || img.dataUrl.length > MAX_IMAGE_URL || !img.dataUrl.startsWith(`data:${img.mime};base64,`)) {
      throw new TypeError('an image must be a base64 data URL of its type');
    }
    return { mime: img.mime, dataUrl: img.dataUrl };
  });
}

/** Each check returns a fresh value holding only the known fields, or throws. */
export const validate = {
  /** A permission the sheet may ask for (shared/permissions.ts); the pane opened is main's own. */
  permissionKind(v: unknown): PermissionKind {
    if (!isPermissionKind(v)) throw new Error('Unknown permission');
    return v;
  },
  /** A change to the run queue (shared/runs.ts). */
  runOp: parseRunOp,
  threadOp(v: unknown): ThreadOp {
    if (!isThreadOp(v) || !isName(v.id)) throw new TypeError('not an open-threads op');
    return { type: v.type, id: v.id };
  },

  layoutOp(value: unknown): LayoutOp {
    const v = record(value, 'layout op');
    switch (v.type) {
      case 'moveZone':
        if (isString(v.id) && isNumber(v.x) && isNumber(v.y)) return { type: 'moveZone', id: v.id, x: v.x, y: v.y };
        break;
      case 'createZone':
        if (isString(v.name)) return { type: 'createZone', name: v.name };
        break;
      case 'renameZone':
        if (isString(v.id) && isString(v.name)) return { type: 'renameZone', id: v.id, name: v.name };
        break;
      case 'editZone':
        if (isString(v.id) && isString(v.name) && isZoneColor(v.color) && isZoneIcon(v.icon)) {
          return { type: 'editZone', id: v.id, name: v.name, color: v.color, icon: v.icon };
        }
        break;
      case 'deleteZone':
        if (isString(v.id)) return { type: 'deleteZone', id: v.id };
        break;
      case 'hideZone':
        if (isString(v.id) && (v.at === null || isNumber(v.at))) return { type: 'hideZone', id: v.id, at: v.at };
        break;
      case 'addFolderZone':
        if (isName(v.path) && v.path.startsWith('/') && !v.path.includes('\0')) return { type: 'addFolderZone', path: v.path };
        break;
      case 'assign':
        if (isString(v.sessionId) && (v.zoneId === null || isString(v.zoneId))) {
          return { type: 'assign', sessionId: v.sessionId, zoneId: v.zoneId };
        }
        break;
      default: {
        // Board items (images): checked in shared/boardItems.ts.
        const item = isItemOpType(v.type) ? parseItemOp(v) : null;
        if (item) return item;
        const note = parseNoteOp(v);
        if (note) return note;
        // Card slots: checked in shared/cardSlots.ts.
        const slots = v.type === 'setSlots' ? parseSlotOp(v) : null;
        if (slots) return slots;
      }
    }
    throw new TypeError('unknown or malformed layout op');
  },

  markSeen(value: unknown): string[] {
    if (Array.isArray(value) && value.length <= MAX_IDS && value.every(isString)) return [...value];
    throw new TypeError('ids must be a list of strings');
  },

  openExternal(value: unknown): string {
    if (!isString(value)) throw new TypeError('url must be a string');
    if (value.startsWith(EDITOR_PREFIX)) return editorLink(value);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError('not a URL');
    }
    if (!EXTERNAL_SCHEMES.has(url.protocol)) throw new TypeError(`${url.protocol} links are not opened`);
    return value;
  },

  preview(value: unknown): PreviewCommand {
    const v = record(value, 'preview command');
    switch (v.kind) {
      case 'show': {
        if (v.bounds === null) return { kind: 'show', bounds: null };
        const rect = (raw: unknown): PreviewRect => {
          const b = record(raw, 'bounds');
          if (!isCoord(b.x) || !isCoord(b.y) || !isSize(b.width) || !isSize(b.height)) throw new TypeError('bounds must be a rectangle on screen');
          return { x: b.x, y: b.y, width: b.width, height: b.height };
        };
        if (v.zoom !== undefined && (!isNumber(v.zoom) || v.zoom < 0.25 || v.zoom > 3)) throw new TypeError('invalid preview zoom');
        return { kind: 'show', bounds: rect(v.bounds), ...(v.clip === undefined ? {} : { clip: rect(v.clip) }),
          ...(v.zoom === undefined ? {} : { zoom: v.zoom }) };
      }
      case 'navigate':
        if (!isName(v.url)) throw new TypeError('url must be a non-empty string');
        if (typeof v.typed !== 'boolean') throw new TypeError('navigate must say whether the address was typed');
        if (v.fresh !== undefined && typeof v.fresh !== 'boolean') throw new TypeError('fresh must be true or false');
        return v.fresh === true ? { kind: 'navigate', url: v.url, typed: v.typed, fresh: true } : { kind: 'navigate', url: v.url, typed: v.typed };
      case 'back':
      case 'reload':
      case 'clear':
        return { kind: v.kind };
    }
    throw new TypeError('unknown preview command');
  },

  usagePeriod(value: unknown): UsagePeriod {
    if (isUsagePeriod(value)) return value;
    throw new TypeError('usage period must be today, 7d, 30d or all');
  },

  sessionId(value: unknown): string {
    if (isName(value)) return value;
    throw new TypeError('session id must be a non-empty string');
  },

  /** A model, a permission mode, or an approval or question id. */
  choice(value: unknown): string {
    if (isName(value)) return value;
    throw new TypeError('must be a non-empty string');
  },

  message(text: unknown, imageList: unknown): { text: string; images: ImageRef[] } {
    if (!isText(text)) throw new TypeError(`a message must be a string of at most ${MAX_MESSAGE} characters`);
    return { text, images: images(imageList) };
  },

  approvalAnswer(value: unknown): ApprovalAnswer {
    if (typeof value === 'string' && APPROVAL_ANSWERS.has(value)) return value as ApprovalAnswer;
    throw new TypeError('answer must be allow, allowAlways or deny');
  },

  answers(value: unknown): Record<string, string> {
    const entries = Object.entries(record(value, 'answers'));
    if (entries.length > MAX_ANSWERS || !entries.every(([k, a]) => isString(k) && isText(a))) throw new TypeError('answers must map questions to strings');
    return Object.fromEntries(entries) as Record<string, string>;
  },

  newSession(value: unknown): NewSessionRequest {
    const v = record(value, 'new session');
    if (v.provider !== 'claude' && v.provider !== 'codex' && v.provider !== 'acp') throw new TypeError('provider must be claude, codex or acp');
    // An ACP session names its agent; the engine checks that it is one in Settings.
    if (v.provider === 'acp' && !isAcpAgentId(v.agent)) throw new TypeError('an ACP session needs an agent id');
    if (!isName(v.cwd) || !v.cwd.startsWith('/')) throw new TypeError('cwd must be an absolute path');
    if (v.model !== null && !isName(v.model)) throw new TypeError('model must be a name or null');
    if (v.mode !== null && !isName(v.mode)) throw new TypeError('mode must be a name or null');
    // Absent from an older page: the model's own default.
    const effort = v.effort ?? null;
    if (effort !== null && !isName(effort)) throw new TypeError('effort must be a name or null');
    const { text, images: imgs } = validate.message(v.text, v.images);
    if (text.trim() === '' && imgs.length === 0) throw new TypeError('a new session needs a first message');
    return { provider: v.provider, cwd: v.cwd, model: v.model, effort, mode: v.mode, text, images: imgs, ...(v.provider === 'acp' ? { agent: v.agent as string } : {}) };
  },

  /** The first message to the canvas agent: text, images, or both, but not nothing. */
  agentMessage(text: unknown, imageList: unknown): { text: string; images: ImageRef[] } {
    const m = validate.message(text, imageList);
    if (m.text.trim() === '' && m.images.length === 0) throw new TypeError('the agent needs a first message');
    return m;
  },

  /** New session's options: a built-in provider, or 'acp' with an agent id. */
  options(provider: unknown, agent: unknown): { provider: SessionProvider; agent?: string } {
    if (provider === 'acp') {
      if (isAcpAgentId(agent)) return { provider, agent };
      throw new TypeError('an ACP agent id is needed');
    }
    return { provider: validate.provider(provider) };
  },

  provider(value: unknown): Provider {
    if (value === 'claude' || value === 'codex') return value;
    throw new TypeError('provider must be claude or codex');
  },

  /** "Show in Terminal": the card's id and nothing else. Main finds the session's process and
      its app itself; a path from the page is never opened. */
  showHost(args: unknown[]): string {
    if (args.length !== 1) throw new TypeError('Show in takes only the card id');
    return validate.sessionId(args[0]);
  },

  /** A file sent with a message, to show in Finder: an absolute path with no `.`/`..` step. Finder
      only selects it; nothing is opened or run. */
  filePath(value: unknown): string {
    if (!isName(value) || !value.startsWith('/') || value.includes('\0')) throw new TypeError('not an absolute file path');
    const steps = value.split('/').slice(1);
    if (steps.every((s) => s === '') || steps.some((s) => s === '.' || s === '..')) throw new TypeError('not an absolute file path');
    return value;
  },

  /** The app main brings to the front for "Show in": an absolute `.app` folder, no `.`/`..` step. */
  appBundle(value: unknown): string {
    if (!isName(value) || !value.startsWith('/') || !value.endsWith('.app') || value.includes('\0')) throw new TypeError('not an app bundle');
    if (value.split('/').some((s) => s === '.' || s === '..')) throw new TypeError('not an app bundle');
    return value;
  },

  /** A call that takes nothing from the page (the folder picker). */
  noArgs(args: unknown[]): void {
    if (args.length > 0) throw new TypeError('this call takes no arguments');
  },

  /** The folder picker's answer: one absolute folder, or null when cancelled. */
  pickedFolder(result: { canceled: boolean; filePaths: string[] }): string | null {
    const picked = result.filePaths[0];
    return !result.canceled && typeof picked === 'string' && picked.startsWith('/') ? picked : null;
  },

  /** Only the parts given change; each provider's part is checked whole. */
  settings(value: unknown): SettingsPatch {
    const v = record(value, 'settings');
    const out: SettingsPatch = {};
    if (v.agentConnection !== undefined) {
      if (!isAgentConnection(v.agentConnection)) throw new TypeError('Unknown canvas agent connection');
      out.agentConnection = v.agentConnection;
    }
    if (v.agentKey !== undefined) {
      const entry = record(v.agentKey, 'agentKey');
      const provider = validate.provider(entry.provider);
      if (typeof entry.key !== 'string' || !/^[!-~]{1,2048}$/.test(entry.key)) throw new TypeError('Enter a valid API key');
      out.agentKey = { provider, key: entry.key };
    }
    if (v.openAtLogin !== undefined) {
      if (typeof v.openAtLogin !== 'boolean') throw new TypeError('openAtLogin must be true or false');
      out.openAtLogin = v.openAtLogin;
    }
    if (v.limitReset !== undefined) {
      if (v.limitReset !== 'ask' && v.limitReset !== 'continue') throw new TypeError('limitReset must be ask or continue');
      out.limitReset = v.limitReset;
    }
    if (v.defaults !== undefined) {
      const d = record(v.defaults, 'defaults');
      out.defaults = {};
      for (const [provider, value] of Object.entries(d)) {
        const p = validate.provider(provider);
        const x = record(value, 'defaults');
        if ((x.model !== null && !isName(x.model)) || (x.effort !== null && !isName(x.effort))) {
          throw new TypeError('a default model and thinking level must be names or null');
        }
        out.defaults[p] = { model: x.model, effort: x.effort };
      }
    }
    if (v.modelPermissions !== undefined) {
      const choices = record(v.modelPermissions, 'modelPermissions');
      out.modelPermissions = {};
      for (const [provider, ids] of Object.entries(choices)) {
        if (provider !== 'claude' && provider !== 'codex') throw new TypeError('Unknown model provider');
        const known = catalogProfiles(provider).map(profileId);
        if (!Array.isArray(ids) || !ids.length || !ids.every(id => typeof id === 'string' && known.includes(id))) {
          throw new TypeError('Enable at least one supported model and thinking level');
        }
        out.modelPermissions[provider] = [...new Set(ids as string[])];
      }
    }
    if (v.shownModels !== undefined) {
      const m = record(v.shownModels, 'shownModels');
      out.shownModels = {};
      for (const [provider, list] of Object.entries(m)) {
        const p = validate.provider(provider);
        if (list !== null && !(Array.isArray(list) && list.length <= MAX_IDS && list.every(isName))) {
          throw new TypeError('shown models must be a list of model ids or null');
        }
        out.shownModels[p] = list === null ? null : [...new Set(list as string[])];
      }
    }
    if (v.acpAgents !== undefined) out.acpAgents = acpAgentList(v.acpAgents);
    return out;
  },
};
