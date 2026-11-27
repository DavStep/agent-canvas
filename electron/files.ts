// The project explorer's disk access, in the main process: read-only, one directory or one file
// per call, and confined to a zone's folder. The page names a root (which must be a folder the
// canvas already shows) and a path relative to it; both are resolved through symlinks and
// anything that lands outside the root is refused. Nothing here writes, renames or deletes.
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  HIDDEN_NAMES, MAX_ENTRIES, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, NOISE_NAMES, isIgnored, looksLikeText, parseGitignore,
  previewKindOf, relativeSteps, rootOfCwd, type DirListing, type FileEntry, type FilePreview, type IgnoreRule,
} from '../shared/files.ts';
import type { Snapshot } from '../shared/types.ts';

export interface ProjectFilesOptions {
  /** The folders the canvas shows (zone folders, sessions' folders): the only roots allowed. */
  roots(): Iterable<string>;
  /** Where a root is on disk; the demo points its invented folders at a real one. */
  onDisk?(root: string): string;
}

export interface ProjectFiles {
  list(root: unknown, dir: unknown): Promise<DirListing>;
  preview(root: unknown, file: unknown): Promise<FilePreview>;
}

/** The folders a zone on the canvas can stand for: each folder zone's own, and each session's
    (a worktree's repository), which is where a zone's "+" and its explorer open. */
export function canvasRoots(snapshot: Pick<Snapshot, 'layout' | 'sessions'>): string[] {
  const roots = new Set<string>();
  for (const z of snapshot.layout.zones) if (z.kind === 'folder' && z.path) roots.add(z.path);
  for (const s of snapshot.sessions) if (s.cwd.startsWith('/')) roots.add(rootOfCwd(s.cwd));
  return [...roots];
}

/** An error whose message the page shows as it is. */
const refuse = (message: string): Error => new Error(message);

/** Whether `target` is `root` or inside it (both real, absolute paths). */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The real path of `steps` under the real `root`, or a refusal if it leads outside it (a `..`
    is refused before this; a symlink is followed and judged by where it lands). */
export async function confine(realRoot: string, steps: readonly string[]): Promise<string> {
  let target: string;
  try {
    target = await fs.realpath(path.join(realRoot, ...steps));
  } catch {
    throw refuse('That file is gone.');
  }
  if (!isInside(realRoot, target)) throw refuse('That link leads outside the project folder.');
  return target;
}

const compare = (a: FileEntry, b: FileEntry): number =>
  a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

export async function projectRoot(root: unknown, { roots, onDisk = r => r }: ProjectFilesOptions): Promise<string> {
  if (typeof root !== 'string' || !root.startsWith('/') || root.includes('\0') || root.length > 4096) throw refuse('Not a project folder.');
  const wanted = path.resolve(root);
  if (wanted === '/' || ![...roots()].some((r) => path.resolve(r) === wanted)) throw refuse('That folder is not on the canvas.');
  try {
    const real = await fs.realpath(onDisk(wanted));
    if (!(await fs.stat(real)).isDirectory()) throw new Error('not a folder');
    return real;
  } catch {
    throw refuse('This folder isn’t on this Mac any more.');
  }
}

export function createProjectFiles(options: ProjectFilesOptions): ProjectFiles {
  const realRoot = (root: unknown) => projectRoot(root, options);
  const steps = (rel: unknown): string[] => {
    try {
      return relativeSteps(rel as string);
    } catch {
      throw refuse('Not a path in this project.');
    }
  };

  /** The root's .gitignore, read again only when it changes. */
  const ignores = new Map<string, { mtime: number; rules: IgnoreRule[] }>();
  const ignoreRules = async (root: string): Promise<IgnoreRule[]> => {
    const file = path.join(root, '.gitignore');
    try {
      const st = await fs.stat(file);
      const known = ignores.get(root);
      if (known && known.mtime === st.mtimeMs) return known.rules;
      const rules = st.size > 256_000 ? [] : parseGitignore(await fs.readFile(file, 'utf8'));
      ignores.set(root, { mtime: st.mtimeMs, rules });
      return rules;
    } catch {
      return [];
    }
  };

  return {
    async list(root, dir) {
      const real = await realRoot(root);
      const at = steps(dir);
      const folder = await confine(real, at);
      const rules = await ignoreRules(real);
      // Everything under an ignored or noisy folder is quiet too.
      const quietAbove = at.some((s, i) => NOISE_NAMES.has(s) || isIgnored(rules, at.slice(0, i + 1).join('/'), true));
      let dirents;
      try {
        dirents = await fs.readdir(folder, { withFileTypes: true });
      } catch {
        throw refuse('This folder can’t be read.');
      }
      const shown = dirents.filter((d) => !HIDDEN_NAMES.has(d.name));
      const entries = (await Promise.all(shown.map(async (d): Promise<FileEntry | null> => {
        const full = path.join(folder, d.name);
        let kind: FileEntry['kind'];
        let size = 0;
        let outside = false;
        try {
          if (d.isSymbolicLink()) {
            const target = await fs.realpath(full);
            outside = !isInside(real, target);
            const st = await fs.stat(target);
            if (!st.isDirectory() && !st.isFile()) return null;
            kind = st.isDirectory() ? 'dir' : 'file';
            size = st.isFile() ? st.size : 0;
          } else if (d.isDirectory()) kind = 'dir';
          else if (d.isFile()) { kind = 'file'; size = (await fs.stat(full)).size; }
          else return null;   // sockets, pipes, devices
        } catch {
          return null;        // a broken link, or gone since the listing
        }
        const rel = [...at, d.name].join('/');
        const ignored = quietAbove || (kind === 'dir' && NOISE_NAMES.has(d.name)) || isIgnored(rules, rel, kind === 'dir');
        return { name: d.name, kind, size, ignored, ...(outside ? { outside: true } : {}) };
      }))).filter((e): e is FileEntry => e !== null).sort(compare);
      return { entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
    },

    async preview(root, file) {
      const real = await realRoot(root);
      const at = steps(file);
      if (at.length === 0) throw refuse('Not a file.');
      const target = await confine(real, at);
      // The real path has no link left in it; O_NOFOLLOW refuses one swapped in since.
      let handle;
      try {
        handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        throw refuse('This file can’t be read.');
      }
      try {
        const st = await handle.stat();
        if (!st.isFile()) throw refuse('Not a file.');
        const size = st.size;
        const judged = previewKindOf(at.at(-1)!);
        const limit = judged.kind === 'image' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
        const read = async (n: number): Promise<Buffer> => {
          const buf = Buffer.alloc(n);
          const { bytesRead } = await handle.read(buf, 0, n, 0);
          return buf.subarray(0, bytesRead);
        };
        if (judged.kind === 'unknown' && !looksLikeText(await read(Math.min(size, 8192)))) return { kind: 'binary', size };
        if (size > limit) return { kind: 'tooLarge', size, limit };
        const bytes = await read(size);
        if (judged.kind === 'image') return { kind: 'image', size, mime: judged.mime, dataUrl: `data:${judged.mime};base64,${bytes.toString('base64')}` };
        if (judged.kind === 'unknown' && !looksLikeText(bytes)) return { kind: 'binary', size };
        return { kind: judged.kind === 'json' ? 'json' : 'text', size, text: bytes.toString('utf8') };
      } finally {
        await handle.close();
      }
    },
  };
}
