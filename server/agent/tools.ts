// The canvas agent's tools: what it can see and do on the canvas, as plain definitions (a name, a
// description, a zod shape for the arguments, and a handler over CanvasApi that answers with one
// text). Nothing here knows the Agent SDK; agent.ts turns the list into the in-process MCP server
// named `canvas`, so Claude sees each tool as `mcp__canvas__<name>`. A handler never throws for a
// bad id or path: it answers with a one-line error instead.
import path from 'node:path';
import { z } from 'zod';
import { acpCardId, parseProviderName } from '../../shared/acp.ts';
import type { Provider } from '../../shared/chat.ts';
import type { LayoutOp, SessionView, Snapshot, ZoneLayout } from '../../shared/types.ts';
import { interruptionState, limitReady } from '../../shared/interruption.ts';
import { folderOf } from '../activity.ts';
import { zoneIdFor } from '../layoutOps.ts';
import { agentImage, imagesOverview } from './boardTools.ts';
import { isImagePath, MAX_CAPTION } from '../../shared/boardItems.ts';
import { DEFAULT_LIMIT, MAX_LIMIT, type FoundFolder } from './folders.ts';
import { attachmentsArg, type Attachment } from './taskAttachments.ts';
import { USAGE_PERIODS, type UsagePeriod, type UsageSummary } from '../../shared/usage.ts';
import { usageReport } from '../usage/report.ts';
import type { RunsApi } from '../runs/api.ts';
import { afterArg, afterModeArg, handOffArg, linkTools, queueTask, runFacts, runsOverview } from './linkTools.ts';
import { threadTools, type ThreadsApi } from './threadTools.ts';
import { noteTools, notesOverview, type NotesApi } from './noteTools.ts';
import { modelLabel } from '../../shared/modelLabel.ts';

/** Project work the canvas agent hands to an orchestrator, with any requested worker settings. */
export interface TaskRequest {
  /** 'claude', 'codex' or a configured ACP agent's id (as acp:<id>), checked by start_task. */
  provider: string | null; cwd: string; model: string | null; effort?: string | null; mode: string | null; text: string;
  /** Images and files to hand on, already copied into the app's attachments folder. */
  attachments?: Attachment[];
}

/** What the tools need of the app. Main implements it over the store and the engines. */
export interface CanvasApi {
  snapshot(): Snapshot;
  /** The same path the page's layoutOp takes: the canvas updates and the layout is saved. */
  applyLayout(op: LayoutOp): void;
  /** Hands a request to the project's orchestrator and resolves with its card id. */
  startSession(req: TaskRequest): Promise<string>;
  /** The ACP agents shown in New session (Settings), and whether each one's command is on this
      Mac. Hidden ones (by default the Claude and Codex adapters) are left out. */
  acpAgents?(): Promise<{ id: string; name: string; installed: boolean }[]>;
  /** Checks attachment paths and copies them into the app's data folder (taskAttachments.ts);
      throws a one-line reason when one is missing, unreadable or too big. */
  keepAttachments(paths: string[]): Promise<Attachment[]>;
  findFolders(query: string, limit: number): Promise<FoundFolder[]>;
  folderKind(p: string): Promise<'dir' | 'file' | 'missing'>;
  /** Opens a card in the window as a click on it does (its chat or terminal, the view gliding to
      the card) and brings the window to the front; throws when the window cannot (it is quitting). */
  openSession(id: string): void;
  /** Settings → Usage: this app's own agents' tokens against the work sessions' (server/usage). */
  usageSummary?(period: UsagePeriod): Promise<UsageSummary>;
  /** Links between sessions and their queued prompts (linkTools.ts); the snapshot carries their views. */
  runs?: RunsApi;
  /** The board's open threads (threadTools.ts). */
  threads?: ThreadsApi;
  /** Pictures for the owner's notes, copied into the app's data folder (noteTools.ts). */
  notes?: NotesApi;
  now(): number;
}

export interface ToolResult { text: string; isError: boolean }

