// The app: one window showing the canvas, the Dock badge, open-at-login, the chat engines, and the
// IPC handlers behind window.canvas. `electron dist-electron/main.js [--demo | --demo=large]`.
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, net, Notification, powerMonitor, protocol, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSource, type RunningSource } from '../server/main.ts';
import { AGENT_CONNECTIONS, agentDirectory, type AgentConnection } from '../shared/agentConnection.ts';
import { hasAgentKey, keyLookup, readAgentKey, saveAgentKey } from './agentKeys.ts';
import { agentExtras, agentFolder } from '../server/agent/agent.ts';
import { findFolders } from '../server/agent/folders.ts';
import { projectFolders } from '../server/agent/projectFolders.ts';
import { ProjectHandoffs, projectProfile, type ProjectActions, type ProjectProfile } from '../server/agent/project.ts';
import { AttachmentStore, workerMessage, orchestratorMessage, type Attachment } from '../server/agent/taskAttachments.ts';
import type { CanvasApi, TaskRequest } from '../server/agent/tools.ts';
import { DEMO_AGENT_CWD, demoEngine, demoFolderKind, type DemoVariant } from '../server/demo.ts';
import { ClaudeEngine } from '../server/engines/claude/engine.ts';
import { CodexEngine } from '../server/engines/codex/engine.ts';
import type { ChatEngine, Engine, StartOptions } from '../server/engines/engine.ts';
import { AcpEngine } from '../server/engines/acp/engine.ts';
import { AcpRecords } from '../server/engines/acp/records.ts';
import { findProgram } from '../server/engines/acp/which.ts';
import { ACP_PREFIX, ACP_PRESETS, acpCardId, isAcpCardId, showsInNewSession, type AcpAgentConfig, type AcpAgentView } from '../shared/acp.ts';
import { SessionsFile } from '../server/sessionsFile.ts';
import { SettingsFile } from '../server/settingsFile.ts';
import { applyDefaults } from '../shared/settings.ts';
import { allowedProfiles, catalogProfiles, chooseProfile, profileId, restrictOptions } from '../shared/modelPolicy.ts';
import type { AppSettings, NewSessionRequest } from '../shared/bridge.ts';
import type { ImageRef, Provider } from '../shared/chat.ts';
import type { SessionView, Snapshot } from '../shared/types.ts';
import { gatherAccounts } from './accounts.ts';
import { createProjectGit } from './projectGit.ts';
import { canvasRoots, createProjectFiles } from './files.ts';
import { serveChatMedia } from './chatMedia.ts';
import { createBoardImages, watchBoardFiles, type BoardImages } from './boardImages.ts';
import { createNoteImages, type NoteImages } from './noteImages.ts';
import { existsSync as fileExists, watchFile, unwatchFile } from 'node:fs';
import { ChatHub } from './chats.ts';
import { checkStart, folderKind } from './newSession.ts';
import { BRIDGE_METHODS, CHANNELS, chatChannel, validate } from './ipc.ts';
import { childEnv, dataPaths, demoProfile, devPageUrl, findCodex, installedCodexPaths, loginShellFacts, resolveAppFile, type ShellFacts } from './paths.ts';
import { checkPreviewUrl, PreviewController, previewPartition } from './preview.ts';
import { previewSurfaces, restrictPreviewGuests } from './previewSurface.ts';
import { SignInWatch } from './signIn.ts';
import { QuitFlow, type BusySession } from './quit.ts';
import { showHost } from './showHost.ts';
import { appBundleId, notificationState, readNotificationPrefs, settingsPane } from './permissions.ts';
import { parsePermissionsView, type PermissionsView } from '../shared/permissions.ts';
import { processTable } from '../server/engines/host.ts';
import { busyElsewhere, isBlockingBanner } from '../shared/banners.ts';
import { RunStore } from '../server/runs/store.ts';
import { ThreadStore } from '../server/threads/store.ts';
import { ThreadScanner } from '../server/threads/scan.ts';
import { createJudge } from '../server/threads/judge.ts';
import { demoThreads } from '../server/threads/demo.ts';
import { realSdk } from '../server/engines/claude/sdk.ts';
import { RunScheduler, NotYet } from '../server/runs/scheduler.ts';
import { LimitResets, resetNotice } from '../server/limitResets.ts';
import type { RunsApi } from '../server/runs/api.ts';
import { planId } from '../shared/runs.ts';
import { checkUpstreams } from '../server/agent/linkTools.ts';
import { UsageStore } from '../server/usage/store.ts';
import { demoUsageSummary } from '../server/usage/demo.ts';
import type { UsagePeriod, UsageSummary } from '../shared/usage.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(here, '../web/dist');
const PRELOAD = path.join(here, 'preload.cjs');
/** The packaged page is served from its own scheme, so 'self' in the CSP means exactly its files. */
const SCHEME = 'app';
const APP_ORIGIN = `${SCHEME}://canvas`;
/** Set by `npm run dev`: the page comes from Vite instead, with hot reload (loopback only, never
    in a packaged app). */
const DEV_URL = devPageUrl(process.env.VITE_DEV_URL, app.isPackaged);
const PAGE_ORIGIN = DEV_URL === null ? APP_ORIGIN : `${new URL(DEV_URL).protocol}//${new URL(DEV_URL).host}`;

const CSP_BASE = [
  "default-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: canvas-media: https:", "media-src 'self' data: canvas-media: https:", "font-src 'self' data:",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
];
const CSP = [...CSP_BASE, "script-src 'self'", "connect-src 'self'"].join('; ');
/** Dev only: Vite's React preamble is an inline script, and hot reload talks over a websocket. */
const devCsp = (origin: string) =>
  [...CSP_BASE, "script-src 'self' 'unsafe-inline'", `connect-src 'self' ${origin.replace(/^http/, 'ws')}`].join('; ');

const argv = process.argv.slice(1);
const demo: DemoVariant | null = argv.includes('--demo=large') ? 'large' : argv.includes('--demo') ? 'mockup' : null;
// Test-only: AGENT_CANVAS_HIDDEN=1 (set by the e2e runs) keeps every window hidden and out of
// the Dock, so a test run never shows a window, takes focus or bounces the Dock. The page still
// paints and runs at full speed, so screenshots and timers work.
const hidden = process.env.AGENT_CANVAS_HIDDEN === '1';
/** Test-only: AGENT_CANVAS_DEMO_TURNS=1 makes the demo's cards follow their scripted turns (working,
    waiting on the approval, finished), so the links e2e test can see a card finish. */
