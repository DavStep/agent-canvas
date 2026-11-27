// ~/.agent-canvas/acp-sessions.json: the ACP sessions started here. ACP keeps no files the app
// can read, so these are the cards' only source: which agent, its session id, the folder, and
// what the card shows. Written atomically; a damaged file is moved aside. Without a file (demo
// mode, tests) it lives in memory only.
import { isAcpAgentId, isAcpIcon, type AcpIcon } from '../../../shared/acp.ts';
import { loadJson, saveJsonAtomic } from '../../persist.ts';

export interface AcpRecord {
  /** The app's own id (the card is `acp:<id>`). */
  id: string;
  agent: string;
  /** Kept so the card still names its agent after the agent leaves Settings. */
  agentName: string;
  icon: AcpIcon;
  /** The agent's session id (session/load, session/prompt). */
  sessionId: string;
  cwd: string;
  title: string;
  startedAt: number;
  updatedAt: number;
  lastPrompt: string | null;
  lastAnswer: string | null;
  model: string | null;
  mode: string | null;
}

interface Data { version: 1; sessions: AcpRecord[] }

const MAX = 500;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => typeof v === 'string';
const nstr = (v: unknown) => v === null || typeof v === 'string';
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

function isAcpRecord(v: unknown): v is AcpRecord {
  return isRecord(v) && str(v.id) && isAcpAgentId(v.agent) && str(v.agentName) && isAcpIcon(v.icon) && str(v.sessionId) && str(v.cwd)
    && str(v.title) && num(v.startedAt) && num(v.updatedAt) && nstr(v.lastPrompt) && nstr(v.lastAnswer) && nstr(v.model) && nstr(v.mode);
}
const isData = (v: unknown): v is Data => isRecord(v) && v.version === 1 && Array.isArray(v.sessions) && v.sessions.every(isAcpRecord);

export class AcpRecords {
  private chain: Promise<void> = Promise.resolve();
  private constructor(private readonly file: string | null, private data: Data) {}

  static async load(file: string | null): Promise<AcpRecords> {
    const empty: Data = { version: 1, sessions: [] };
    return new AcpRecords(file, file === null ? empty : await loadJson(file, empty, isData));
  }

  all(): AcpRecord[] { return this.data.sessions; }
  get(id: string): AcpRecord | undefined { return this.data.sessions.find((s) => s.id === id); }

  /** Adds or replaces one record (by id) and saves. */
  put(r: AcpRecord): Promise<void> {
    this.data = { version: 1, sessions: [...this.data.sessions.filter((s) => s.id !== r.id), r].slice(-MAX) };
    return this.save();
  }

  patch(id: string, p: Partial<Omit<AcpRecord, 'id'>>): Promise<void> {
    const r = this.get(id);
    return r ? this.put({ ...r, ...p }) : Promise.resolve();
  }

  private save(): Promise<void> {
    const file = this.file;
    if (file === null) return Promise.resolve();
    this.chain = this.chain.catch(() => {}).then(() => saveJsonAtomic(file, this.data));
    return this.chain;
  }
}
