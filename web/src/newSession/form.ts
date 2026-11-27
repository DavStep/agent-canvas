// The New session dialog's choices, kept pure: the folders it offers, and the form's state as the
// owner switches provider, picks a model and types the first message.
import { withFiles, type FileRef } from '../../../shared/attachments.ts';
import type { NewSessionRequest, ProviderOptions } from '../../../shared/bridge.ts';
import { effortFor } from '../../../shared/settings.ts';
import type { ImageRef, SessionProvider } from '../../../shared/chat.ts';
import type { Layout, SessionView, ZoneLayout } from '../../../shared/types.ts';

export const CHOOSE_FOLDER = 'Choose folder…';
/** As the reader's folderOf: a worktree belongs to the repository it was made from. */
const WORKTREES = '/.claude/worktrees/';

export type FolderChoice =
  | { kind: 'folder'; label: string; path: string; hueIndex: number | null; color?: string; icon?: ZoneLayout['icon'] }
  | { kind: 'choose'; label: string; path: null; hueIndex: null; color?: undefined; icon?: undefined };

const lastSegment = (p: string): string => p.split('/').filter((s) => s !== '').at(-1) ?? p;

/** The folder a session's zone stands for: its working directory, or the repository of a worktree. */
export function rootOf(cwd: string): string {
  const wt = cwd.indexOf(WORKTREES);
  return wt === -1 ? cwd : cwd.slice(0, wt);
}

/** Each folder's path, from the session there used most recently, and when that was. */
function latestPaths(sessions: SessionView[]): Map<string, { path: string; at: number }> {
  const latest = new Map<string, { path: string; at: number }>();
  for (const s of sessions) {
    if (s.folder === '' || s.cwd === '') continue;
    const at = Math.max(s.stateSince, s.startedAt);
    const known = latest.get(s.folder);
    if (!known || at > known.at) latest.set(s.folder, { path: rootOf(s.cwd), at });
  }
  return latest;
}

/** The folder a zone's "+" starts a session in: where its latest session ran, else the folder the
    zone was made for; or null (a custom zone, "No folder", or neither known). */
export function zoneFolder(zone: ZoneLayout, sessions: SessionView[]): string | null {
  if (zone.kind !== 'folder' || !zone.folder) return null;
  return latestPaths(sessions).get(zone.folder)?.path ?? zone.path ?? null;
}

/**
 * The zones' folders, most recently used first, then "Choose folder…". A folder zone stands for
 * the folder its sessions ran in (the latest one's); the "No folder" zone offers none. Folders the
 * owner picked in this dialog (`picked`, newest first) come before them all.
 */
export function folderChoices(sessions: SessionView[], layout: Layout, picked: string[] = []): FolderChoice[] {
  const latest = latestPaths(sessions);
  const zones = layout.zones
    .flatMap((z) => {
      const used = z.kind === 'folder' && z.folder ? latest.get(z.folder) : undefined;
      return used ? [{ label: z.name, path: used.path, hueIndex: z.hueIndex, color: z.color, icon: z.icon, at: used.at }] : [];
    })
    .sort((a, b) => b.at - a.at);
  const byPath = new Map(zones.map((z) => [z.path, z]));
  const first: FolderChoice[] = [...new Set(picked)].map((path) => {
    const zone = byPath.get(path);
    return { kind: 'folder', label: zone?.label ?? lastSegment(path), path, hueIndex: zone?.hueIndex ?? null, color: zone?.color, icon: zone?.icon };
  });
  const rest: FolderChoice[] = zones.filter((z) => !picked.includes(z.path))
    .map(({ label, path, hueIndex, color, icon }) => ({ kind: 'folder', label, path, hueIndex, color, icon }));
  return [...first, ...rest, { kind: 'choose', label: CHOOSE_FOLDER, path: null, hueIndex: null }];
}

export interface NewSessionForm {
  provider: SessionProvider;
  /** The ACP agent's id when provider is 'acp', else null. */
  agent: string | null;
  cwd: string | null;
  /** null until the provider's options have arrived. */
  model: string | null;
  /** The thinking level; null: the model's own default (or it has none to pick). */
  effort: string | null;
  mode: string | null;
  text: string;
}

export function initialForm(provider: SessionProvider, cwd: string | null): NewSessionForm {
  return { provider, agent: null, cwd, model: null, effort: null, mode: null, text: '' };
}

/** What the "Start with" choice is: 'claude', 'codex', or `acp:<agent id>`. Options are kept by it. */
export type ProviderChoice = string;
export const choiceOf = (form: Pick<NewSessionForm, 'provider' | 'agent'>): ProviderChoice =>
  form.provider === 'acp' ? `acp:${form.agent ?? ''}` : form.provider;
/** A choice back as the form's provider and agent. */
export function fromChoice(choice: ProviderChoice): { provider: SessionProvider; agent: string | null } {
  if (choice.startsWith('acp:')) return { provider: 'acp', agent: choice.slice(4) };
  return { provider: choice === 'codex' ? 'codex' : 'claude', agent: null };
}

/** An agent may offer no permission modes at all: then there is no mode to pick. */
const modeOf = (options: ProviderOptions | null): string | null => (options?.mode ? options.mode : null);

/** Another provider: its own default model and mode (or none until its options arrive). */
export function switchProvider(form: NewSessionForm, choice: ProviderChoice, options: ProviderOptions | null): NewSessionForm {
  return { ...form, ...fromChoice(choice), model: options?.model ?? null, effort: options?.effort ?? null, mode: modeOf(options) };
}

/** Another model: the thinking level stays when the model takes it, else the model's own. */
export function chooseModel(form: NewSessionForm, options: ProviderOptions | null, model: string): NewSessionForm {
  return { ...form, model, effort: effortFor(options?.models.find((m) => m.id === model), form.effort) };
}

/** A provider's options arrived: the current provider's fill in what is not chosen yet. */
export function withOptions(form: NewSessionForm, choice: ProviderChoice, options: ProviderOptions): NewSessionForm {
  if (choice !== choiceOf(form) || (form.model !== null && form.mode !== null)) return form;
  if (form.model !== null) return { ...form, mode: form.mode ?? modeOf(options) };
  return { ...form, model: options.model, effort: options.effort, mode: form.mode ?? modeOf(options) };
}

/** A folder and a first message (words, images, files or any of them), and no start already on its way. */
export function canStart(form: NewSessionForm, starting: boolean, images: ImageRef[] = [], files: FileRef[] = []): boolean {
  return !starting && form.cwd !== null && (form.text.trim() !== '' || images.length > 0 || files.length > 0);
}

/** The provider's own default model goes as null, so the engine picks it (for Codex, explicitly);
    a default saved in Settings goes by its id.
    Files go by path in the text, the way the provider's own app writes them. */
export function startRequest(form: NewSessionForm, options: ProviderOptions | null, images: ImageRef[] = [], files: FileRef[] = []): NewSessionRequest {
  if (form.cwd === null) throw new Error('Choose a folder first');
  const own = options?.models.find((m) => m.id === form.model)?.isDefault === true;
  const model = form.model !== null && own ? null : form.model;
  if (form.provider === 'acp' && !form.agent) throw new Error('Choose an agent first');
  return {
    provider: form.provider, cwd: form.cwd, model, effort: form.effort, mode: form.mode, text: withFiles(form.provider, form.text, files), images,
    ...(form.provider === 'acp' ? { agent: form.agent! } : {}),
  };
}