const demoTurns = demo !== null && process.env.AGENT_CANVAS_DEMO_TURNS === '1';
if (hidden) app.dock?.hide();
/** Shows the window, unless this is a hidden test run. */
const reveal = (w: BrowserWindow | null | undefined): void => { if (!hidden) w?.show(); };
// The demo keeps its page state (localStorage, Chromium's caches) in a throwaway profile, never
// the real app's; it is set before ready and removed on the way out. app.exit() skips will-quit
// and Node's exit event, so every exit goes through exitApp.
let removeDemoProfile = (): void => {};
if (demo !== null) {
  const profile = demoProfile();
  app.setPath('userData', profile.dir);
  app.setPath('sessionData', profile.dir);
  removeDemoProfile = profile.remove;
  app.on('will-quit', () => profile.remove());
  process.on('exit', () => profile.remove());
  // A killed test worker cannot run its teardown. A hidden demo keeps painting even
  // without a window, so release its renderer and throwaway profile when orphaned.
  if (hidden) {
    setInterval(() => { if (process.ppid === 1) exitApp(0); }, 5_000).unref();
  }
}
function exitApp(code: number): void {
  try { removeDemoProfile(); } catch { /* best effort: it is under the temp folder */ }
  app.exit(code);
}
/** The local address the demo's test run prints, for the Browser tab: AGENT_CANVAS_DEMO_URL when
    it is one that may open by itself (the e2e test serves a page there), else the demo's own. */
function demoPreviewUrl(): string | undefined {
  try {
    return checkPreviewUrl(process.env.AGENT_CANVAS_DEMO_URL ?? '', false);
  } catch {
    return undefined;
  }
}

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'canvas-media', privileges: { standard: true, secure: true, stream: true } }]);
app.setName('Agent canvas');

const CODEX_PREFIX = 'codex:';

let win: BrowserWindow | null = null;
let running: RunningSource | null = null;
/** The built-in providers' engines and the one for the ACP agents in Settings. */
type Engines = Record<Provider, Engine> & { acp: AcpEngine };
let engines: Engines | null = null;
/** The owner's settings, once loaded (the ACP engine reads its agents from them). */
let settingsFile: SettingsFile | null = null;
/** Where the ACP agents' commands are looked for: the login shell's PATH. */
let acpPath = process.env.PATH ?? '';
let preview: PreviewController | null = null;
let boardImages: BoardImages | null = null;
/** Notes' pictures (noteImages.ts): set up with the board images. */
let noteImages: NoteImages | null = null;
/** The clipboard's first image (a screenshot, a copied picture), or null when it holds none. */
async function clipboardImage(): Promise<Blob | null> {
  for (const item of await clipboard.read()) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type) return (await item.getType(type)) as Blob;
  }
  return null;
}
/** Settings → Usage and get_usage_summary: the live store over the transcripts, or the demo's. Set in start(). */
let usage: { summary(period: UsagePeriod): Promise<UsageSummary> } | null = null;
let scheduler: RunScheduler | null = null;
let readSnapshot: (() => Snapshot) | null = null;
/** Open threads (server/threads): the questions left in chats the owner moved on from, and the scan that finds them. */
let threads: ThreadStore | null = null;
let threadScanner: ThreadScanner | null = null;
let quitting = false;
/** Demo mode's "Open at login": kept in memory, so the real login item is never touched. */
let demoOpenAtLogin = false;

