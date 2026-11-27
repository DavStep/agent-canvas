import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const git = promisify(execFile);

/** A checkout and its linked worktrees share an orchestrator. An explicitly selected subfolder
    or a non-git folder keeps its own scope. Paths are compared in full, including symlinks. */
export async function projectFolders(folder: string): Promise<string[]> {
  const cwd = await realpath(folder);
  try {
    const { stdout } = await git('/usr/bin/git', ['-C', cwd, 'worktree', 'list', '--porcelain', '-z'], { timeout: 3000 });
    const roots = stdout.split('\0\0').filter(entry => !entry.split('\0').includes('bare'))
      .map(entry => entry.split('\0')[0]!).filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
    if (roots.includes(cwd)) return roots;
  } catch { /* A project can be a plain folder. */ }
  return [cwd];
}

export async function inProject(cwd: string, roots: string[]): Promise<boolean> {
  if (!path.isAbsolute(cwd)) return false;
  if (roots.includes(path.resolve(cwd))) return true;
  try { return roots.includes(await realpath(cwd)); } catch { return false; }
}
