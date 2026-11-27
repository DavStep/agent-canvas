// Finding folders on this Mac by name, for the canvas agent's `find_folders`: Spotlight first
// (`mdfind`, run with arguments, never through a shell), merged with a shallow look into the
// places projects usually live, so a folder Spotlight has not indexed is still found. Hidden
// folders, node_modules and ~/Library are left out. The disk and the program runner are injected.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface FoundFolder { path: string; git: boolean }

export interface FolderDeps {
  home: string;
  /** Runs a program with arguments and resolves with what it printed; rejects on failure or timeout. */
  run(file: string, args: string[], timeoutMs: number): Promise<string>;
  /** The names of the folders directly inside `dir` (not files); rejects when it cannot be read. */
  subfolders(dir: string): Promise<string[]>;
  exists(p: string): Promise<boolean>;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
const MDFIND_TIMEOUT_MS = 4_000;
/** Spotlight results read before ranking; a common word can match thousands. */
const MAX_CANDIDATES = 2_000;
/** Where projects usually live, and how many levels below each are looked at. */
const SCAN_ROOTS: [dir: string, depth: number][] = [
  ['Documents', 2], ['Desktop', 2], ['Developer', 2], ['Projects', 2], ['code', 2], ['', 1],
];
const SKIPPED = new Set(['node_modules', 'Library']);

export const realFolderDeps: FolderDeps = {
  home: os.homedir(),
  run: (file, args, timeoutMs) => new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  }),
  subfolders: async (dir) => (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name),
  exists: (p) => fs.stat(p).then(() => true, () => false),
};

/** The query as Spotlight's name pattern takes it: quotes, backslashes and wildcards dropped. */
const forSpotlight = (query: string): string => query.replace(/["'\\*?]/g, '').trim();

/** Whether a path under `home` is one to offer: no hidden step, no node_modules, not ~/Library. */
function offered(p: string, home: string): boolean {
  if (p !== home && !p.startsWith(home + path.sep)) return false;
  const steps = path.relative(home, p).split(path.sep).filter((s) => s !== '');
  if (steps.length === 0 || steps[0] === 'Library') return false;
  return !steps.some((s) => s.startsWith('.') || SKIPPED.has(s));
}

/** Every word of the query is in the folder's name (case ignored). */
function matches(name: string, words: string[]): boolean {
  const n = name.toLowerCase();
  return words.every((w) => n.includes(w));
}

/** Lower is better: the name is the query, starts with it, or only contains it. */
function nameRank(p: string, query: string): number {
  const name = path.basename(p).toLowerCase();
  return name === query ? 0 : name.startsWith(query) ? 1 : 2;
}

async function spotlight(query: string, deps: FolderDeps): Promise<string[]> {
  const q = forSpotlight(query);
  if (q === '') return [];
  try {
    const out = await deps.run('/usr/bin/mdfind', ['-onlyin', deps.home, `kMDItemContentType == "public.folder" && kMDItemFSName == "*${q}*"cd`], MDFIND_TIMEOUT_MS);
    return out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/')).slice(0, MAX_CANDIDATES);
  } catch {
    return []; // Spotlight off, slow or missing: the scan below still answers
  }
}

async function scan(dir: string, depth: number, words: string[], deps: FolderDeps, out: string[]): Promise<void> {
  let names: string[];
  try {
    names = await deps.subfolders(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith('.') || SKIPPED.has(name)) continue;
    const p = path.join(dir, name);
    if (matches(name, words)) out.push(p);
    if (depth > 1) await scan(p, depth - 1, words, deps, out);
  }
}

/** Folders under the home folder whose name has every word of `query`, most relevant first: an
    exact name, then a name that starts with it, then git repositories, then the shortest path. */
export async function findFolders(query: string, limit: number = DEFAULT_LIMIT, deps: FolderDeps = realFolderDeps): Promise<FoundFolder[]> {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [];
  const cap = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number.isFinite(limit) ? limit : DEFAULT_LIMIT)));
  const scanned: string[] = [];
  const [indexed] = await Promise.all([
    spotlight(query, deps),
    ...SCAN_ROOTS.map(([dir, depth]) => scan(dir === '' ? deps.home : path.join(deps.home, dir), depth, words, deps, scanned)),
  ]);
  const paths = [...new Set([...indexed, ...scanned].map((p) => path.normalize(p)))]
    .filter((p) => offered(p, deps.home) && matches(path.basename(p), words));
  // Only the best names are checked for .git: a common word can match a great many folders.
  paths.sort((a, b) => nameRank(a, q) - nameRank(b, q) || a.length - b.length || (a < b ? -1 : 1));
  const best = paths.slice(0, cap * 3);
  const found = await Promise.all(best.map(async (p): Promise<FoundFolder> => ({ path: p, git: await deps.exists(path.join(p, '.git')) })));
  found.sort((a, b) => nameRank(a.path, q) - nameRank(b.path, q) || Number(b.git) - Number(a.git) || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  return found.slice(0, cap);
}
