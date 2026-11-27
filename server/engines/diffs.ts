// FileDiffs for both providers: Claude gives before/after text, Codex gives unified hunks.
import { structuredPatch } from 'diff';
import type { FileDiff } from '../../shared/chat.ts';

const CONTEXT = 3;

/** Snippets rarely end in a newline; adding one keeps "\ No newline" markers out of the hunks. */
const terminated = (s: string): string => (s === '' || s.endsWith('\n') ? s : `${s}\n`);

/** Hunks only (no ---/+++ header): the path travels beside them. */
export function hunksBetween(before: string, after: string): string {
  const patch = structuredPatch('a', 'b', terminated(before), terminated(after), '', '', { context: CONTEXT });
  return patch.hunks
    .map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}\n`)
    .join('');
}

/** Counts the + and − lines of unified text, ignoring any file headers before the first hunk. */
export function fromUnified(path: string, unified: string): FileDiff {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of unified.split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+')) added++;
    else if (inHunk && line.startsWith('-')) removed++;
  }
  return { path, unified, added, removed };
}

export const fileDiff = (path: string, before: string, after: string): FileDiff => fromUnified(path, hunksBetween(before, after));
