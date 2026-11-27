import { describe, expect, it } from 'vitest';
import { findFolders, type FolderDeps } from './folders.ts';

const HOME = '/Users/me';

/** A disk given as a list of folders, and what Spotlight would print (or an error to fail with). */
function deps(folders: string[], spotlight: string[] | Error = []): FolderDeps & { runs: [string, string[], number][] } {
  const all = new Set<string>();
  for (const f of folders) {
    const steps = f.split('/').filter((s) => s !== '');
    for (let i = 1; i <= steps.length; i++) all.add(`/${steps.slice(0, i).join('/')}`);
  }
  const runs: [string, string[], number][] = [];
  return {
    home: HOME, runs,
    run: async (file, args, timeoutMs) => {
      runs.push([file, args, timeoutMs]);
      if (spotlight instanceof Error) throw spotlight;
      return spotlight.join('\n') + '\n';
    },
    subfolders: async (dir) => {
      if (!all.has(dir)) throw new Error('ENOENT');
      return [...all].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).map((p) => p.slice(dir.length + 1));
    },
    exists: async (p) => all.has(p),
  };
}

describe('findFolders', () => {
  it('asks Spotlight for folders by name with arguments (no shell), scoped to the home folder, with a timeout', async () => {
    const d = deps([`${HOME}/Documents`], [`${HOME}/Work/clients/garden-sim`]);
    const found = await findFolders('garden-sim', 20, d);
    expect(found).toEqual([{ path: `${HOME}/Work/clients/garden-sim`, git: false }]);
    expect(d.runs).toEqual([['/usr/bin/mdfind', ['-onlyin', HOME, 'kMDItemContentType == "public.folder" && kMDItemFSName == "*garden-sim*"cd'], 4000]]);
  });

  it('a query cannot break out of the Spotlight pattern', async () => {
    const d = deps([]);
    await findFolders('x" || kMDItemFSName == "*', 20, d);
    expect(d.runs[0]![1][2]).toBe('kMDItemContentType == "public.folder" && kMDItemFSName == "*x || kMDItemFSName ==*"cd');
  });

  it('with Spotlight failing, a shallow scan of the usual places still finds the folder', async () => {
    const d = deps([
      `${HOME}/Documents/garden-sim/.git`, `${HOME}/Documents/garden-sim/src/garden-sim-core`, `${HOME}/Developer/tools/garden-sim-cli`,
      `${HOME}/garden-sim-notes`, `${HOME}/Music/garden-sim-ost`, `${HOME}/Documents/a/b/garden-sim-deep`,
    ], new Error('mdfind timed out'));
    const found = await findFolders('Garden-Sim', 20, d);
    expect(found).toEqual([
      { path: `${HOME}/Documents/garden-sim`, git: true },
      { path: `${HOME}/garden-sim-notes`, git: false },
      { path: `${HOME}/Developer/tools/garden-sim-cli`, git: false },
    ]);
  });

  it('merges both sources without duplicates: exact names first, then names starting with the query, then git repositories', async () => {
    const d = deps([
      `${HOME}/code/sim/.git`, `${HOME}/Desktop/sim-old`, `${HOME}/Projects/garden-sim/.git`, `${HOME}/Documents/sim-site/.git`,
    ], [`${HOME}/code/sim`, `${HOME}/Archive/2019/sim`, `${HOME}/Projects/garden-sim`]);
    const found = await findFolders('sim', 20, d);
    expect(found.map((f) => f.path)).toEqual([
      `${HOME}/code/sim`, `${HOME}/Archive/2019/sim`, `${HOME}/Documents/sim-site`, `${HOME}/Desktop/sim-old`, `${HOME}/Projects/garden-sim`,
    ]);
    expect(found.map((f) => f.git)).toEqual([true, false, true, false, true]);
  });

  it('leaves out hidden folders, node_modules, ~/Library and anything outside the home folder', async () => {
    const d = deps([`${HOME}/Documents/app/node_modules/sim`, `${HOME}/Documents/.cache/sim`, `${HOME}/Documents/sim`], [
      `${HOME}/Library/Caches/sim`, `${HOME}/.Trash/sim`, `${HOME}/x/node_modules/sim`, '/Volumes/Other/sim', `${HOME}/Documents/sim`,
    ]);
    expect(await findFolders('sim', 20, d)).toEqual([{ path: `${HOME}/Documents/sim`, git: false }]);
  });

  it('every word of the query must be in the name; the limit caps the answer', async () => {
    const d = deps([`${HOME}/code/garden-sim-dashboard`, `${HOME}/code/garden-sim`, `${HOME}/code/sim-garden`, `${HOME}/code/dashboard`]);
    expect((await findFolders('sim garden', 20, d)).map((f) => f.path)).toEqual([
      `${HOME}/code/garden-sim`, `${HOME}/code/sim-garden`, `${HOME}/code/garden-sim-dashboard`,
    ]);
    expect(await findFolders('sim garden', 2, d)).toHaveLength(2);
    expect(await findFolders('   ', 20, d)).toEqual([]);
  });
});
