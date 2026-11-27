// What main checks before an engine starts a new session, so the New session dialog can say why
// a start cannot work (and stay open) instead of the engine failing later or hanging.
import fs from 'node:fs/promises';
import type { Engine } from '../server/engines/engine.ts';
import { isBlockingBanner } from '../shared/banners.ts';

export type FolderKind = 'dir' | 'file' | 'missing';

export async function folderKind(p: string): Promise<FolderKind> {
  try {
    return (await fs.stat(p)).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
}

/** Throws the reason a start in `cwd` cannot work, or resolves. `kind` stands in for the disk (demo mode). */
export async function checkStart(cwd: string, engine: Pick<Engine, 'banner'>, kind: (p: string) => Promise<FolderKind> = folderKind): Promise<void> {
  if (await kind(cwd) !== 'dir') throw new Error(`The folder ${cwd} no longer exists`);
  const banner = engine.banner;
  // Only a blocking banner stops a start; other provider warnings allow a retry.
  if (banner !== null && isBlockingBanner(banner)) throw new Error(banner);
}
