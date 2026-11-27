// The usage store: token usage summed per chat, turn and model, kept in <dataHome>/usage/usage.json
// with how far each transcript has been read. A scan reads only what the transcripts gained since
// the last one (read-only over them), so the first scan backfills all history and later ones cost
// little. Which chats are overhead is decided when a summary is asked for (summary.ts), so the
// orchestrators a project has had are remembered here too.
//
// Live usage no transcript records (an internal model call, an ACP agent's turn) is added with
// record().
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { UsagePeriod, UsageSummary } from '../../shared/usage.ts';
import { claudeLine, claudeState, codexLine, codexState, CODEX_PREFIX, type ClaudeFileState, type CodexFileState, type UsageDelta } from './parse.ts';
import { summarize, type ProjectRoleInfo, type UsageBucket } from './summary.ts';
import { isAgentConnection } from '../../shared/agentConnection.ts';

/** Bump when parse.ts counts differently: the store then reads every transcript again. */
const VERSION = 1;
const CHUNK = 4 * 1024 * 1024;
/** While backfilling, progress is saved this often, so a quit does not lose it. */
const SAVE_EVERY_MS = 20_000;
/** How long a summary waits for a scan before answering with what is known so far. */
const SUMMARY_WAIT_MS = 1500;

type FileState =
  | { kind: 'claude'; size: number; offset: number; parser: ClaudeFileState }
  | { kind: 'codex'; size: number; offset: number; parser: CodexFileState };

interface UsageFile {
  version: number;
  files: Record<string, FileState>;
  buckets: UsageBucket[];
  roles: Record<string, ProjectRoleInfo>;
  /** The first scan read every transcript to its end (a quit can stop it halfway). */
  backfilled: boolean;
}

export interface UsageStoreOptions {
  /** The folder usage.json lives in; null keeps everything in memory (demo, tests). */
  dir: string | null;
  claudeHome: string | null;
  codexHome: string | null;
  /** The canvas agent's folder. */
  agentCwd: string | null;
  /** The orchestrator chats now on record (sessions.json), by card id. */
  roles(): Record<string, ProjectRoleInfo>;
  now?(): number;
  log?(msg: string): void;
}

interface Found { key: string; file: string; kind: 'claude' | 'codex'; session: string; sub: string | null }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isUsageFile(v: unknown): v is UsageFile {
  return isRecord(v) && typeof v.version === 'number' && isRecord(v.files) && Array.isArray(v.buckets) && isRecord(v.roles) && typeof v.backfilled === 'boolean'
    && Object.values(v.roles).every(r => isRecord(r) && typeof r.folder === 'string' && isAgentConnection(r.connection));
}

async function listDir(dir: string): Promise<import('node:fs').Dirent[]> {
  try { return await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

/** Claude Code's transcripts: <projects>/<folder>/<session>.jsonl and <session>/subagents/*.jsonl. */
async function claudeFiles(home: string): Promise<Found[]> {
  const root = path.join(home, 'projects');
  const out: Found[] = [];
  for (const folder of await listDir(root)) {
    if (!folder.isDirectory()) continue;
    const dir = path.join(root, folder.name);
    for (const e of await listDir(dir)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const session = e.name.slice(0, -'.jsonl'.length);
        out.push({ key: `claude:${folder.name}/${e.name}`, file: path.join(dir, e.name), kind: 'claude', session, sub: null });
      } else if (e.isDirectory()) {
        const subDir = path.join(dir, e.name, 'subagents');
        for (const s of await listDir(subDir)) {
          if (s.isFile() && s.name.endsWith('.jsonl')) {
            out.push({ key: `claude:${folder.name}/${e.name}/${s.name}`, file: path.join(subDir, s.name), kind: 'claude', session: e.name, sub: s.name.slice(0, -'.jsonl'.length) });
          }
        }
      }
    }
  }
  return out;
}

/** Codex's rollouts, live and archived. Keyed by file name, so archiving one (a move) reads nothing twice. */
async function codexFiles(home: string): Promise<Found[]> {
  const out: Found[] = [];
  const walk = async (dir: string, depth: number) => {
    for (const e of await listDir(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) await walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        out.push({ key: `codex:${e.name}`, file: p, kind: 'codex', session: '', sub: null });
      }
    }
  };
  await walk(path.join(home, 'sessions'), 0);
  await walk(path.join(home, 'archived_sessions'), 0);
  return out;
}

