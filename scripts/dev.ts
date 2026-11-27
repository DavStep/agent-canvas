// `npm run dev`: Vite with hot reload, and the app in demo mode loading its page from Vite.
// Both start and stop together.
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { DEV_VITE_PORT } from './devPort.ts';

const VITE_URL = `http://127.0.0.1:${DEV_VITE_PORT}`;
const WAIT_MS = 15_000;
/** In Node, the electron package's export is the path of its binary. */
const electronBin = createRequire(import.meta.url)('electron') as string;

const children: ChildProcess[] = [];
let stopping = false;
function stopAll(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  process.exitCode = code;
}
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const child = spawn(cmd, args, { stdio: 'inherit', env });
  children.push(child);
  child.on('exit', (code) => stopAll(code ?? 0));
  child.on('error', () => stopAll(1));
  return child;
}
/** A child that is meant to finish (the main-process build): tracked, so stopping dev stops it
    too, but its own exit does not stop the others. */
function runOnce(cmd: string, args: string[]): Promise<number> {
  const child = spawn(cmd, args, { stdio: 'inherit' });
  children.push(child);
  return new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

async function viteUp(): Promise<boolean> {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until && !stopping) {
    try {
      if ((await fetch(VITE_URL)).ok) return true;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

run(process.execPath, ['node_modules/vite/bin/vite.js']);
const built = runOnce(process.execPath, ['--import', 'tsx', 'scripts/build-electron.ts']);
const [up, buildCode] = await Promise.all([viteUp(), built]);
if (!up || buildCode !== 0) {
  if (!stopping) process.stderr.write(!up ? `dev: Vite did not answer on ${VITE_URL}\n` : 'dev: build-electron failed\n');
  stopAll(1);
} else if (!stopping) {
  run(electronBin, ['dist-electron/main.js', '--demo'], { ...process.env, VITE_DEV_URL: VITE_URL });
}
