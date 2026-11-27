// An edit's diff, from the unified text the engines put on the tool item. No diff library: the
// engines already did the diffing; this only numbers and colours the lines.
import type { FileDiff } from '../../../shared/chat.ts';

export interface DiffLine { kind: 'ctx' | 'add' | 'del' | 'hunk'; old: number | null; new: number | null; text: string }

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/** Long diffs (a whole new file) are cut in the thread; Live work shows them in full. */
export const MAX_LINES = 400;

/** Unified diff → numbered lines. File headers and "No newline" markers are left out. */
export function diffLines(unified: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  let inHunk = false;
  for (const line of unified.replace(/\r\n?/g, '\n').split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      out.push({ kind: 'hunk', old: null, new: null, text: line });
      continue;
    }
    if (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ') || line.startsWith('index '))) continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) out.push({ kind: 'add', old: null, new: newNo++, text: line.slice(1) });
    else if (line.startsWith('-')) out.push({ kind: 'del', old: oldNo++, new: null, text: line.slice(1) });
    else if (line.startsWith(' ')) out.push({ kind: 'ctx', old: oldNo++, new: newNo++, text: line.slice(1) });
    // A blank line at the end of the text is not a line of the file.
  }
  return out;
}

const SIGN = { ctx: ' ', add: '+', del: '−' } as const;

/** Live work's form: the whole diff, old and new line numbers, each hunk's header. */
function FullDiff({ diff, lines, showPath }: { diff: FileDiff; lines: DiffLine[]; showPath: boolean }) {
  return (
    <div className="t-diff is-full" role="group" aria-label={`Changes to ${diff.path}`}>
      {showPath && <div className="t-diff-path">{diff.path}</div>}
      {lines.map((l, i) => (l.kind === 'hunk'
        ? <div key={i} className="hunk">{l.text}</div>
        : (
          <div key={i} className={`ln ${l.kind}`}>
            <span className="no">{l.old ?? ''}</span>
            <span className="no">{l.new ?? ''}</span>
            <span className="sg">{SIGN[l.kind]}</span>
            <span className="tx">{l.text}</span>
          </div>
        )))}
    </div>
  );
}

/** One file's lines in the thread's form: one number column (old for removed, new otherwise), cut
    at MAX_LINES; `full` gives Live work's form instead. */
export function DiffView({ diff, showPath, full = false }: { diff: FileDiff; showPath: boolean; full?: boolean }) {
  const all = diffLines(diff.unified);
  if (full) return <FullDiff diff={diff} lines={all} showPath={showPath} />;
  const firstHunk = all.findIndex((l) => l.kind === 'hunk');
  const lines = all.slice(0, MAX_LINES);
  return (
    <div className="t-diff" role="group" aria-label={`Changes to ${diff.path}`}>
      {showPath && <div className="t-diff-path">{diff.path}</div>}
      {lines.map((l, i) => (l.kind === 'hunk'
        // The first hunk needs no divider; later ones mark the skipped lines.
        ? i === firstHunk ? null : <div key={i} className="ln gap" aria-hidden="true"><span className="no">⋯</span></div>
        : (
          <div key={i} className={`ln ${l.kind}`}>
            <span className="no">{l.kind === 'del' ? l.old : l.new}</span>
            <span className="sg">{SIGN[l.kind]}</span>
            <span className="tx">{l.text}</span>
          </div>
        )))}
      {all.length > MAX_LINES && <div className="t-diff-more">{all.length - MAX_LINES} more lines</div>}
    </div>
  );
}