/** Serves web/dist; nothing outside it. */
async function serveApp(request: Request): Promise<Response> {
  const file = resolveAppFile(WEB_ROOT, request.url);
  if (file === null) return new Response('Not found', { status: 404 });
  let res: Response;
  try {
    res = await net.fetch(pathToFileURL(file).toString());
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const headers = new Headers(res.headers);
  headers.set('content-security-policy', CSP);
  headers.set('x-content-type-options', 'nosniff');
  return new Response(res.body, { status: res.status, headers });
}

// Compared by scheme and host: URL gives a custom scheme's origin as "null".
const isAppUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}` === PAGE_ORIGIN;
  } catch {
    return false;
  }
};

/** Hands a link to macOS when it is one the canvas may open; anything else is dropped. */
function openOutside(url: string): void {
  try {
    shell.openExternal(validate.openExternal(url)).catch(() => { /* no app for it */ });
  } catch { /* not a link we open */ }
}

/** The Browser tab's view, added over the window's page and placed by the page. */
function createPreview(w: BrowserWindow): PreviewController {
  return new PreviewController({
    ...previewSurfaces(w, here, event => { if (!w.isDestroyed()) w.webContents.send(CHANNELS.onPreviewZoom, event); }),
    openExternal: openOutside,
    scale: () => w.webContents.getZoomFactor(),
    changed: (state) => { if (!w.isDestroyed()) w.webContents.send(CHANNELS.onPreview, state); },
  }, previewPartition(demo !== null));
}

/** The Dock badge: the cards that need the owner, and the canvas agent when it waits on an
    approval or a question (its finished replies are read in its own panel, not counted). */
function waitingCount(s: Snapshot): number {
  const agentWaits = s.agent?.state === 'needs_you' && (s.agent.need === 'permission' || s.agent.need === 'question');
  return s.sessions.filter((x) => x.state === 'needs_you').length + (agentWaits ? 1 : 0);
}

/** A card by its id; the canvas agent's session counts as one here, though it is drawn as none. */
function cardOf(s: Snapshot, cardId: string): SessionView | undefined {
  return s.sessions.find((x) => x.id === cardId) ?? (s.agent?.id === cardId ? s.agent : undefined);
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700,
    title: 'Agent canvas',
    titleBarStyle: 'hiddenInset',
    // Centres the traffic lights in the 44 px top bar.
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0f0f0f',
    show: false,
    // A hidden test run still paints, and its timers and frames are not throttled.
    paintWhenInitiallyHidden: true,
    webPreferences: {
      backgroundThrottling: !hidden,
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  w.once('ready-to-show', () => reveal(w));
  w.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  // The page never leaves itself; "Open in Claude" style links go to macOS instead.
  w.webContents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    openOutside(url);
  });
  // Closing hides: the app keeps running in the Dock and the canvas stays current.
  w.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    w.hide();
  });
  void (DEV_URL === null ? w.loadURL(`${APP_ORIGIN}/index.html`) : w.loadURL(DEV_URL));
  return w;
}

/** Every call must come from the canvas page in our window. */
function trusted(e: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return win !== null && e.sender === win.webContents && e.senderFrame !== null && isAppUrl(e.senderFrame.url);
}

/** The engine for a card is chosen by its provider; Codex engines know a thread by its bare id. */
function router(source: RunningSource['source'], all: Engines) {
  return (cardId: string): { engine: ChatEngine; engineId: string } => {
    // An ACP agent's card: the ACP engine knows it by its record id.
    if (isAcpCardId(cardId)) return { engine: all.acp, engineId: cardId.slice(ACP_PREFIX.length) };
    const card = cardOf(source.snapshot(), cardId);
    const provider: Provider = card && card.provider !== 'acp' ? card.provider : cardId.startsWith(CODEX_PREFIX) ? 'codex' : 'claude';
    return { engine: all[provider], engineId: provider === 'codex' && cardId.startsWith(CODEX_PREFIX) ? cardId.slice(CODEX_PREFIX.length) : cardId };
  };
}

const logSaveError = (err: unknown) => { process.stderr.write(`agent-canvas: sessions.json not saved: ${(err as Error).message}\n`); };

// The permissions sheet (electron/permissions.ts). The demo starts nothing real, so it reports
// everything allowed, or AGENT_CANVAS_DEMO_PERMISSIONS (the e2e test's) when that is given.
const bundleId = app.isPackaged ? appBundleId(app.getPath('exe')) : Promise.resolve(null);
const demoPermissions: PermissionsView | null = demo === null ? null
  : parsePermissionsView(process.env.AGENT_CANVAS_DEMO_PERMISSIONS) ?? { notifications: 'on' };
/** A test notification this run that macOS refused (an unsigned build cannot post them). */
let notificationFailed = false;
async function permissionsNow(): Promise<PermissionsView> {
  if (demoPermissions) return demoPermissions;
  const [notifications, claudeCli] = await Promise.all([
    notificationState({ supported: Notification.isSupported(), bundleId: await bundleId, readPrefs: readNotificationPrefs, failed: notificationFailed }),
    findProgram('claude', acpPath),
  ]);
  return { notifications, claudeCliInstalled: claudeCli !== null };
}
/** Posts one notification, so macOS asks whether to allow them; settles once it shows or fails. */
function testNotification(): Promise<void> {
  if (demoPermissions) {
    if (demoPermissions.notifications === 'not-asked') demoPermissions.notifications = 'on';
    return Promise.resolve();
  }
  if (hidden || !Notification.isSupported()) return Promise.resolve();
  return new Promise((resolve) => {
    const n = new Notification({ title: 'Notifications are on', body: 'Agent canvas will tell you here when a session needs you.' });
    const timer = setTimeout(resolve, 4_000);
    n.once('show', () => { clearTimeout(timer); resolve(); });
    n.once('failed', () => { notificationFailed = true; clearTimeout(timer); resolve(); });
    n.show();
  });
}

/** The canvas agent's folder (invented in the demo, which starts nothing real). */
const agentCwd = demo !== null ? DEMO_AGENT_CWD : agentFolder(dataPaths().dataHome);
/** Images and files handed on with tasks, copied here so a vanished temp file cannot lose them. */
const attachmentStore = new AttachmentStore(path.join(dataPaths().dataHome, 'attachments'));
/** The agent conversations started in this run, for the quit dialog's wording. */
const agentIds = new Set<string>();
/** Set once the sessions file is loaded: starts a session as the New session dialog does. */
let delegateTask: ((req: TaskRequest) => Promise<string>) | null = null;
let projectFor: (id: string) => ProjectProfile | undefined = () => undefined;

/** What the agent's tools reach of the app. It is built before the store and the engines exist
    (the Claude engine needs it), so each call looks them up when it is made. */
const canvasApi: CanvasApi = {
  snapshot: () => {
    if (running === null) throw new Error('Agent canvas is still starting');
    return readSnapshot?.() ?? running.source.snapshot();
  },
  applyLayout: (op) => {
    if (running === null) throw new Error('Agent canvas is still starting');
    running.source.applyLayout(validate.layoutOp(op));
  },
  startSession: (req) => {
    if (!delegateTask) throw new Error('Agent canvas is still starting');
    return delegateTask(req);
  },
  findFolders: (query, limit) => findFolders(query, limit),
  folderKind: (p) => (demo !== null ? demoFolderKind(p) : folderKind(p)),
  openSession: (id) => {
    if (quitFlow.phase !== 'idle') throw new Error('Agent canvas is quitting, so its window stays closed');
    if (win === null || win.isDestroyed()) throw new Error('Agent canvas has no window open');
    win.webContents.send(CHANNELS.onOpenSession, id);
    if (hidden) return;
    if (win.isMinimized()) win.restore();
    win.show();
    // The owner asked for it, so the app comes to the front over whichever app is active.
    app.focus({ steal: true });
    win.focus();
  },
  keepAttachments: (paths) => attachmentStore.keep(paths),
  // Only the agents shown in New session: the Claude and Codex adapters stay out unless turned on.
  acpAgents: async () => (await acpViews((settingsFile?.get().acpAgents ?? []).filter(showsInNewSession))).map((a) => ({ id: a.id, name: a.name, installed: a.path !== null })),
  usageSummary: (period) => {
    if (usage === null) throw new Error('Agent canvas is still starting');
    return usage.summary(period);
  },
  notes: {
    importFile: (file) => {
      if (noteImages === null) throw new Error('Agent canvas is still starting');
      return noteImages.importFile(file);
    },
  },
  threads: {
    list: () => threads?.list() ?? [],
    apply: (op) => threads?.apply(op) ?? false,
  },
  now: Date.now,
};

function registerIpc(source: RunningSource['source'], all: Engines, sessions: SessionsFile, settings: SettingsFile, store: RunStore): ChatHub {
  const chats = new ChatHub({
    route: router(source, all),
    push: (cardId, u) => { win?.webContents.send(chatChannel(cardId), u); },
    title: (cardId) => cardOf(source.snapshot(), cardId)?.name ?? '',
  });
  const policyOn = demo === null || process.env.AGENT_CANVAS_DEMO_MODEL_POLICY === '1';
  const profiles = async (provider: Provider) =>
    allowedProfiles(provider, settings.get().modelPermissions?.[provider]);
  const optionsFor = async (provider: Provider) => {
    const raw = await all[provider].options();
    return policyOn ? restrictOptions(provider, raw, await profiles(provider), settings.get().defaults[provider])
      : applyDefaults(raw, settings.get().defaults[provider]);
  };
  const resolved = async (provider: Provider, model: string | null, effort: string | null) =>
    chooseProfile(provider, await profiles(provider), settings.get().defaults[provider], { model, effort });

  /** A new session, from the New session dialog or the agent's start_task: the card id. */
  const start = async (req: NewSessionRequest, options?: StartOptions): Promise<string> => {
    // A folder that is gone, or a provider that cannot start (signed out, missing): the dialog
    // says so and stays open. Demo folders are invented, so the demo has its own stand-in.
    await checkStart(req.cwd, options?.project?.connection === 'claude-api' ? { banner: null } : all[req.provider], demo !== null ? demoFolderKind : folderKind);
    if (policyOn && req.provider !== 'acp') {
      const { model, effort } = await resolved(req.provider, req.model, req.effort);
      req = { ...req, model, effort };
    }
    const id = await all[req.provider].start(req, options);
    const cardId = req.provider === 'codex' ? CODEX_PREFIX + id : req.provider === 'acp' ? acpCardId(id) : id;
    // An ACP card comes from the engine's own records (it said so through onChange).
    if (req.provider !== 'acp') running?.started?.({ id: cardId, provider: req.provider, cwd: req.cwd, title: options?.title, text: req.text, at: Date.now() });
    // The ACP engine keeps its own records of the sessions it started.
    (req.provider === 'acp' ? Promise.resolve() : sessions.recordStarted({ id: cardId, provider: req.provider, cwd: req.cwd, startedAt: Date.now() }))
      .then(() => sessions.setSettings(cardId, { model: req.model, mode: req.mode, effort: req.effort }))
      .catch(logSaveError);
    return cardId;
  };
  /** The engine and its id for a card the page names. */
  const target = (id: unknown) => {
    const cardId = validate.sessionId(id);
    return { cardId, ...chats.route(cardId) };
  };
  /** The model and mode the owner last picked for this chat, applied when it opens. */
  const restore = async (cardId: string) => {
    const saved = sessions.settings(cardId);
    const state = chats.state(cardId);
    const { engine, engineId } = chats.route(cardId);
    if (!state) return;
    if (policyOn && engine.provider !== 'acp' && engine.setModelProfile) {
      if (state.turn !== 'running' && (state.owner !== 'elsewhere' || engine.provider === 'claude')) {
        const available = await profiles(engine.provider);
        const selected = available.find(p => p.model === (saved.model ?? state.model) && p.effort === (saved.effort ?? state.effort))
          ?? chooseProfile(engine.provider, available, settings.get().defaults[engine.provider]);
        await engine.setModelProfile(engineId, selected.model, selected.effort);
      }
    } else if (saved.model !== null && saved.model !== state.model) await engine.setModel(engineId, saved.model).catch(() => {});
    // Codex shows Auto for a chat opened read-only (its sandbox is known only once resumed): a
    // saved pick is applied even when it reads the same, so it binds; with none saved, the thread
    // keeps its own sandbox (Full access stays Full access).
    if (saved.mode !== null && (saved.mode !== state.mode || engine.provider === 'codex')) await engine.setMode(engineId, saved.mode).catch(() => {});
  };

  const demoKeys: Record<Provider, boolean> = { claude: false, codex: false };
  const hasKey = (p: Provider) => demo !== null ? Promise.resolve(demoKeys[p]) : hasAgentKey(p);
  const agentStatus = async (connection: AgentConnection) => {
    const provider = connection === 'codex-api' ? 'codex' : 'claude';
    const banner = connection === 'claude-api' ? null : all[provider].banner;
    const missing = connection !== 'claude-login' && !await hasKey(provider);
    const reason = missing ? `Add your ${AGENT_CONNECTIONS[connection]} key in Profile to start a conversation.`
      : banner && isBlockingBanner(banner) ? banner : null;
    return { provider, reason } as const;
  };

  const sendToChat = async (id: string, text: string, images: ImageRef[], worker = false) => {
    const state = await chats.open(id);
    try {
      const { engine, engineId } = chats.route(id);
      if (worker && (state.owner === 'elsewhere' || state.turn === 'running' || engine.busy().some(s => s.sessionId === engineId))) {
        throw new NotYet('This worker is active or open in another app.');
      }
      if (!worker && state.owner === 'elsewhere') throw new Error('Close the orchestrator in the other app before delegating to it.');
      await restore(id);
      await engine.send(engineId, text, images);
    } finally { chats.close(id); }
  };
  const runs: RunsApi = {
    views: () => scheduler?.views() ?? [],
    maxRunning: () => store.maxRunning(),
    apply: (op, by) => store.apply(op, by),
    queue: draft => store.queue(draft),
  };
  canvasApi.runs = runs;
  const actions: ProjectActions = {
    runs,
    sessions: () => source.snapshot().sessions,
    folders: folder => demo !== null ? Promise.resolve([path.resolve(folder)]) : projectFolders(folder),
    isOrchestrator: id => !!sessions.role(id),
    options: async (p, agent) => p === 'acp' ? all.acp.options(agent) : optionsFor(p),
    validateWorkerProfile: async req => { if (policyOn && req.provider !== "acp") await resolved(req.provider, req.model, req.effort); },
    create: (req, title) => start(validate.newSession(req), { title }),
    send: (id, text, images) => sendToChat(id, text, images, true),
    rename: async (id, title) => {
      const { engine, engineId } = chats.route(id);
      if (!engine.rename) throw new Error('This provider cannot rename chats.');
      await engine.rename(engineId, title);
    },
    attachments: paths => attachmentStore.keep(paths),
  };
  projectFor = id => {
    const role = sessions.role(id);
    return role && projectProfile(role, actions);
  };
  const handoffs = new ProjectHandoffs();
  const delegate = async (cwd: string, text: string, images: ImageRef[], attachments: Attachment[] = []) => {
    const [folder] = await actions.folders(cwd);
    if (!folder) throw new Error('Choose a project folder.');
    if (folder === agentCwd || folder.startsWith(agentCwd + path.sep)) throw new Error('Choose a project folder.');
    const checkout = demo === null ? await fs.realpath(cwd) : cwd;
    // Pasted images are kept as files too, so the orchestrator can hand them on by path.
    const { text: brief, images: shown } = await orchestratorMessage(checkout === folder ? text : `Requested checkout: ${checkout}\n\n${text}`,
      [...await attachmentStore.keepImages(images), ...attachments]);
    return handoffs.dispatch(folder, async () => {
      const existing = sessions.project(folder);
      if (existing) {
        await sendToChat(existing.id, brief, shown);
        return existing.id;
      }
      const connection = settings.get().agentConnection;
      const { provider, reason } = await agentStatus(connection);
      if (reason) throw new Error(reason);
      const project = projectProfile({ folder, connection }, actions);
      const id = await start({ provider, cwd: folder, model: null, effort: null, mode: provider === 'codex' ? 'full-access' : 'bypassPermissions', text: brief, images: shown },
        { project, title: `Project orchestrator · ${path.basename(folder) || folder}` });
      await sessions.recordProject({ folder, connection, id });
      win?.webContents.send(CHANNELS.onSnapshot, snapshot());
      return id;
    });
  };
  delegateTask = async req => {
    if (policyOn && (req.provider === 'claude' || req.provider === 'codex') && (req.model !== null || req.effort != null)) {
      await resolved(req.provider, req.model, req.effort ?? null);
    }
    const preferences = Object.entries({ provider: req.provider, model: req.model, effort: req.effort, mode: req.mode }).filter(([,v]) => v);
    const brief = preferences.length ? req.text + '\n\nRequested worker settings: ' + preferences.map(([k,v]) => k + '=' + v).join(', ') : req.text;
    return delegate(req.cwd, brief, [], req.attachments);
  };

  scheduler = new RunScheduler({
    store,
    sessions: () => source.snapshot().sessions,
    orchestrator: cwd => sessions.project(cwd)?.id ?? null,
    launch: async (run, text) => {
      if (quitFlow.phase !== 'idle') throw new NotYet('Agent Canvas is quitting');
      const t = run.target;
      if (t.kind === 'handoff') {
        return delegateTask!({ ...t, text, attachments: run.attachments });
      }
      if (t.kind === 'new') {
        const message = await workerMessage(t.provider, text, run.attachments ?? []);
        return start(validate.newSession({ ...t, ...message }), { title: t.title ?? undefined });
      }
      const card = source.snapshot().sessions.find(s => s.id === t.id);
      if (!card) throw new NotYet('The session is unavailable');
      const message = await workerMessage(card.provider, text, run.attachments ?? []);
      await sendToChat(card.id, message.text, message.images, true);
      return card.id;
    },
  });
  // A card's thinking level, when the provider's own record has none: what it was started or set to here.
  const withEffort = (list: SessionView[]): SessionView[] => list.map((v) => {
    if (v.effort) return v;
    const effort = sessions.settings(v.id).effort;
    return effort ? { ...v, effort } : v;
  });
  const snapshot = () => { const s = source.snapshot(); return { ...s, sessions: withEffort(s.sessions), projectChats: sessions.projectChats(), runs: runs.views(), maxRunning: store.maxRunning(), openThreads: threads?.list() ?? [] }; };
  readSnapshot = snapshot;
  // The project explorer reads only the folders the canvas shows. The demo's folders are
  // invented; AGENT_CANVAS_DEMO_FILES (the e2e test's) stands in for every one of them.
  const demoFiles = demo !== null ? process.env.AGENT_CANVAS_DEMO_FILES : undefined;
  const projectOptions = { roots: () => canvasRoots(source.snapshot()), onDisk: demoFiles ? () => demoFiles : undefined };
  const projectFiles = createProjectFiles(projectOptions);
  const projectGit = createProjectGit(projectOptions);
  const handlers: Partial<Record<(typeof BRIDGE_METHODS)[number], (...args: unknown[]) => unknown>> = {
    onSnapshot: snapshot,
    runOp: async value => {
      const op = validate.runOp(value);
      if (op.type === 'link') {
        const error = checkUpstreams(snapshot(), [...op.from, op.to]);
        if (error) throw new Error(error);
      }
      store.apply(op, 'owner');
      await store.flush();
    },
    threadOp: async value => {
      threads?.apply(validate.threadOp(value));
      await threads?.flush();
    },
    permissions: () => permissionsNow(),
    askPermission: async (value) => {
      const kind = validate.permissionKind(value);
      const before = await permissionsNow();
      // macOS asks about notifications on the first one an app posts; once answered (or when this
      // build cannot post them) the switch is only in System Settings.
      if (kind === 'notifications' && before.notifications === 'not-asked') await testNotification();
      else if (demo === null) await shell.openExternal(settingsPane(await bundleId));
      return permissionsNow();
    },
    layoutOp: (op) => { source.applyLayout(validate.layoutOp(op)); },
    markSeen: (ids) => { source.markSeen(validate.markSeen(ids)); },
    dismissInterruption: (id, undo) => { source.dismissInterruption(validate.sessionId(id), undo === true); },
    openChat: async (id) => {
      const cardId = validate.sessionId(id);
      const state = await chats.open(cardId);
      await restore(cardId);
      return chats.state(cardId) ?? state;
    },
    loadOlder: (id) => { const t = target(id); return t.engine.loadOlder(t.engineId); },
    send: async (id, text, images) => {
      const t = target(id);
      const m = validate.message(text, images);
      if (policyOn) await restore(t.cardId);
      return t.engine.send(t.engineId, m.text, m.images);
    },
    interrupt: (id) => { const t = target(id); return t.engine.interrupt(t.engineId); },
    answerApproval: (id, approvalId, answer) => {
      const t = target(id);
      return t.engine.answerApproval(t.engineId, validate.choice(approvalId), validate.approvalAnswer(answer));
    },
    answerQuestion: (id, questionId, answers) => {
      const t = target(id);
      return t.engine.answerQuestion(t.engineId, validate.choice(questionId), validate.answers(answers));
    },
    setModel: async (id, model) => {
      const t = target(id);
      const m = validate.choice(model);
      if (policyOn && t.engine.provider !== 'acp' && t.engine.setModelProfile) {
        const [model, effort] = m.split('|');
        const choice = await resolved(t.engine.provider, model!, effort ?? null);
        await t.engine.setModelProfile(t.engineId, choice.model, choice.effort);
        await sessions.setSettings(t.cardId, { model: choice.model, effort: choice.effort });
        return;
      }
      await t.engine.setModel(t.engineId, m);
      sessions.setSettings(t.cardId, { model: m }).catch(logSaveError);
    },
    setMode: async (id, mode) => {
      const t = target(id);
      const m = validate.choice(mode);
      await t.engine.setMode(t.engineId, m);
      sessions.setSettings(t.cardId, { mode: m }).catch(logSaveError);
    },
    moveHere: (id) => { const t = target(id); return t.engine.moveHere(t.engineId); },
    projectChat: async cwd => {
      const path = validate.filePath(cwd);
      const [folder] = await actions.folders(path);
      return folder ? sessions.project(folder)?.id ?? null : null;
    },
    projectTask: (cwd, text, images) => {
      const m = validate.agentMessage(text, images);
      return delegate(validate.filePath(cwd), m.text, m.images);
    },
    newSession: async (value, after) => {
      const req = validate.newSession(value);
      if (after === undefined) return start(req);
      const upstream = validate.sessionId(after);
      await checkStart(req.cwd, all[req.provider], demo !== null ? demoFolderKind : folderKind);
      await actions.validateWorkerProfile?.(req);
      const error = checkUpstreams(snapshot(), [upstream]);
      if (error) throw new Error(error);
      const { text, images, ...settings } = req;
      const attachments = await attachmentStore.keepImages(images);
      const run = store.queue({ target: { kind: 'new', ...settings, title: null }, after: [upstream],
        prompt: text, attachments, by: 'owner' });
      await store.flush();
      return planId(run.id);
    },
    agentInfo: async (...args) => {
      validate.noArgs(args);
      const connection = settings.get().agentConnection;
      const { reason } = await agentStatus(connection);
      return { connection, available: reason === null, reason };
    },
    startAgent: async (text, images) => {
      const m = validate.agentMessage(text, images);
      const connection = settings.get().agentConnection;
      const { provider, reason } = await agentStatus(connection);
      if (reason) throw new Error(reason);
      const cwd = agentDirectory(agentCwd, connection);
      if (demo === null) await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
      const selected = policyOn ? await resolved(provider, null, null) : { model: null, effort: null };
      const engineId = await all[provider].start({
        provider, cwd, ...selected, mode: provider === 'claude' ? 'bypassPermissions' : 'full-access', ...m,
      });
      const id = provider === 'codex' ? CODEX_PREFIX + engineId : engineId;
      agentIds.add(id);
      running?.started?.({ id, provider, cwd, text: m.text, at: Date.now() });
      return id;
    },
    // Each provider on its own: one that fails or hangs gets a signed-out panel saying why.
    accounts: () => gatherAccounts(all),
    // The owner's saved defaults (Settings) chosen, where the provider still offers them.
    options: async (provider, agent) => {
      const o = validate.options(provider, agent);
      // An ACP agent offers what it offers; Settings keeps no defaults for it.
      if (o.provider === 'acp') return all.acp.options(o.agent);
      return optionsFor(o.provider);
    },
    pickFolder: async (...args) => {
      validate.noArgs(args);
      if (win === null || win.isDestroyed()) return null;
      const result = await dialog.showOpenDialog(win, { title: 'Choose a folder for the new session', properties: ['openDirectory', 'createDirectory'] });
      return validate.pickedFolder(result);
    },
    preview: async (value) => {
      const cmd = validate.preview(value);
      if (preview === null) throw new Error('The window is not open yet');
      switch (cmd.kind) {
        case 'show': return preview.show(cmd.bounds, cmd.clip, cmd.zoom);
        case 'navigate': return preview.navigate(cmd.url, { typed: cmd.typed, fresh: cmd.fresh === true });
        case 'back': return preview.back();
        case 'reload': return preview.reload();
        case 'clear': return preview.clear();
      }
    },
    openExternal: async (url) => { await shell.openExternal(validate.openExternal(url)); },
    // "Open in editor" shows only when some app takes vscode:// links.
    canOpenInEditor: () => app.getApplicationNameForProtocol('vscode://') !== '',
    getSettings: async (): Promise<AppSettings> => {
      const [claude, codex] = await Promise.all([hasKey('claude'), hasKey('codex')]);
      const [acpAgents, acpPresets] = await Promise.all([acpViews(settings.get().acpAgents), acpViews(ACP_PRESETS)]);
      const availableModelProfiles = policyOn ? { claude: catalogProfiles("claude").map(profileId), codex: catalogProfiles("codex").map(profileId) } : undefined;
      return { ...settings.get(), availableModelProfiles, acpAgents, acpPresets, agentKeys: { claude, codex }, openAtLogin: demo !== null ? demoOpenAtLogin : app.getLoginItemSettings().openAtLogin };
    },
    // macOS keeps the login item itself; the rest goes to settings.json. The demo keeps it all in memory.
    setSettings: async (s) => {
      const patch = validate.settings(s);
      if (patch.agentKey) {
        const { provider, key } = patch.agentKey;
        if (demo !== null) demoKeys[provider] = true;
        else await saveAgentKey(provider, key);
      }
      if (patch.openAtLogin !== undefined) {
        if (demo !== null) demoOpenAtLogin = patch.openAtLogin;
        else app.setLoginItemSettings({ openAtLogin: patch.openAtLogin });
      }
      await settings.update(patch);
    },
    // Finder selects the file; it is never opened. The demo has no real files to show.
    revealFile: (path) => { if (demo === null) shell.showItemInFolder(validate.filePath(path)); },
    gitStatus: projectGit.status,
    gitDiff: projectGit.diff,
    gitAction: projectGit.act,
    listFiles: (root, dir) => projectFiles.list(root, dir),
    previewFile: (root, file) => projectFiles.preview(root, file),
    // Board images: dropped or pasted bytes, or a dropped web address fetched once (boardImages.ts).
    importBoardImage: (value) => {
      if (boardImages === null) throw new Error('Agent canvas is still starting');
      const v = value as { kind?: unknown; name?: unknown; data?: unknown; url?: unknown } | null;
      if (v?.kind === 'bytes') return boardImages.importBytes(v.name, v.data);
      if (v?.kind === 'url') return boardImages.importUrl(v.url);
      throw new TypeError('an image import is bytes or a web address');
    },
    boardChatImage: (id) => {
      if (boardImages === null) throw new Error('Agent canvas is still starting');
      return boardImages.chatImage(id);
    },
    // Notes' pictures: dropped, pasted or picked bytes, one as a chat takes it, and the
    // clipboard's image for the board menu (noteImages.ts).
    importNoteImage: (name, data) => {
      if (noteImages === null) throw new Error('Agent canvas is still starting');
      return noteImages.importBytes(name, data);
    },
    noteChatImage: (noteId, imageId) => {
      if (noteImages === null) throw new Error('Agent canvas is still starting');
      return noteImages.chatImage(noteId, imageId);
    },
    clipboardHasImage: async (...args) => {
      validate.noArgs(args);
      return (await clipboardImage().catch(() => null)) !== null;
    },
    importClipboardImage: async (...args) => {
      validate.noArgs(args);
      if (noteImages === null) throw new Error('Agent canvas is still starting');
      const img = await clipboardImage();
      if (img === null) return null;
      return noteImages.importBytes(`Pasted image.${img.type.split('/')[1]?.replace('jpeg', 'jpg').replace(/\+.*$/, '') ?? 'png'}`, new Uint8Array(await img.arrayBuffer()));
    },
    usage: (period) => {
      if (usage === null) throw new Error('Agent canvas is still starting');
      return usage.summary(validate.usagePeriod(period));
    },
    // The card id only: the pid comes from the last poll and the app from a fresh `ps`. The demo
    // runs no real session, so it never opens an app.
    showHost: (...args) => showHost(args, {
      pidOf: (cardId) => running?.hostPid?.(cardId) ?? null,
      processes: processTable,
      open: async (bundle) => {
        const failed = await shell.openPath(bundle);
        if (failed !== '') throw new Error(failed);
      },
    }),
  };
  for (const method of BRIDGE_METHODS) {
    // onChat (chatChannel), onPreview and onAccountsChanged are pushed, and closeChat is a one-way
    // message (below).
    if (method === 'onChat' || method === 'onPreview' || method === 'onAccountsChanged' || method === 'closeChat') continue;
    const fn = handlers[method] ?? (() => { throw new Error('not yet'); });
    ipcMain.handle(CHANNELS[method], (e, ...args: unknown[]) => {
      if (!trusted(e)) throw new Error('refused');
      return fn(...args);
    });
  }
  ipcMain.on(CHANNELS.closeChat, (e, id: unknown) => {
    if (!trusted(e)) return;
    try {
      chats.close(validate.sessionId(id));
    } catch { /* not a chat id */ }
  });
  return chats;
}

function accountsChanged(): void {
  if (win !== null && !win.isDestroyed()) win.webContents.send(CHANNELS.onAccountsChanged);
}

/** What Settings shows of ACP agents: each one's program on this Mac, or null (not installed). */
async function acpViews<T extends AcpAgentConfig>(agents: readonly T[]): Promise<(T & AcpAgentView)[]> {
  return Promise.all(agents.map(async (a) => ({ ...a, path: await findProgram(a.command, acpPath), install: ACP_PRESETS.find((p) => p.command === a.command)?.install ?? null })));
}

/** The engine for the ACP agents in Settings (shared/acp.ts, docs/acp.md). Its sessions are
    cards from its own records; a change there rebuilds the views. */
async function createAcpEngine(env: Record<string, string>, recordsFile: string | null): Promise<AcpEngine> {
  return new AcpEngine({
    agents: () => settingsFile?.get().acpAgents ?? [],
    resolve: (a) => findProgram(a.command, env.PATH ?? acpPath),
    env,
    records: await AcpRecords.load(recordsFile),
    onChange: () => running?.engineChanged?.(),
    keepImages: (images) => attachmentStore.keepImages(images),
    // Per-turn tokens, when the agent reports them, go into Settings' usage analytics.
    onTurnUsage: (u) => {
      if (!(usage instanceof UsageStore)) return;
      usage.record({
        provider: 'acp', session: acpCardId(u.sessionId), cwd: u.cwd, model: u.model, turn: u.turn, at: u.at, long: false,
        input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cacheWrite1h: 0, calls: 1,
      });
    },
  });
}

/** Demo mode drives no real Claude or Codex: scripted engines stand in. */
async function createEngines(claudeHome: string, lookup: Promise<ShellFacts>): Promise<Engines> {
  if (demo !== null) {
    const previewUrl = demoPreviewUrl();
    // The demo's ACP agents are real (e2e runs a stub): they keep no records past the run.
    const acp = await createAcpEngine(childEnv(process.env), null);
    return {
      acp,
      claude: demoEngine('claude', { previewUrl, onAgentTurn: (id, turning) => running?.agentTurn?.(id, turning), onTurn: demoTurns ? (id, phase, answer) => running?.turn?.(id, phase, answer) : undefined }),
      codex: demoEngine('codex', { previewUrl, onAgentTurn: (id, turning) => running?.agentTurn?.(CODEX_PREFIX + id, turning), onTurn: demoTurns ? (id, phase, answer) => running?.turn?.(id, phase, answer) : undefined }),
    };
  }
  const facts = await lookup;
  const resolveCodexPath = () => findCodex({ loginShell: async () => facts.codex, exists: existsSync });
  // Children get the login shell's PATH (a Dock launch has launchd's), asked once with codex.
  const env = childEnv(process.env, facts.path);
  acpPath = env.PATH ?? acpPath;
  const acp = await createAcpEngine(env, path.join(dataPaths().dataHome, 'acp-sessions.json'));
  return {
    acp,
    // Whether another program has a session open is the store's call, as of its last poll.
    // A rate limit event from either provider: an open profile page reads the accounts again.
    claude: new ClaudeEngine({
      claudeHome, env, elsewhere: (id) => running?.owner(id) === 'elsewhere', onAccountChanged: accountsChanged,
      workingElsewhere: (id) => {
        const s = running?.source.snapshot();
        return busyElsewhere(s ? cardOf(s, id) : undefined);
      },
      // A session in the agent's folder is the canvas agent: it gets the canvas tools and its own
      // system prompt.
      projectFor: id => projectFor(id),
      agentKey: { cwd: agentDirectory(agentCwd, 'claude-api'), read: () => readAgentKey('claude') },
      extras: agentExtras({ cwd: agentCwd, api: canvasApi }),
    }),
    codex: new CodexEngine({
      agent: { projectFor: id => projectFor(CODEX_PREFIX + id), cwd: agentDirectory(agentCwd, 'codex-api'), api: canvasApi, auth: keyLookup('codex') },
      codexPath: installedCodexPaths(facts.codex)[0] ?? null, resolveCodexPath, env,
      onAccountChanged: () => { accountsChanged(); void running?.refreshCodexLimit?.(); },
      elsewhere: (id) => running?.owner(CODEX_PREFIX + id) === 'elsewhere',
    }),
  };
}

async function start(): Promise<void> {
  const { dataHome, claudeHome, codexHome } = dataPaths();
  // Board images live beside the layout; the demo keeps its copies in its throwaway profile, and
  // reads the files it shows by path from AGENT_CANVAS_DEMO_FILES, as its explorer does.
  const demoFiles = demo !== null ? process.env.AGENT_CANVAS_DEMO_FILES : undefined;
  const onDisk = (file: string): string => {
    if (!demoFiles || running === null) return file;
    const root = canvasRoots(running.source.snapshot()).find((r) => file.startsWith(`${r}/`));
    return root === undefined ? file : path.join(demoFiles, file.slice(root.length));
  };
  boardImages = createBoardImages({
    onDisk,
    dir: path.join(demo !== null ? app.getPath('userData') : dataHome, 'board-images'),
    items: () => running?.source.snapshot().layout.items ?? [],
    fetch: (url, init) => net.fetch(url, init),
    fetchFile: (url, init) => net.fetch(url, init),
    image: {
      encode: (file, max, format, onlyIfLarger) => {
        const img = nativeImage.createFromPath(file);
        if (img.isEmpty()) return null;
        const { width, height } = img.getSize();
        if (onlyIfLarger && Math.max(width, height) <= max) return null;
        const sized = Math.max(width, height) <= max ? img : img.resize(width >= height ? { width: max, quality: 'good' } : { height: max, quality: 'good' });
        return format === 'png' ? sized.toPNG() : sized.toJPEG(85);
      },
    },
  });
  // Notes' pictures live beside them, in a folder of their own (the board images' sweep keeps
  // only what board items name); the demo keeps them in its throwaway profile too.
  noteImages = createNoteImages({
    dir: path.join(demo !== null ? app.getPath('userData') : dataHome, 'note-images'),
    notes: () => running?.source.snapshot().layout.notes ?? [],
    fetchFile: (url, init) => net.fetch(url, init),
    image: {
      encode: (file, max, format, onlyIfLarger) => {
        const img = nativeImage.createFromPath(file);
        if (img.isEmpty()) return null;
        const { width, height } = img.getSize();
        if (onlyIfLarger && Math.max(width, height) <= max) return null;
        const sized = Math.max(width, height) <= max ? img : img.resize(width >= height ? { width: max, quality: 'good' } : { height: max, quality: 'good' });
        return format === 'png' ? sized.toPNG() : sized.toJPEG(85);
      },
    },
  });
  const all = await createEngines(claudeHome, shellLookup);
  engines = all;
  running = await createSource(demo !== null ? { demo, acp: all.acp } : { demo: null, claudeHome, codexHome, dataHome, engines: all, appPid: process.pid, agentCwd });
  const { source } = running;
  // Demo mode reads and writes nothing.
  const sessions = await SessionsFile.load(demo !== null ? null : path.join(dataHome, 'sessions.json'));
  const settings = await SettingsFile.load(demo !== null ? null : path.join(dataHome, 'settings.json'));
  settingsFile = settings;
  if (demo !== null) usage = { summary: async (period) => demoUsageSummary(period, Date.now(), agentCwd) };
  else {
    const store = new UsageStore({
      dir: path.join(dataHome, 'usage'), claudeHome, codexHome, agentCwd,
      // The orchestrators on record, by card id (the store remembers ones later replaced).
      roles: () => Object.fromEntries(Object.values(sessions.projectChats()).flatMap(id => {
        const role = sessions.role(id);
        return role ? [[id, { folder: role.folder, connection: role.connection }]] : [];
      })),
      log: (msg) => { process.stderr.write(`agent-canvas: ${msg}\n`); },
    });
    usage = store;
    // The first read backfills history from the transcripts; later ones read only what is new.
    setTimeout(() => { void store.scan(); }, 15_000).unref();
  }

  protocol.handle(SCHEME, serveApp);
  if (DEV_URL !== null) {
    const csp = devCsp(PAGE_ORIGIN);
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${PAGE_ORIGIN}/*`] }, (details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
  }
  // The canvas needs no camera, notifications or the like; only "Copy resume command" asks for anything.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));

  const store = await RunStore.load(demo === null ? path.join(dataHome, 'runs.json') : null);
  // Demo mode keeps its open threads in memory, seeded with two of its own.
  threads = await ThreadStore.load(demo === null ? path.join(dataHome, 'openThreads.json') : null, demo === null ? [] : demoThreads(Date.now()));
  const chats = registerIpc(source, all, sessions, settings, store);
  protocol.handle('canvas-media', request => new URL(request.url).host === 'board' && boardImages !== null
    ? boardImages.serve(request)
    : new URL(request.url).host === 'note' && noteImages !== null
    ? noteImages.serve(request)
    : serveChatMedia(request, id => chats.state(id), (url, init) => net.fetch(url, init)));
  const push = () => {
    const s = readSnapshot!();
    const waiting = waitingCount(s);
    app.dock?.setBadge(waiting > 0 ? String(waiting) : '');
    win?.webContents.send(CHANNELS.onSnapshot, s);
  };
  scheduler?.onChange(push);
  threads.onChange(push);
  source.onChange(() => { scheduler?.poke(); push(); });
  // An image the board shows by path is drawn again when its file changes, and as missing while it is gone.
  const boardFiles = watchBoardFiles({
    items: () => source.snapshot().layout.items ?? [],
    edit: (id, patch) => source.applyLayout({ type: 'editItem', id, patch }),
    watch: (file, onChange) => watchFile(onDisk(file), { interval: 1500, persistent: false }, (cur) => onChange(cur.mtimeMs)),
    unwatch: (file) => unwatchFile(onDisk(file)),
    stat: async (file) => (fileExists(onDisk(file)) ? (await fs.stat(onDisk(file))).mtimeMs : null),
  });
  source.onChange(() => boardFiles.sync());
  boardFiles.sync();
  // A usage limit that cut sessions off has reset: one notification (a click opens the canvas),
  // and with "Continue cut-off sessions automatically" a queued Continue each (limitResets.ts).
  const limitResets = new LimitResets({
    choice: () => settings.get().limitReset ?? 'ask',
    queue: (draft) => store.queue(draft),
    notify: (count) => {
      if (hidden || !Notification.isSupported()) return;
      const n = new Notification(resetNotice(count));
      n.on('click', () => { reveal(win); win?.focus(); });
      n.show();
    },
  });
  source.onChange(() => { const s = source.snapshot(); limitResets.update(s.sessions, s.agent ?? null); });
  if (demo === null) void boardImages.sweep();
  if (demo === null) void noteImages.sweep();
  push();

  win = createWindow();
  preview = createPreview(win);
  // A reloaded or crashed page has no chats open any more, and no pane for the preview to cover.
  win.webContents.on('did-navigate', () => { chats.closeAll(); preview?.show(null); });
  win.webContents.on('render-process-gone', () => { chats.closeAll(); preview?.show(null); });
  // Signed out on day one: after `claude` then /login in a terminal, the chats come back without
  // a restart. Demo engines are never signed out.
  if (demo === null) {
    const w = win;
    const signIn = new SignInWatch({
      engine: all.claude,
      visible: () => !w.isDestroyed() && w.isVisible() && !w.isMinimized(),
      onSignedIn: async () => {
        await running?.refresh?.();
        accountsChanged();
      },
    });
    w.on('focus', () => { void signIn.focus(); void running?.refreshCodexLimit?.(); });
    signIn.start();
  }
  running.start();
  scheduler?.start();
  // The open-threads scan reads the transcripts on disk now and then, and confirms each new
  // candidate with one small Haiku call through the app's own Claude sign-in. Nothing is sent
  // anywhere else; the demo reads nothing and calls no model.
  if (demo === null) {
    const facts = await shellLookup;
    threadScanner = new ThreadScanner({
      store: threads,
      claudeProjects: path.join(claudeHome, 'projects'),
      codexHome,
      agentCwd,
      judge: createJudge({ sdk: realSdk, cwd: dataHome, env: childEnv(process.env, facts.path) }),
      nameOf: (id) => source.snapshot().sessions.find((s) => s.id === id)?.name || undefined,
    });
    threadScanner.start();
  }
}

