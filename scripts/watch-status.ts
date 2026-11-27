// Dev tool: `node --import tsx scripts/watch-status.ts` prints `<id prefix> <status> <waitingFor>`
// whenever a live session's status changes. Prints no titles, prompts or answers.
import os from 'node:os';
import path from 'node:path';
import { whichAlive } from '../server/adapter/liveness.ts';
import { onePerSession, readSessionFiles } from '../server/adapter/sessionFiles.ts';

const POLL_MS = 1000;
const claudeHome = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
const sessionsDir = path.join(claudeHome, 'sessions');
const last = new Map<string, string>();

async function tick(): Promise<void> {
  const { sessions: files } = await readSessionFiles(sessionsDir);
  const live = new Set<string>();
  for (const raw of onePerSession(files, await whichAlive(files))) {
    live.add(raw.sessionId);
    const line = `${raw.sessionId.slice(0, 6)} ${raw.status} ${raw.waitingFor ?? ''}`.trimEnd();
    if (last.get(raw.sessionId) !== line) {
      last.set(raw.sessionId, line);
      process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
    }
  }
  for (const id of last.keys()) {
    if (!live.has(id)) {
      last.delete(id);
      process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${id.slice(0, 6)} ended\n`);
    }
  }
}

const loop = async (): Promise<void> => {
  try {
    await tick();
  } catch (err) {
    process.stderr.write(`watch-status: ${(err as Error).message}\n`);
  }
  setTimeout(() => { void loop(); }, POLL_MS);
};
void loop();