const bucketKey = (d: Pick<UsageDelta, 'provider' | 'session' | 'turn' | 'model' | 'long' | 'kind' | 'label'>): string =>
  `${d.provider}\t${d.session}\t${d.turn}\t${d.model}\t${d.long ? 1 : 0}\t${d.kind ?? ''}\t${d.label ?? ''}`;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

export class UsageStore {
  private files: Record<string, FileState> = {};
  private buckets = new Map<string, UsageBucket>();
  private roles: Record<string, ProjectRoleInfo> = {};
  private loaded: Promise<void> | null = null;
  private scanning: Promise<void> | null = null;
  private backfilled = false;
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly opts: UsageStoreOptions) {
    this.now = opts.now ?? Date.now;
  }

  private get file(): string | null { return this.opts.dir === null ? null : path.join(this.opts.dir, 'usage.json'); }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const file = this.file;
      if (file === null) return;
      let data: unknown = null;
      try { data = JSON.parse(await fs.readFile(file, 'utf8')); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.opts.log?.(`usage.json unreadable, reading the transcripts again: ${(err as Error).message}`);
      }
      if (!isUsageFile(data)) return;
      this.roles = data.roles;
      // A new parser version reads everything again; the orchestrators on record are kept.
      if (data.version !== VERSION) return;
      this.files = data.files;
      for (const b of data.buckets) this.buckets.set(bucketKey(b), b);
      this.backfilled = data.backfilled;
    })();
    return this.loaded;
  }

  /** Adds one call's usage (or what grew of it). */
  add(d: UsageDelta): void {
    const key = bucketKey(d);
    const b = this.buckets.get(key);
    if (b) {
      b.input += d.input; b.output += d.output; b.cacheRead += d.cacheRead; b.cacheWrite += d.cacheWrite; b.cacheWrite1h += d.cacheWrite1h;
      b.calls += d.calls; b.at = Math.min(b.at, d.at); b.last = Math.max(b.last, d.at);
      if (d.cwd) b.cwd = d.cwd;
    } else {
      const { provider, session, cwd, model, turn, long, at, input, output, cacheRead, cacheWrite, cacheWrite1h, calls, kind, label } = d;
      this.buckets.set(key, { provider, session, cwd, model, turn, long, at, last: at, input, output, cacheRead, cacheWrite, cacheWrite1h, calls,
        ...(kind ? { kind } : {}), ...(label ? { label } : {}) });
    }
    this.dirty = true;
  }

  /** Live usage no transcript keeps (an internal model call, an ACP turn). Saved soon after. */
  record(d: UsageDelta): void {
    void this.load().then(() => { this.add(d); return this.save(); }).catch(err => this.opts.log?.(`usage not saved: ${(err as Error).message}`));
  }

  /** Reads what the transcripts gained since the last scan. One scan runs at a time. */
  scan(): Promise<void> {
    this.scanning ??= this.runScan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private async runScan(): Promise<void> {
    await this.load();
    const found = [
      ...(this.opts.claudeHome ? await claudeFiles(this.opts.claudeHome) : []),
      ...(this.opts.codexHome ? await codexFiles(this.opts.codexHome) : []),
    ];
    let lastSave = this.now();
    for (const f of found) {
      try { await this.readFile(f); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.opts.log?.(`usage: cannot read ${f.file}: ${(err as Error).message}`);
      }
      if (this.dirty && this.now() - lastSave > SAVE_EVERY_MS) { await this.save(); lastSave = this.now(); }
    }
    if (!this.backfilled) { this.backfilled = true; this.dirty = true; }
    await this.save();
  }

  private async readFile(f: Found): Promise<void> {
    const stat = await fs.stat(f.file);
    let state = this.files[f.key];
    if (state && stat.size === state.size) return;
    if (!state) {
      state = f.kind === 'claude'
        ? { kind: 'claude', size: 0, offset: 0, parser: claudeState(f.session, '', f.sub) }
        // session_meta names the thread; until then, the first id in the file name does.
        : { kind: 'codex', size: 0, offset: 0, parser: codexState(CODEX_PREFIX + (UUID.exec(path.basename(f.file))?.[0] ?? path.basename(f.file))) };
      this.files[f.key] = state;
    }
    // A file rewritten shorter: what it held is counted already; read on from its new end.
    if (stat.size < state.offset) { state.offset = stat.size; state.size = stat.size; this.dirty = true; return; }
    const handle = await fs.open(f.file, 'r');
    try {
      const now = this.now();
      let pos = state.offset;
      // The start of a line cut by a chunk's end stays at the buffer's start (`kept` bytes).
      let buf = Buffer.allocUnsafe(CHUNK * 2);
      let kept = 0;
      while (pos < stat.size) {
        if (buf.length - kept < CHUNK) {
          const bigger = Buffer.allocUnsafe(kept + CHUNK * 2);
          buf.copy(bigger, 0, 0, kept);
          buf = bigger;
        }
        const { bytesRead } = await handle.read(buf, kept, Math.min(CHUNK, stat.size - pos), pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        const end = kept + bytesRead;
        let start = 0;
        for (let nl = buf.indexOf(10, start); nl !== -1 && nl < end; nl = buf.indexOf(10, start)) {
          const line = buf.subarray(start, nl);
          const d = state.kind === 'claude' ? claudeLine(line, state.parser, now) : codexLine(line, state.parser, now);
          if (d) this.add(d);
          start = nl + 1;
          if (start >= end) break;
        }
        // A line still being written waits for the next scan.
        state.offset = pos - (end - start);
        buf.copy(buf, 0, start, end);
        kept = end - start;
        await tick();
      }
      state.size = stat.size;
      this.dirty = true;
    } finally {
      await handle.close();
    }
  }

  private save(): Promise<void> {
    const file = this.file;
    if (file === null || !this.dirty) return this.saving;
    this.dirty = false;
    const data: UsageFile = { version: VERSION, files: this.files, buckets: [...this.buckets.values()], roles: this.roles, backfilled: this.backfilled };
    const text = JSON.stringify(data);
    this.saving = this.saving.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp-${process.pid}`;
      await fs.writeFile(tmp, text, { mode: 0o600 });
      await fs.rename(tmp, file);
    }).catch(err => { this.dirty = true; this.opts.log?.(`usage.json not saved: ${(err as Error).message}`); });
    return this.saving;
  }

  /** Remembers the orchestrators on record, so one a newer orchestrator replaced stays overhead. */
  private rememberRoles(): void {
    for (const [id, role] of Object.entries(this.opts.roles())) {
      const prev = this.roles[id];
      if (!prev || prev.folder !== role.folder || prev.connection !== role.connection) { this.roles[id] = role; this.dirty = true; }
    }
  }

  /** The period's usage. Scans first, waiting a moment; during the first (long) scan it answers
      with what is read so far and says so. */
  async summary(period: UsagePeriod): Promise<UsageSummary> {
    await this.load();
    this.rememberRoles();
    const scan = this.scan();
    await Promise.race([scan, new Promise(resolve => setTimeout(resolve, SUMMARY_WAIT_MS))]);
    return summarize(this.buckets.values(), {
      period, now: this.now(), agentCwd: this.opts.agentCwd, roles: this.roles, backfilling: !this.backfilled,
    });
  }
}