/** The sessions a quit would interrupt, by their card titles. */
function busySessions(): BusySession[] {
  if (engines === null) return [];
  const snapshot = running?.source.snapshot();
  const cards = snapshot?.sessions ?? [];
  return Object.values(engines).flatMap((engine) => engine.busy().map((b): BusySession => {
    const cardId = engine.provider === 'codex' ? CODEX_PREFIX + b.sessionId : engine.provider === 'acp' ? acpCardId(b.sessionId) : b.sessionId;
    // The agent is no card and has no name of its own.
    if (agentIds.has(cardId) || snapshot?.agent?.id === cardId) return { title: 'The canvas agent', reason: b.reason };
    const name = cards.find((c) => c.id === cardId)?.name;
    return { title: name || (engine.provider === 'codex' ? 'A Codex chat' : engine.provider === 'acp' ? 'An ACP agent chat' : 'A Claude session'), reason: b.reason };
  }));
}

/** A quit never cuts a session short: busy ones finish unseen, then the app exits (quit.ts). */
const quitFlow = new QuitFlow({
  busy: busySessions,
  hide: () => {
    if (win !== null && !win.isDestroyed()) win.hide();
    app.dock?.hide();
  },
  show: () => {
    if (!hidden) void app.dock?.show();
    reveal(win);
    win?.focus();
  },
  notify: (b) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: b.reason === 'question' ? `${b.title} has a question` : `${b.title} needs your approval`,
      body: 'Agent canvas is finishing this session in the background. Open it to answer.',
    });
    n.on('click', () => quitFlow.reopened());
    n.show();
  },
  // Every engine stops (refusing new work) and the reader writes any save still waiting; one
  // failing does not cut the others short.
  stop: async () => {
    await scheduler?.stop();
    await Promise.allSettled([running?.stop(), threadScanner?.stop() ?? threads?.flush(), ...Object.values(engines ?? {}).map((e) => e.stop())]);
  },
  // A second app.quit() never finishes when the quit began with a signal, so the exit is direct.
  exit: () => {
    quitting = true;
    exitApp(0);
  },
});

