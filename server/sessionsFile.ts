// ~/.agent-canvas/sessions.json: the sessions started here, and the model and permission mode the
// owner picked for each chat. Written atomically (0600, folder 0700); a damaged file is moved
// aside and the list starts empty. Without a file (demo mode) it lives in memory only.
import { isAgentConnection } from '../shared/agentConnection.ts';
import type { ProjectRole } from './agent/project.ts';
import type { Provider } from '../shared/chat.ts';
import { loadJson, saveJsonAtomic } from './persist.ts';

export interface StartedSession { id: string; provider: Provider; cwd: string; startedAt: number }
export interface ChatSettings { model: string | null; mode: string | null; effort?: string | null }
interface ProjectChat extends ProjectRole { id: string }
interface SessionsData { projects?: ProjectChat[]; version: 1; started: StartedSession[]; settings: Record<string, ChatSettings> }

/** The newest entries kept of each list. */
const MAX_STARTED = 500;
const MAX_SETTINGS = 1000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNullableString = (v: unknown): boolean => v === null || typeof v === 'string';

function isStarted(v: unknown): v is StartedSession {
  return isRecord(v) && typeof v.id === 'string' && (v.provider === 'claude' || v.provider === 'codex')
    && typeof v.cwd === 'string' && typeof v.startedAt === 'number' && Number.isFinite(v.startedAt);
}

function isSessionsData(v: unknown): v is SessionsData {
  return isRecord(v) && v.version === 1 && Array.isArray(v.started) && v.started.every(isStarted) && isRecord(v.settings)
    && (v.projects === undefined || (Array.isArray(v.projects) && v.projects.every(p => isRecord(p) && typeof p.id === 'string' && typeof p.folder === 'string' && isAgentConnection(p.connection))))
    && Object.values(v.settings).every((s) => isRecord(s) && isNullableString(s.model) && isNullableString(s.mode) && (s.effort === undefined || isNullableString(s.effort)));
}

export class SessionsFile {
  /** Saves run one after another, each writing the latest data. */
  private chain: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string | null, private data: SessionsData) {}

  static async load(file: string | null): Promise<SessionsFile> {
    const empty: SessionsData = { version: 1, started: [], settings: {} };
    return new SessionsFile(file, file === null ? empty : await loadJson(file, empty, isSessionsData));
  }

  projectChats(): Record<string, string> {
    return Object.fromEntries((this.data.projects ?? []).map(p => [p.folder, p.id]));
  }

  project(folder: string): ProjectChat | undefined { return this.data.projects?.find(p => p.folder === folder); }

  role(id: string): ProjectChat | undefined { return this.data.projects?.find(p => p.id === id); }

  recordProject(project: ProjectChat): Promise<void> {
    this.data = { ...this.data, projects: [...(this.data.projects ?? []).filter(p => p.folder !== project.folder), project] };
    return this.save();
  }

  started(): StartedSession[] {
    return this.data.started;
  }

  settings(id: string): ChatSettings {
    return this.data.settings[id] ?? { model: null, mode: null };
  }

  recordStarted(s: StartedSession): Promise<void> {
    const started = [...this.data.started.filter((x) => x.id !== s.id), s].slice(-MAX_STARTED);
    this.data = { ...this.data, started };
    return this.save();
  }

  setSettings(id: string, patch: Partial<ChatSettings>): Promise<void> {
    const { [id]: previous, ...rest } = this.data.settings;
    const prev = previous ?? { model: null, mode: null };
    const next: ChatSettings = { model: patch.model !== undefined ? patch.model : prev.model, mode: patch.mode !== undefined ? patch.mode : prev.mode, ...((patch.effort !== undefined || prev.effort !== undefined) ? { effort: patch.effort !== undefined ? patch.effort : prev.effort } : {}) };
    // Re-inserted last, so the least recently changed are the ones dropped past the cap.
    const entries = Object.entries({ ...rest, [id]: next }).slice(-MAX_SETTINGS);
    this.data = { ...this.data, settings: Object.fromEntries(entries) };
    return this.save();
  }

  private save(): Promise<void> {
    const file = this.file;
    if (file === null) return Promise.resolve();
    this.chain = this.chain.catch(() => {}).then(() => saveJsonAtomic(file, this.data));
    return this.chain;
  }
}
