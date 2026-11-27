// Reads the Claude app's per-process session status files: <sessionsDir>/<pid>.json.
// Writers do read-modify-write, so a file can be caught half-written ("torn").
// Never opens the <pid>.<hex>.key files that sit beside them.
import fs from 'node:fs/promises';
import path from 'node:path';

export interface RawSession {
  pid: number;
  sessionId: string;
  hostSessionId: string | null;
  cwd: string;
  name: string;
  /** How the app got the name: 'derived' is its own folder-plus-two-letters placeholder, not a title. */
  nameSource: string | null;
  status: string;
  waitingFor: string | null;
  startedAt: number;
  statusUpdatedAt: number;
  procStart: string | null;
}

const SESSION_FILE = /^\d+\.json$/;

/** Last sessionId seen in each file, so a torn file can still be named by its session. */
const knownIds = new Map<string, string>();

/** Drops remembered ids for files of this folder that are no longer listed. */
function pruneKnownIds(sessionsDir: string, listed: Set<string>): void {
  for (const file of knownIds.keys()) {
    if (path.dirname(file) === sessionsDir && !listed.has(path.basename(file))) knownIds.delete(file);
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function toRaw(o: unknown, fileName: string): RawSession | null {
  if (typeof o !== 'object' || o === null) return null;
  const r = o as Record<string, unknown>;
  const sessionId = str(r.sessionId);
  if (!sessionId) return null;
  const startedAt = num(r.startedAt) ?? 0;
  return {
    pid: num(r.pid) ?? Number(fileName.slice(0, -'.json'.length)),
    sessionId,
    hostSessionId: str(r.hostSessionId),
    cwd: str(r.cwd) ?? '',
    name: str(r.name) ?? '',
    nameSource: str(r.nameSource),
    status: str(r.status) ?? '',
    waitingFor: str(r.waitingFor),
    startedAt,
    statusUpdatedAt: num(r.statusUpdatedAt) ?? num(r.updatedAt) ?? startedAt,
    procStart: str(r.procStart),
  };
}

/**
 * Every readable session file, in file-name order. Two files can share a sessionId (a resumed
 * session whose old process has not cleaned up); onePerSession chooses between them once
 * liveness is known.
 */
export async function readSessionFiles(sessionsDir: string): Promise<{ sessions: RawSession[]; torn: string[] }> {
  let names: string[];
  try {
    names = await fs.readdir(sessionsDir);
  } catch {
    pruneKnownIds(sessionsDir, new Set());
    return { sessions: [], torn: [] };
  }
  pruneKnownIds(sessionsDir, new Set(names));
  const sessions: RawSession[] = [];
  const torn: string[] = [];
  for (const name of names.filter((n) => SESSION_FILE.test(n)).sort()) {
    const file = path.join(sessionsDir, name);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue; // removed between readdir and read: the process exited
    }
    let raw: RawSession | null = null;
    try {
      raw = toRaw(JSON.parse(text), name);
    } catch {
      raw = null;
    }
    if (!raw) {
      torn.push(knownIds.get(file) ?? name);
      continue;
    }
    knownIds.set(file, raw.sessionId);
    sessions.push(raw);
  }
  return { sessions, torn };
}

/** One file per sessionId among the live ones (`alive[i]` belongs to `files[i]`): the larger statusUpdatedAt wins. */
export function onePerSession(files: RawSession[], alive: boolean[]): RawSession[] {
  const bySession = new Map<string, RawSession>();
  for (const [i, raw] of files.entries()) {
    if (!alive[i]) continue;
    const prev = bySession.get(raw.sessionId);
    if (!prev || raw.statusUpdatedAt > prev.statusUpdatedAt) bySession.set(raw.sessionId, raw);
  }
  return [...bySession.values()];
}
