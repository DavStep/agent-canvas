import { useLayoutEffect, useRef, useState } from 'react';
import { conflicted, fullyStaged, staged, type GitFile } from '../../../shared/projectGit.ts';
import { arrive } from './cascade.ts';

const kinds = ['Conflicts', 'Modified', 'Added', 'Deleted', 'Type changed', 'Untracked'] as const;
type Kind = typeof kinds[number];

const conflictNames: Record<string, string> = {
  UU: 'Both sides modified', AA: 'Both sides added', DD: 'Both sides deleted',
  AU: 'Added by us', UA: 'Added by them', UD: 'Deleted by them', DU: 'Deleted by us',
};

function kindOf(file: GitFile): Kind {
  if (conflicted(file)) return 'Conflicts';
  if (file.index === '?') return 'Untracked';
  const code = file.worktree.trim() || file.index;
  if (code === 'D') return 'Deleted';
  if (file.index === 'A' || code === 'A') return 'Added';
  return code === 'T' ? 'Type changed' : 'Modified';
}

type Select = (files: GitFile[], include: boolean) => void;

function Check({ label, checked, mixed, disabled, change }: {
  label: string; checked: boolean; mixed?: boolean; disabled: boolean; change(): void;
}) {
  return <input type="checkbox" checked={checked} ref={el => { if (el) el.indeterminate = !!mixed; }}
    aria-label={label} title={label} disabled={disabled} onChange={change} />;
}

export function GitChanges({ files, file, open, busy, select }: {
  files: GitFile[]; file: string | null; open(path: string): void; busy: boolean; select: Select;
}) {
  const [folded, setFolded] = useState<Partial<Record<Kind, boolean>>>({});
  const [onlyIssues, setOnlyIssues] = useState(false);
  const hasIssue = (f: GitFile) => conflicted(f) || !!f.issues?.length;
  const issueCount = files.filter(hasIssue).length;
  const filtered = onlyIssues && issueCount > 0;
  const shown = filtered ? files.filter(hasIssue) : files;
  const selectable = shown.filter(f => !conflicted(f));
  const count = files.filter(staged).length;
  const groups = new Map<Kind, GitFile[]>();
  for (const f of shown) {
    const kind = kindOf(f);
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind)!.push(f);
  }
  // Rows that arrive together follow one another (cascade.ts): the whole list from its top when it
  // is first drawn, a group's own rows from its heading when it unfolds.
  const drawn = useRef(false);
  useLayoutEffect(() => { drawn.current = true; }, []);
  let next = 0;
  const place = (own: number) => drawn.current ? own : next++;
  if (!files.length) return <div className="git-files"><p className="ex-note">Working tree clean.</p></div>;
  return <>
    <div className="git-selection">
      {/* Keyed by the number, so it pops when it changes (motion.css), as the zone counts do. */}
      <span aria-live="polite"><b key={count}>{count}</b> staged</span>
      <button title="Stage all eligible files in this list" disabled={busy || selectable.every(fullyStaged)} onClick={() => select(selectable, true)}>{filtered ? 'Select shown' : 'Select all'}</button>
      <button title="Unstage all eligible files in this list" disabled={busy || !selectable.some(staged)} onClick={() => select(selectable, false)}>{filtered ? 'Deselect shown' : 'Deselect all'}</button>
    </div>
    {issueCount > 0 && <button className="git-issue-filter" aria-pressed={onlyIssues} onClick={() => setOnlyIssues(!onlyIssues)}
      title="Filter the list to files with Git warnings or merge conflicts">{onlyIssues ? 'Show all files' : `Review ${issueCount} ${issueCount === 1 ? 'file' : 'files'} with issues`}</button>}
    <div className="git-files">
      {kinds.map(kind => {
        const list = groups.get(kind);
        if (!list) return null;
        const conflict = kind === 'Conflicts';
        const all = list.every(fullyStaged);
        const head = place(0);
        return <section key={kind} data-kind={kind} aria-label={kind}>
          <div className="git-group" ref={el => arrive(el, head)}>
            {conflict ? <span className="git-warning" aria-hidden="true">!</span> :
              <Check label={`${all ? 'Deselect' : 'Select'} all ${kind.toLowerCase()} files`} checked={all}
                mixed={!all && list.some(staged)} disabled={busy} change={() => select(list, !all)} />}
            <h3><button aria-expanded={!folded[kind]} onClick={() => setFolded(old => ({ ...old, [kind]: !old[kind] }))}>
              <svg className="i git-chev" aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><path d="m3.5 2 3 3-3 3" /></svg>
              {kind}<span>{list.length}</span>
            </button></h3>
          </div>
          {!folded[kind] && list.map((f, i) => {
            const name = f.path.split('/').at(-1) || f.path;
            const partial = staged(f) && !fullyStaged(f);
            const detail = conflict ? conflictNames[f.index + f.worktree] ?? 'Unmerged' : partial ? 'Partly staged' : null;
            const at = place(i + 1);
            return <div key={f.path} ref={el => arrive(el, at)} className={`git-file${file === f.path ? ' is-selected' : ''}`}>
              {conflict ? <span className="git-check-space" /> : <Check label={`${fullyStaged(f) ? 'Unstage' : 'Stage'} ${f.path}`}
                checked={fullyStaged(f)} mixed={partial} disabled={busy} change={() => select([f], !fullyStaged(f))} />}
              <button aria-label={`View diff for ${f.path}`} aria-pressed={file === f.path} title={f.path} onClick={() => open(f.path)}>
                <span className="git-name">{name}</span><small>{f.path.slice(0, -name.length).replace(/\/$/, '')}</small>
                {!!f.issues?.length && <span className="git-issue-count" title={f.issues[0]?.message}>⚠ {f.issues.length}</span>}
                {detail && <span className="git-detail">{detail}</span>}
              </button>
            </div>;
          })}
        </section>;
      })}
    </div>
  </>;
}