export interface CanvasTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  /** Reads, and layout changes that are easily undone: these run without asking the owner in any
      mode. The others (deleting a zone, starting a task) follow the session's mode: they ask in
      Ask (Claude) or Read only (Codex), and run at once in Bypass or Full access, where the agent
      starts. */
  safe: boolean;
  readOnly: boolean;
  handler(api: CanvasApi, args: Record<string, unknown>): Promise<ToolResult>;
}

export const SERVER_NAME = 'canvas';
/** A tool's name as Claude Code knows it. */
export const toolId = (name: string): string => `mcp__${SERVER_NAME}__${name}`;

const ok = (text: string): ToolResult => ({ text, isError: false });
const fail = (text: string): ToolResult => ({ text, isError: true });
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function define<S extends z.ZodRawShape>(def: {
  name: string; description: string; shape: S; safe: boolean; readOnly?: boolean;
  handler(api: CanvasApi, args: z.infer<z.ZodObject<S>>): Promise<ToolResult>;
}): CanvasTool {
  return {
    name: def.name, description: def.description, shape: def.shape, safe: def.safe, readOnly: def.readOnly === true,
    // The SDK checks the arguments against the shape before it calls; a direct call is checked here.
    handler: async (api, args) => {
      const parsed = z.object(def.shape).safeParse(args);
      if (!parsed.success) return fail(`Bad arguments for ${def.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
      try {
        return await def.handler(api, parsed.data as z.infer<z.ZodObject<S>>);
      } catch (err) {
        return fail(`${def.name} failed: ${errText(err)}`);
      }
    },
  };
}

/** "45s", "12m", "3h", "2d": how long ago `since` was. */
export function ago(since: number, now: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

const stateLabel = (s: SessionView): string => (s.interruption ? interruptionState(s.interruption)
  : s.state === 'needs_you' ? `needs_you:${s.need ?? 'reply'}` : s.state);

/** What cut an interrupted session off, for the agent's report: the reason, and a limit's reset time. */
const interruptionFacts = (s: SessionView): Record<string, string> => s.interruption ? {
  interruptedBy: s.interruption.reason,
  ...(s.interruption.resetsAt !== null ? { limitResets: new Date(s.interruption.resetsAt).toISOString() } : {}),
  // The limit has reset: the session can be continued now.
  ...(limitReady(s.interruption, Date.now()) ? { limitReset: 'ready to continue' } : {}),
} : {};

/** The folder a folder zone stands for: its recorded path, else where its latest session ran. */
export function zonePath(zone: ZoneLayout, sessions: SessionView[]): string | null {
  if (zone.kind !== 'folder') return null;
  if (zone.path) return zone.path;
  if (!zone.folder) return null;
  const latest = sessions.filter((s) => s.folder === zone.folder && s.cwd !== '').sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!latest) return null;
  // A session in a worktree stands for the repository the worktree belongs to.
  const wt = latest.cwd.indexOf('/.claude/worktrees/');
  return wt === -1 ? latest.cwd : latest.cwd.slice(0, wt);
}

function overview(snap: Snapshot, now: number, acpAgents: Awaited<ReturnType<NonNullable<CanvasApi['acpAgents']>>>): string {
  const { layout, sessions } = snap;
  const byZone = new Map<string, SessionView[]>();
  for (const s of sessions) {
    const id = zoneIdFor(s, layout);
    byZone.set(id, [...(byZone.get(id) ?? []), s]);
  }
  const zones: ZoneLayout[] = [...layout.zones];
  for (const [id, list] of byZone) {
    if (zones.some((z) => z.id === id)) continue;
    const folder = list[0]!.folder;
    zones.push({ id, name: folder === '' ? 'No folder' : folder, kind: 'folder', folder, x: null, y: null, hueIndex: 6 });
  }
  const rank = (s: SessionView): number => (s.state === 'needs_you' ? 0 : s.state === 'working' ? 1 : 2);
  const out = zones
    // A folder zone with no session and no known folder is not on the canvas either.
    .filter((z) => z.kind === 'custom' || byZone.has(z.id) || z.path !== undefined)
    .map((z) => ({
      id: z.id, name: z.name, kind: z.kind,
      ...(z.kind === 'folder' ? { path: zonePath(z, sessions) } : {}),
      ...(z.hiddenAt !== undefined ? { hidden: true } : {}),
      sessions: (byZone.get(z.id) ?? []).sort((a, b) => rank(a) - rank(b) || b.stateSince - a.stateSince).map((s) => ({
        id: s.id, provider: s.provider, ...(s.acp ? { agent: s.acp.id } : {}), name: s.name || '(untitled)', state: stateLabel(s), for: ago(s.stateSince, now),
        ...(s.activity ? { activity: s.activity } : {}),
        ...interruptionFacts(s),
        ...(s.branch ? { branch: s.branch } : {}),
        ...(s.model ? { model: s.model, modelLabel: modelLabel(s.provider, s.model, s.effort) } : {}),
        ...(s.effort ? { effort: s.effort } : {}),
        owner: s.owner,
      })),
    }));
  const banners = (['claude', 'codex'] as const).flatMap((p) => (snap.banners[p] ? [`${p}: ${snap.banners[p].text}`] : []));
  const count = (state: SessionView['state']): number => sessions.filter((s) => s.state === state).length;
  return JSON.stringify({
    totals: {
      sessions: sessions.length, needs_you: count('needs_you'), working: count('working'), idle: count('idle'),
      ...(sessions.some((s) => s.interruption) ? { interrupted: sessions.filter((s) => s.interruption).length } : {}),
    },
    ...(banners.length > 0 ? { problems: banners } : {}),
    zones: out,
    ...(acpAgents.length > 0 ? { acpAgents } : {}),
    ...imagesOverview(layout),
    ...notesOverview(layout),
    ...runsOverview(snap),
  });
}

const zoneOf = (snap: Snapshot, id: string): ZoneLayout | undefined => snap.layout.zones.find((z) => z.id === id);
const noZone = (id: string): ToolResult => fail(`No zone has the id ${id}. canvas_overview lists the zones.`);

export const CANVAS_TOOLS: CanvasTool[] = [
  define({
    name: 'canvas_overview',
    description: 'Everything on the canvas now: each zone (id, name, kind, folder path when known, hidden) with its sessions (id, provider, name, state, how long in that state, activity, branch, model with modelLabel (its friendly name and thinking level, e.g. "Opus 5.5 High", for showing the owner), effort, owner). States: working, needs_you:<permission|question|reply|terminal>, interrupted:<limit|error|killed> (the last turn was cut off by a usage limit, an error, or its process ending, and the owner has not continued or aborted it; interruptedBy says why, limitResets when a limit lifts; these count in needs_you), idle, unknown. The queue lists links between sessions ("B runs after A": each run, the session or planned session that waits, what it waits for and the state of each, status waiting|queued|blocked|starting|started, the reason, the queued prompt) and maxRunning the caps per project. Call this before answering any question about sessions, and for reports. A session with provider acp runs an ACP agent from Settings (agent: its id); the acpAgents field lists them and whether each is installed.',
    shape: {}, safe: true, readOnly: true,
    handler: async (api) => {
      const agents = await api.acpAgents?.() ?? [];
      return ok(overview(api.snapshot(), api.now(), agents));
    },
  }),
  define({
    name: 'read_session',
    description: 'One session in full: its last prompt, last answer, recent steps and subagents, besides what canvas_overview gives.',
    shape: { id: z.string().describe('The session id from canvas_overview') }, safe: true, readOnly: true,
    handler: async (api, { id }) => {
      const snap = api.snapshot();
      const s = snap.sessions.find((x) => x.id === id);
      if (!s) return fail(`No session has the id ${id}. canvas_overview lists the sessions.`);
      const zone = zoneOf(snap, zoneIdFor(s, snap.layout));
      return ok(JSON.stringify({
        id: s.id, provider: s.provider, name: s.name || '(untitled)', zone: zone ? { id: zone.id, name: zone.name } : null, folder: s.cwd,
        state: stateLabel(s), for: ago(s.stateSince, api.now()), started: `${ago(s.startedAt, api.now())} ago`, activity: s.activity,
        ...interruptionFacts(s),
        branch: s.branch, model: s.model, modelLabel: s.model ? modelLabel(s.provider, s.model, s.effort) : null, effort: s.effort ?? null, owner: s.owner, ownerNote: s.ownerNote,
        lastPrompt: s.lastPrompt, lastAnswer: s.lastAnswer, recentSteps: s.recentSteps ?? [], subagents: s.subagents,
        ...runFacts(snap, s.id),
      }));
    },
  }),
  define({
    name: 'find_folders',
    description: 'Finds folders on this Mac by name (under the home folder), most relevant first, each with whether it is a git repository. Use it to find a project before asking the owner for a path.',
    shape: {
      query: z.string().describe('Part of the folder name; several words must all be in the name'),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`How many to return (default ${DEFAULT_LIMIT})`),
    },
    safe: true, readOnly: true,
    handler: async (api, { query, limit }) => {
      if (query.trim() === '') return fail('find_folders needs a name to look for.');
      const found = await api.findFolders(query, limit ?? DEFAULT_LIMIT);
      if (found.length === 0) return ok(`No folder named like "${query.trim()}" was found under the home folder.`);
      return ok(found.map((f) => `${f.path}${f.git ? '  (git repository)' : ''}`).join('\n'));
    },
  }),
  define({
    name: 'create_zone',
    description: 'Creates a custom zone (a named group the owner can move sessions into). Answers with its id.',
    shape: { name: z.string().describe('The zone name, at most 60 characters') }, safe: true,
    handler: async (api, { name }) => {
      const before = new Set(api.snapshot().layout.zones.map((z) => z.id));
      api.applyLayout({ type: 'createZone', name });
      const made = api.snapshot().layout.zones.find((z) => z.kind === 'custom' && !before.has(z.id));
      return made ? ok(`Created the zone "${made.name}" with id ${made.id}.`) : fail('A zone needs a name.');
    },
  }),
  define({
    name: 'add_folder_zone',
    description: 'Puts a zone on the canvas for a folder on disk, even before any session has run there (and brings a removed folder zone back). Answers with the zone id.',
    shape: { path: z.string().describe('The absolute path of the folder') }, safe: true,
    handler: async (api, args) => {
      if (!args.path.startsWith('/')) return fail(`${args.path} is not an absolute path. find_folders gives absolute paths.`);
      const folder = path.resolve(args.path);
      const kind = await api.folderKind(folder);
      if (kind !== 'dir') return fail(kind === 'file' ? `${folder} is a file, not a folder.` : `The folder ${folder} does not exist.`);
      const name = folderOf(folder);
      if (name === '') return fail(`${folder} cannot be a zone of its own.`);
      const id = `folder:${name}`;
      const other = zoneOf(api.snapshot(), id)?.path;
      api.applyLayout({ type: 'addFolderZone', path: folder });
      if (!zoneOf(api.snapshot(), id)) return fail(`The zone for ${folder} could not be made.`);
      const shared = other !== undefined && other !== folder ? ` Zones go by folder name, so it replaces ${other} as this zone's folder.` : '';
      return ok(`The zone "${zoneOf(api.snapshot(), id)!.name}" (id ${id}) is on the canvas for ${folder}.${shared}`);
    },
  }),
  define({
    name: 'rename_zone',
    description: 'Renames a zone.',
    shape: { id: z.string().describe('The zone id'), name: z.string().describe('The new name, at most 60 characters') }, safe: true,
    handler: async (api, { id, name }) => {
      if (!zoneOf(api.snapshot(), id)) return noZone(id);
      if (name.trim() === '') return fail('A zone needs a name.');
      api.applyLayout({ type: 'renameZone', id, name });
      return ok(`The zone ${id} is now called "${zoneOf(api.snapshot(), id)?.name ?? name.trim()}".`);
    },
  }),
  define({
    name: 'hide_zone',
    description: 'Takes a folder zone off the canvas. Its sessions stay as they are and come back by themselves when one of them works or needs the owner; show_zone brings the zone back.',
    shape: { id: z.string().describe('The id of a folder zone') }, safe: true,
    handler: async (api, { id }) => {
      const zone = zoneOf(api.snapshot(), id);
      if (!zone) return noZone(id);
      if (zone.kind !== 'folder') return fail(`${id} is a custom zone: only folder zones can be hidden. delete_zone removes a custom zone.`);
      api.applyLayout({ type: 'hideZone', id, at: api.now() });
      return ok(`The zone "${zone.name}" is off the canvas.`);
    },
  }),
  define({
    name: 'show_zone',
    description: 'Brings a hidden folder zone back onto the canvas.',
    shape: { id: z.string().describe('The id of a folder zone') }, safe: true,
    handler: async (api, { id }) => {
      const zone = zoneOf(api.snapshot(), id);
      if (!zone) return noZone(id);
      if (zone.kind !== 'folder') return fail(`${id} is a custom zone, which is never hidden.`);
      api.applyLayout({ type: 'hideZone', id, at: null });
      return ok(`The zone "${zone.name}" is on the canvas.`);
    },
  }),
  define({
    name: 'move_session',
    description: "Moves a session's card into a zone, or back to its own folder zone with zoneId null.",
    shape: {
      sessionId: z.string().describe('The session id'),
      zoneId: z.string().nullable().describe("The zone to move it to, or null for the session's own folder zone"),
    },
    safe: true,
    handler: async (api, { sessionId, zoneId }) => {
      const snap = api.snapshot();
      const s = snap.sessions.find((x) => x.id === sessionId);
      if (!s) return fail(`No session has the id ${sessionId}. canvas_overview lists the sessions.`);
      const zone = zoneId === null ? null : zoneOf(snap, zoneId);
      if (zoneId !== null && !zone) return noZone(zoneId);
      api.applyLayout({ type: 'assign', sessionId, zoneId });
      return ok(zone ? `Moved "${s.name || sessionId}" to the zone "${zone.name}".` : `Moved "${s.name || sessionId}" back to its folder zone.`);
    },
  }),
  define({
    name: 'open_session',
    description: "Opens a session's card in the app, as if the owner clicked it: its chat or terminal opens, the canvas glides to the card, and the window comes to the front. A card in a hidden zone is shown first (show_zone). Use it when the owner asks to open, show or go to a session.",
    shape: { id: z.string().describe('The session id from canvas_overview') }, safe: true,
    handler: async (api, { id }) => {
      const snap = api.snapshot();
      if (snap.agent?.id === id) return fail('That is this conversation: it is open already.');
      const s = snap.sessions.find((x) => x.id === id);
      if (!s) return fail(`No session has the id ${id}. canvas_overview lists the sessions.`);
      // As the canvas draws it (Canvas.tsx, backFromHidden): a session in a hidden folder zone is
      // off the canvas until it works, needs the owner or changes state, so its zone comes back first.
      const zone = zoneOf(snap, zoneIdFor(s, snap.layout));
      const hidden = zone?.kind === 'folder' && zone.hiddenAt !== undefined
        && !(s.state === 'working' || s.state === 'needs_you' || s.stateSince > zone.hiddenAt);
      if (hidden) api.applyLayout({ type: 'hideZone', id: zone.id, at: null });
      api.openSession(id);
      return ok(`Opened "${s.name || id}" in the app.${hidden ? ` Its zone "${zone.name}" was hidden, so it is back on the canvas.` : ''}`);
    },
  }),
  define({
    name: 'delete_zone',
    description: 'Deletes a custom zone; its sessions go back to their folder zones. Folder zones cannot be deleted (hide_zone takes one off the canvas). The owner may be asked first.',
    shape: { id: z.string().describe('The id of a custom zone') }, safe: false,
    handler: async (api, { id }) => {
      const zone = zoneOf(api.snapshot(), id);
      if (!zone) return noZone(id);
      if (zone.kind !== 'custom') return fail(`${id} is a folder zone: only custom zones can be deleted. hide_zone takes a folder zone off the canvas.`);
      api.applyLayout({ type: 'deleteZone', id });
      return ok(`Deleted the zone "${zone.name}". Its sessions are back in their folder zones.`);
    },
  }),
  define({
    name: 'start_task',
    description: 'Hand a task to the persistent project orchestrator, which reuses or creates worker chats. Give `folder` (an absolute path) or `zoneId` (a folder zone whose folder is known). Pass the screenshots the owner pasted and any files the work needs in `attachments`, so the workers see them. The owner may be asked first. Answers with the orchestrator session id; it then coordinates the work, and canvas_overview or read_session show how it is doing. With `after`, the task is queued instead and handed to the orchestrator by itself once those sessions have finished (it survives an app relaunch; an interrupted one blocks it): use this for work that must come after other work, never polling or a "wait until they are quiet" instruction.',
    shape: {
      folder: z.string().optional().describe('The absolute path of the folder to work in'),
      zoneId: z.string().optional().describe('Instead of folder: the id of a folder zone'),
      prompt: z.string().describe('What the new session should do: complete instructions, as it knows nothing of this conversation'),
      provider: z.string().optional().describe('Worker provider requested by the owner, if specified: claude, codex, or an installed ACP agent from canvas_overview as acp:<id>'),
      model: z.string().optional().describe("A model id; leave out for the provider's default"),
      effort: z.string().optional().describe("Thinking level requested with an exact approved model"),
      mode: z.string().optional().describe("A permission mode id; leave out for the provider's default"),
      attachments: attachmentsArg('the task'),
      after: afterArg('the task'),
      afterMode: afterModeArg,
      handOff: handOffArg,
    },
    safe: false,
    handler: async (api, args) => {
      if (args.prompt.trim() === '') return fail('A task needs a prompt.');
      if ((args.folder === undefined) === (args.zoneId === undefined)) return fail('Give either folder or zoneId, not both and not neither.');
      let cwd: string;
      if (args.zoneId !== undefined) {
        const snap = api.snapshot();
        const zone = zoneOf(snap, args.zoneId);
        if (!zone) return noZone(args.zoneId);
        const known = zonePath(zone, snap.sessions);
        if (known === null) return fail(`The zone "${zone.name}" has no known folder. Give the folder's absolute path instead (find_folders finds it).`);
        cwd = known;
      } else {
        if (!args.folder!.startsWith('/')) return fail(`${args.folder} is not an absolute path. find_folders gives absolute paths.`);
        cwd = path.resolve(args.folder!);
      }
      const kind = await api.folderKind(cwd);
      if (kind !== 'dir') return fail(kind === 'file' ? `${cwd} is a file, not a folder.` : `The folder ${cwd} does not exist.`);
      let provider: string | null = null;
      if (args.provider !== undefined) {
        const named = parseProviderName(args.provider);
        if (named === null) return fail(`${args.provider} is no provider: use claude, codex or acp:<id> of an ACP agent in canvas_overview.`);
        if (named.provider === 'acp') {
          const agent = (await api.acpAgents?.() ?? []).find((a) => a.id === named.agent);
          if (!agent) return fail(`No ACP agent "${named.agent}" is available. canvas_overview lists the ones the owner added and shows in New session (Settings › ACP agents); for Claude or Codex use claude or codex.`);
          if (!agent.installed) return fail(`${agent.name} is not installed on this Mac, so it cannot take the task.`);
          provider = acpCardId(agent.id);
        } else provider = named.provider;
      }
      let attachments: Attachment[] = [];
      try {
        attachments = await api.keepAttachments(args.attachments ?? []);
      } catch (err) {
        return fail(`The task did not start: ${errText(err)}`);
      }
      // Waiting for other sessions: queued, and handed to the orchestrator when they finish.
      if (args.after && args.after.length > 0) {
        const queued = queueTask(api, { cwd, provider, model: args.model ?? null, effort: args.effort, mode: args.mode ?? null, prompt: args.prompt, attachments,
          after: args.after, afterMode: args.afterMode, handOff: args.handOff });
        if (!queued.isError) api.applyLayout({ type: 'addFolderZone', path: cwd });
        return queued;
      }
      let id: string;
      try {
        id = await api.startSession({ provider, cwd, model: args.model ?? null, mode: args.mode ?? null, text: args.prompt,
          ...(args.effort !== undefined ? { effort: args.effort } : {}),
          ...(attachments.length > 0 ? { attachments } : {}) });
      } catch (err) {
        return fail(`The task did not start: ${errText(err)}`);
      }
      // The folder's zone is on the canvas from now on, and knows its folder.
      api.applyLayout({ type: 'addFolderZone', path: cwd });
      const sent = attachments.length > 0 ? ` with ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}` : '';
      return ok(`Handed the task${sent} to the project orchestrator for ${cwd}. Its chat id is ${id}.`);
    },
  }),
  define({
    name: 'add_image',
    description: 'Puts an image file on the canvas, by its absolute path (PNG, JPEG, GIF, WebP, AVIF, SVG or BMP). With zoneId it goes into that zone below its cards and moves with it; without, it floats free beside the zones. The board shows the file as it is on disk, so later edits to it show. Answers with the image id.',
    shape: {
      path: z.string().describe('The absolute path of the image file'),
      zoneId: z.string().optional().describe('The zone to put it in; leave out for a free image'),
      caption: z.string().max(MAX_CAPTION).optional().describe('A short caption shown under it'),
    },
    safe: true,
    handler: async (api, args) => {
      if (!args.path.startsWith('/')) return fail(`${args.path} is not an absolute path.`);
      const file = path.resolve(args.path);
      if (!isImagePath(file)) return fail(`${file} is not an image the board can show (PNG, JPEG, GIF, WebP, AVIF, SVG or BMP).`);
      const kind = await api.folderKind(file);
      if (kind !== 'file') return fail(kind === 'dir' ? `${file} is a folder, not an image.` : `The file ${file} does not exist.`);
      const snap = api.snapshot();
      const zone = args.zoneId === undefined ? undefined : zoneOf(snap, args.zoneId);
      if (args.zoneId !== undefined && !zone) return noZone(args.zoneId);
      const item = agentImage(snap.layout, file, zone?.id ?? null, args.caption);
      api.applyLayout({ type: 'addItem', item });
      if (!api.snapshot().layout.items?.some((it) => it.id === item.id)) return fail('The image could not be added (the board may be full).');
      return ok(`Added the image ${item.name} (id ${item.id}) ${zone ? `to the zone "${zone.name}"` : 'to the canvas, free beside the zones'}.`);
    },
  }),
  define({
    name: 'remove_image',
    description: 'Takes an image off the canvas, by its id (canvas_overview lists the images) or by its file path (every image showing that file). The file itself is never touched. The owner may be asked first.',
    shape: {
      id: z.string().optional().describe('The image id'),
      path: z.string().optional().describe('Instead of id: the absolute path of the image file'),
    },
    safe: false,
    handler: async (api, args) => {
      if ((args.id === undefined) === (args.path === undefined)) return fail('Give either id or path, not both and not neither.');
      const items = api.snapshot().layout.items ?? [];
      const file = args.path === undefined ? null : path.resolve(args.path);
      const gone = items.filter((it) => it.kind === 'image' && (file === null ? it.id === args.id : it.src.kind === 'path' && it.src.path === file));
      if (gone.length === 0) return fail(file === null ? `No image has the id ${args.id}. canvas_overview lists the images.` : `No image on the canvas shows ${file}.`);
      for (const it of gone) api.applyLayout({ type: 'removeItem', id: it.id });
      return ok(gone.length === 1 ? `Took ${gone[0]!.kind === 'image' ? gone[0]!.name : 'the image'} off the canvas.` : `Took ${gone.length} images of ${file} off the canvas.`);
    },
  }),
  define({
    name: 'get_usage_summary',
    description: "How many tokens, and roughly what cost or share of plan usage, Agent canvas's own agents used (this canvas agent, each project orchestrator, internal calls) against the sessions doing the work, for a period. Read-only.",
    shape: { period: z.enum(USAGE_PERIODS as [UsagePeriod, ...UsagePeriod[]]).optional().describe('today, 7d (default), 30d or all') },
    safe: true, readOnly: true,
    handler: async (api, { period }) => {
      if (!api.usageSummary) return fail('Usage is not available in this app.');
      return ok(usageReport(await api.usageSummary(period ?? '7d')));
    },
  }),
  ...linkTools(define),
  ...threadTools(define),
  ...noteTools(define),
];

/** The tools that run without asking, by the names Claude Code knows them by (`allowedTools`). */
export const SAFE_TOOL_IDS: string[] = CANVAS_TOOLS.filter((t) => t.safe).map((t) => toolId(t.name));
/** The tools that follow the session's mode: they ask in Ask or Read only, never in Bypass or Full access. */
export const ASKING_TOOLS: string[] = CANVAS_TOOLS.filter((t) => !t.safe).map((t) => t.name);
