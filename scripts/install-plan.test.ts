import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applySteps, decide, isYes, APP_BUNDLE, BUILT_APP, type InstallFacts } from './install-plan.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const facts = (over: Partial<InstallFacts> = {}): InstallFacts => ({
  built: '/repo/release.noindex/mac-arm64/Agent canvas.app', applications: '/Applications', targetExists: false, running: false, ...over,
});

describe('decide', () => {
  it('the built app lives in release.noindex/mac-arm64 and is named "Agent canvas.app"', () => {
    expect(APP_BUNDLE).toBe('Agent canvas.app');
    expect(BUILT_APP).toBe(path.join('release.noindex', 'mac-arm64', 'Agent canvas.app'));
  });

  it('no copy in /Applications → copies without asking: staged beside it, moved into place, built copy removed', () => {
    expect(decide(facts())).toEqual({
      kind: 'copy',
      target: '/Applications/Agent canvas.app',
      steps: [
        { op: 'remove', path: '/Applications/.Agent canvas.app.installing' },
        { op: 'copy', from: '/repo/release.noindex/mac-arm64/Agent canvas.app', to: '/Applications/.Agent canvas.app.installing' },
        { op: 'move', from: '/Applications/.Agent canvas.app.installing', to: '/Applications/Agent canvas.app' },
        { op: 'remove', path: '/repo/release.noindex/mac-arm64/Agent canvas.app' },
      ],
    });
  });

  it('an existing copy → asks first; the replace plan keeps the old copy until the new one is in place', () => {
    const d = decide(facts({ targetExists: true }));
    expect(d).toMatchObject({ kind: 'ask', question: 'Replace the Agent canvas.app in /Applications? [y/N] ' });
    if (d.kind !== 'ask') throw new Error('expected ask');
    expect(d.steps).toEqual([
      { op: 'remove', path: '/Applications/.Agent canvas.app.installing' },
      { op: 'remove', path: '/Applications/.Agent canvas.app.old' },
      { op: 'copy', from: '/repo/release.noindex/mac-arm64/Agent canvas.app', to: '/Applications/.Agent canvas.app.installing' },
      { op: 'move', from: '/Applications/Agent canvas.app', to: '/Applications/.Agent canvas.app.old' },
      { op: 'move', from: '/Applications/.Agent canvas.app.installing', to: '/Applications/Agent canvas.app' },
      { op: 'remove', path: '/Applications/.Agent canvas.app.old' },
      { op: 'remove', path: '/repo/release.noindex/mac-arm64/Agent canvas.app' },
    ]);
  });

  it('the installed copy is running → nothing is copied; asks to quit it first', () => {
    expect(decide(facts({ targetExists: true, running: true }))).toEqual({
      kind: 'quit-first', message: 'Agent canvas is running from /Applications. Quit it (⌘Q), then run npm run install-app again.',
    });
  });

  it('isYes: only y or yes, any case, counts', () => {
    expect(['y', 'Y', 'yes', ' YES \n'].map(isYes)).toEqual([true, true, true, true]);
    expect(['', 'n', 'no', 'yep', 'sure'].map(isYes)).toEqual([false, false, false, false, false]);
  });
});

describe('applySteps (in a temp dir only)', () => {
  async function bundle(root: string, name: string, marker: string): Promise<string> {
    const app = path.join(root, name);
    await fs.mkdir(path.join(app, 'Contents', 'Frameworks', 'Lib.framework', 'Versions', 'A'), { recursive: true });
    await fs.writeFile(path.join(app, 'Contents', 'marker.txt'), marker);
    await fs.writeFile(path.join(app, 'Contents', 'Frameworks', 'Lib.framework', 'Versions', 'A', 'Lib'), 'binary');
    await fs.symlink('A', path.join(app, 'Contents', 'Frameworks', 'Lib.framework', 'Versions', 'Current'));
    return app;
  }

  async function temp(): Promise<{ built: string; apps: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-install-'));
    dirs.push(root);
    const apps = path.join(root, 'Applications');
    await fs.mkdir(apps);
    const built = await bundle(path.join(root, 'release.noindex'), 'Agent canvas.app', 'new');
    return { built, apps };
  }

  it('a fresh install copies the bundle with its symlinks kept as symlinks', async () => {
    const { built, apps } = await temp();
    const d = decide({ built, applications: apps, targetExists: false, running: false });
    if (d.kind !== 'copy') throw new Error('expected copy');
    await applySteps(d.steps);
    const target = path.join(apps, 'Agent canvas.app');
    expect(await fs.readFile(path.join(target, 'Contents', 'marker.txt'), 'utf8')).toBe('new');
    expect(await fs.readlink(path.join(target, 'Contents', 'Frameworks', 'Lib.framework', 'Versions', 'Current'))).toBe('A');
    expect((await fs.readdir(apps)).sort()).toEqual(['Agent canvas.app']);
    await expect(fs.access(built)).rejects.toThrow();
  });

  it('a replace swaps the old copy for the new one and leaves nothing behind', async () => {
    const { built, apps } = await temp();
    await bundle(apps, 'Agent canvas.app', 'old');
    const d = decide({ built, applications: apps, targetExists: true, running: false });
    if (d.kind !== 'ask') throw new Error('expected ask');
    await applySteps(d.steps);
    expect(await fs.readFile(path.join(apps, 'Agent canvas.app', 'Contents', 'marker.txt'), 'utf8')).toBe('new');
    expect((await fs.readdir(apps)).sort()).toEqual(['Agent canvas.app']);
    await expect(fs.access(built)).rejects.toThrow();
  });
});
