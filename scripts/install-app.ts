// `npm run install-app`: builds Agent canvas.app (npm run package), then copies it to
// /Applications, asking first if a copy is already there. Its decisions are in install-plan.ts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { applySteps, APP_BUNDLE, BUILT_APP, decide, isYes } from './install-plan.ts';

const APPLICATIONS = '/Applications';
const root = path.resolve(import.meta.dirname, '..');

function fail(message: string): never {
  process.stderr.write(`install-app: ${message}\n`);
  process.exit(1);
}

const built = spawnSync('npm', ['run', 'package'], { cwd: root, stdio: 'inherit' });
if (built.status !== 0) fail('npm run package failed');
const app = path.join(root, BUILT_APP);
if (!fs.existsSync(app)) fail(`${BUILT_APP} was not built`);

const target = path.join(APPLICATIONS, APP_BUNDLE);
// pgrep only reads the process list; exit 0 means a match.
const running = spawnSync('pgrep', ['-f', `${target}/Contents/MacOS/`]).status === 0;
const decision = decide({ built: app, applications: APPLICATIONS, targetExists: fs.existsSync(target), running });

if (decision.kind === 'quit-first') fail(decision.message);
if (decision.kind === 'ask') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(decision.question);
  rl.close();
  if (!isYes(answer)) {
    process.stdout.write('Nothing changed.\n');
    process.exit(0);
  }
}
await applySteps(decision.steps);
// Forget the removed build copy in LaunchServices too, so Launchpad and "Open With" don't keep it.
spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', app]);
process.stdout.write(`Installed ${decision.target}. Open it from Launchpad or Spotlight.\n`);
