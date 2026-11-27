export interface GitFile {
  path: string;
  index: string;
  worktree: string;
  issues?: { line: number; message: string; staged: boolean }[];
}
export const conflicted = (f: GitFile) => f.index === 'U' || f.worktree === 'U' || ['AA', 'DD'].includes(f.index + f.worktree);
export const staged = (f: GitFile) => !conflicted(f) && f.index !== '?' && f.index !== ' ';

export const fullyStaged = (f: GitFile) => staged(f) && f.worktree === ' ';

export interface GitStatus {
  branch: string | null;
  head: string;
  files: GitFile[];
  indexVersion: string;
  stagedOutside: boolean;
  checksUnavailable?: boolean;
  conflicts: boolean;
  pushTo: { remote: string; branch: string } | null;
  /** Commits the push would send; null when the destination branch is not known locally yet. */
  ahead: number | null;
}
export type GitAction =
  | { type: 'stage' | 'unstage'; file: GitFile; head: string; branch: string | null }
  | { type: 'stage' | 'unstage'; files: GitFile[]; indexVersion: string; head: string; branch: string | null }
  | { type: 'commit'; message: string; indexVersion: string; head: string; branch: string | null }
  | { type: 'push'; remote: string; destination: string; head: string; branch: string | null };
