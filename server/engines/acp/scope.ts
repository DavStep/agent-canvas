// The folder an ACP session may touch through the app (fs/*, terminal cwd) without asking: its
// own, by real path. A symlink inside that leads out is outside; a file not made yet is judged by
// the nearest folder above it that exists.
import fs from 'node:fs/promises';
import path from 'node:path';

/** Files larger than this are not read for an agent (it gets an error saying so). */
export const MAX_READ_BYTES = 20 * 1024 * 1024;

/** `p`'s real path: of the file itself, or of its nearest existing ancestor plus the rest. */
export async function realPathOf(p: string): Promise<string> {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let at = abs;
  for (;;) {
    try {
      const real = await fs.realpath(at);
      return rest.length === 0 ? real : path.join(real, ...rest.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = path.dirname(at);
      if (parent === at) return abs;
      rest.push(path.basename(at));
      at = parent;
    }
  }
}

export const isInside = (root: string, real: string): boolean => real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Where `p` really is, and whether that is inside `root` (already a real path). */
export async function locate(root: string, p: string): Promise<{ real: string; inside: boolean }> {
  if (!path.isAbsolute(p)) throw new Error(`Paths must be absolute: ${p}`);
  if (p.includes('\0')) throw new Error('A path may not contain NUL');
  const real = await realPathOf(p);
  return { real, inside: isInside(root, real) };
}

/** Lines `line` (1-based) onwards, at most `limit` of them; the whole text without either. */
export function sliceLines(text: string, line?: number | null, limit?: number | null): string {
  if ((line === undefined || line === null) && (limit === undefined || limit === null)) return text;
  const lines = text.split('\n');
  const start = Math.max(0, Math.floor((line ?? 1) - 1));
  const end = limit === undefined || limit === null ? lines.length : start + Math.max(0, Math.floor(limit));
  return lines.slice(start, end).join('\n');
}

export async function readText(real: string, line?: number | null, limit?: number | null): Promise<string> {
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error(`Not a file: ${real}`);
  if (stat.size > MAX_READ_BYTES) throw new Error(`${real} is over ${MAX_READ_BYTES / 1024 / 1024} MB; read it in a terminal instead`);
  return sliceLines(await fs.readFile(real, 'utf8'), line, limit);
}

/** Writes the file, making its folder first when missing. */
export async function writeText(real: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(real), { recursive: true });
  await fs.writeFile(real, content, 'utf8');
}