/** The login-shell lookup (its PATH and `codex`) starts at once, alongside Electron's own start-up. */
let shellLookup: Promise<ShellFacts> = Promise.resolve({ path: null, codex: null });

// One app writes the layout at a time; the demo writes nothing, so it may run beside the real one.
if (demo === null && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (demo === null) shellLookup = loginShellFacts().catch(() => ({ path: null, codex: null }));
  // Opening the app again (Launchpad, Spotlight, the Dock) while it finishes in the background
  // brings it back as it was.
  app.on('second-instance', () => {
    if (quitFlow.phase === 'finishing') quitFlow.reopened();
    else if (!hidden) { win?.show(); win?.focus(); }
  });
  app.on('web-contents-created', (_e, contents) => {
    restrictPreviewGuests(contents);
  });
  app.on('activate', () => {
    if (quitFlow.phase === 'finishing') quitFlow.reopened();
    else reveal(win);
  });
  app.on('window-all-closed', () => { /* stays in the Dock */ });
  // Cmd+Q, the menu's Quit and the Dock's Quit all land here.
  app.on('before-quit', (e) => {
    if (running === null) {
      quitting = true; // still starting: nothing to stop yet
      return;
    }
    e.preventDefault();
    void quitFlow.request();
  });
  // A signal (the terminal, npm run dev stopping) stops everything at once.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (running === null) exitApp(0);
      else void quitFlow.request({ force: true });
    });
  }
  app.whenReady().then(() => {
    // The Mac shutting down or restarting must not wait on a session: stop them now.
    powerMonitor.on('shutdown', () => { if (running !== null) void quitFlow.request({ force: true }); });
    return start();
  }).catch((err: unknown) => {
    process.stderr.write(`agent-canvas: ${(err as Error).message}\n`);
    exitApp(1);
  });
}
