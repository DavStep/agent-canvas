// Whether an ACP agent's command is installed: the program it runs, found as the login shell
// would find it (a bare name on PATH, a path as written; `~/` is the home folder).
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function runnable(file: string): Promise<boolean> {
  try {
    await fs.access(file, constants.X_OK);
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The program `command` runs with this PATH, or null when there is none. */
export async function findProgram(command: string, searchPath: string, home = os.homedir()): Promise<string | null> {
  const cmd = command.startsWith('~/') ? path.join(home, command.slice(2)) : command;
  if (cmd.includes('/')) return path.isAbsolute(cmd) && await runnable(cmd) ? cmd : null;
  for (const dir of searchPath.split(':')) {
    if (dir === '' || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, cmd);
    if (await runnable(file)) return file;
  }
  return null;
}
