// The project explorer's tree, kept pure: which folders are listed, which are open, and the rows
// that shows, in order (for drawing and for the arrow keys).
import type { DirListing, FileEntry } from '../../../shared/files.ts';

export type DirState =
  | { status: 'loading' }
  | { status: 'ok'; listing: DirListing }
  | { status: 'error'; message: string };

/** Each folder asked for so far, by its path from the root ('' for the root). */
export type Dirs = Readonly<Record<string, DirState>>;

export type Row =
  | { kind: 'entry'; path: string; entry: FileEntry; depth: number; open: boolean }
  /** A folder's placeholder while it loads, its error, or a note that it was cut short. */
  | { kind: 'note'; path: string; depth: number; tone: 'loading' | 'error' | 'more'; text: string };

/** A child's path. */
export const join = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);
/** A path's parent folder ('' for an entry at the root). */
export const parentOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')));

/** The rows shown: the root's entries, and under each open folder its own, depth first. */
export function visibleRows(dirs: Dirs, open: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (dir: string, depth: number) => {
    const state = dirs[dir];
    if (!state || state.status === 'loading') {
      // The root shows its own loading state; a folder gets a row.
      if (dir !== '') rows.push({ kind: 'note', path: `${dir}/…`, depth, tone: 'loading', text: 'Loading…' });
      return;
    }
    if (state.status === 'error') {
      if (dir !== '') rows.push({ kind: 'note', path: `${dir}/!`, depth, tone: 'error', text: state.message });
      return;
    }
    if (dir !== '' && state.listing.entries.length === 0) rows.push({ kind: 'note', path: `${dir}/∅`, depth, tone: 'more', text: 'Empty folder' });
    for (const entry of state.listing.entries) {
      const path = join(dir, entry.name);
      const isOpen = entry.kind === 'dir' && open.has(path);
      rows.push({ kind: 'entry', path, entry, depth, open: isOpen });
      if (isOpen) walk(path, depth + 1);
    }
    if (state.listing.truncated) {
      rows.push({ kind: 'note', path: `${dir}/+`, depth, tone: 'more', text: `Showing the first ${state.listing.entries.length} items` });
    }
  };
  walk('', 0);
  return rows;
}

/** Where the arrow keys take the focus from `current` among the entry rows; null to stay. */
export function stepFocus(rows: readonly Row[], current: string, key: string): string | null {
  const entries = rows.filter((r): r is Extract<Row, { kind: 'entry' }> => r.kind === 'entry');
  const i = entries.findIndex((r) => r.path === current);
  if (entries.length === 0) return null;
  if (key === 'Home') return entries[0]!.path;
  if (key === 'End') return entries.at(-1)!.path;
  if (i === -1) return entries[0]!.path;
  if (key === 'ArrowDown') return entries[i + 1]?.path ?? null;
  if (key === 'ArrowUp') return entries[i - 1]?.path ?? null;
  const row = entries[i]!;
  // Left on a child goes to its folder; Right on an open folder goes to its first child.
  if (key === 'ArrowLeft' && !row.open && row.depth > 0) return parentOf(row.path);
  if (key === 'ArrowRight' && row.open) {
    const next = entries[i + 1];
    return next && next.depth > row.depth ? next.path : null;
  }
  return null;
}

/** The root shown short: the home folder as ~. */
export function shortPath(root: string, home: string | null): string {
  return home && (root === home || root.startsWith(`${home}/`)) ? `~${root.slice(home.length)}` : root;
}

/** A home folder guessed from a macOS path (/Users/<name>), for shortPath. */
export function homeOf(root: string): string | null {
  return /^\/Users\/[^/]+/.exec(root)?.[0] ?? null;
}
