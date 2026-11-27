// What `npm run install-app` does with the built app, as data: whether it must ask before
// replacing a copy in /Applications, and the copy plan. The new copy is staged beside the target
// and moved into place, so an existing copy is replaced only once the new one is complete. The
// built copy in release.noindex/ is removed last, so /Applications holds the only Agent canvas.app and
// Launchpad and Spotlight list one app, not one per build.
import fs from 'node:fs/promises';
import path from 'node:path';

export const APP_BUNDLE = 'Agent canvas.app';
/** Where electron-builder.yml puts the arm64 app (directories.output, mac dir target). */
export const BUILT_APP = path.join('release.noindex', 'mac-arm64', APP_BUNDLE);

export type Step =
  | { op: 'copy'; from: string; to: string }
  | { op: 'move'; from: string; to: string }
  /** Removes a path if it is there. */
  | { op: 'remove'; path: string };

export interface InstallFacts {
  /** The built app bundle. */
  built: string;
  /** Usually /Applications. */
  applications: string;
  /** A copy is already installed there. */
  targetExists: boolean;
  /** That installed copy is running now. */
  running: boolean;
}

export type InstallDecision =
  | { kind: 'copy'; target: string; steps: Step[] }
  | { kind: 'ask'; target: string; question: string; steps: Step[] }
  | { kind: 'quit-first'; message: string };

export function decide(f: InstallFacts): InstallDecision {
  const target = path.join(f.applications, APP_BUNDLE);
  const staging = path.join(f.applications, `.${APP_BUNDLE}.installing`);
  const old = path.join(f.applications, `.${APP_BUNDLE}.old`);
  if (f.targetExists && f.running) {
    return { kind: 'quit-first', message: `Agent canvas is running from ${f.applications}. Quit it (⌘Q), then run npm run install-app again.` };
  }
  if (!f.targetExists) {
    return {
      kind: 'copy', target,
      steps: [{ op: 'remove', path: staging }, { op: 'copy', from: f.built, to: staging }, { op: 'move', from: staging, to: target }, { op: 'remove', path: f.built }],
    };
  }
  return {
    kind: 'ask', target, question: `Replace the ${APP_BUNDLE} in ${f.applications}? [y/N] `,
    steps: [
      { op: 'remove', path: staging },
      { op: 'remove', path: old },
      { op: 'copy', from: f.built, to: staging },
      { op: 'move', from: target, to: old },
      { op: 'move', from: staging, to: target },
      { op: 'remove', path: old },
      { op: 'remove', path: f.built },
    ],
  };
}

export function isYes(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}

/** Runs a plan in order. Symlinks inside the bundle (its frameworks) are copied as symlinks. */
export async function applySteps(steps: Step[]): Promise<void> {
  for (const step of steps) {
    switch (step.op) {
      case 'copy':
        await fs.cp(step.from, step.to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
        break;
      case 'move':
        await fs.rename(step.from, step.to);
        break;
      case 'remove':
        await fs.rm(step.path, { recursive: true, force: true });
        break;
    }
  }
}
