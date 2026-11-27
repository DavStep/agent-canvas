import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { conflicted, fullyStaged, staged, type GitAction, type GitFile, type GitStatus } from '../../../shared/projectGit.ts';
import { gitBridge, newSessionBridge } from '../bridge.ts';
import { errorText } from '../preview/BrowserTab.tsx';

import { GitChanges } from './GitChanges.tsx';
import { GitDiff } from './GitDiff.tsx';

interface Props {
  root: string; revision: number; message: string; setMessage(value: string): void; onOpenChat(id: string): void;
  /** The status this explorer last showed. The tab is drawn afresh on every visit, so coming back
      shows this at once and reads the folder again behind it, instead of starting from nothing. */
  seen: { current: GitStatus | null };
}

/** The shape of the list while the first read is still out (motion.css shows it only if that takes
    long enough to notice): the staged row, a heading and a few files. */
function Reading() {
  return <>
    <div className="git-selection" aria-hidden="true"><i className="git-ghost" style={{ width: 52 }} /></div>
    <div className="git-files git-ghosts" aria-hidden="true">
      <div className="git-group"><i className="git-ghost is-box" /><i className="git-ghost" style={{ width: '26%' }} /></div>
      {[44, 58, 36, 50].map((w, i) => <div className="git-file" key={w} style={{ '--i': i + 1 } as CSSProperties}><i className="git-ghost is-box" /><i className="git-ghost" style={{ width: `${w}%` }} /></div>)}
    </div>
  </>;
}

export function GitPanel({ root, revision, message, setMessage, onOpenChat, seen }: Props) {
  const [status, show] = useState<GitStatus | null>(() => seen.current);
  const setStatus = useCallback((next: GitStatus | null) => { seen.current = next; show(next); }, [seen]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rejectedOn, setRejectedOn] = useState<string | null>(null);
  const [operation, setOperation] = useState<GitAction['type'] | 'merge' | null>(null);
  const busy = operation !== null;
  const [file, setFile] = useState<string | null>(null);
  const sequence = useRef(0);
  const working = useRef(false);
  const live = useRef(true);
  const refresh = useCallback(async () => {
    const id = ++sequence.current;
    try {
      const next = await gitBridge.status(root);
      if (live.current && sequence.current === id) {
        setStatus(next);
        setFile(prev => next.files.some(f => f.path === prev) ? prev : null);
      }
    } catch (err) {
      if (live.current && sequence.current === id) {
        setStatus(null);
        const why = errorText(err);
        setError(why.includes('not a git repository') ? 'This folder is outside a Git repository.' : why);
      }
    }
  }, [root, setStatus]);
  useEffect(() => {
    live.current = true;
    const reload = () => { if (!working.current) { setError(''); void refresh(); } };
    reload();
    window.addEventListener('focus', reload);
    return () => { live.current = false; sequence.current++; window.removeEventListener('focus', reload); };
  }, [refresh, revision]);

  async function run(action: GitAction | 'merge') {
    if (!status || working.current) return;
    working.current = true;
    setOperation(action === 'merge' ? 'merge' : action.type); setError(''); setNotice('');
    try {
      if (action === 'merge') {
        const prompt = status.conflicts
          ? 'Inspect the current Git conflicts in this checkout and help me resolve them. Preserve the intent of both sides and ask me about ambiguous changes. Leave the result for my review before committing or pushing.'
          : 'My Git push was rejected because the remote branch has new commits. Inspect the local and remote branches, help me integrate the incoming changes, and ask about ambiguous conflicts. Leave the result for my review before pushing.';
        const id = await newSessionBridge.projectTask(root, prompt, []);
        if (live.current) onOpenChat(id);
      } else {
        await gitBridge.act(root, action);
        if (live.current && action.type === 'commit') { setMessage(''); setNotice('Committed selected changes.'); }
        if (live.current && action.type === 'push') {
          const sent = status.ahead === null ? '' : `${status.ahead} commit${status.ahead === 1 ? '' : 's'} `;
          setRejectedOn(null); setNotice(`Pushed ${sent}to ${action.remote}/${action.destination}.`);
        }
      }
    } catch (err) {
      if (live.current) {
        const why = errorText(err);
        setError(why);
        if (action !== 'merge' && action.type === 'push' && /non-fast-forward|fetch first/i.test(why)) setRejectedOn(status.branch);
      }
    } finally {
      if (live.current) await refresh();
      working.current = false;
      if (live.current) setOperation(null);
    }
  }
  // Agents on the canvas commit while the tab is open and the window keeps focus, so read Git
  // again whenever the pointer or keyboard comes back to the panel.
  const freshen = () => { if (!working.current) void refresh(); };
  // A folder Git cannot read says why. Until the first read is back the panel is already in place:
  // the branch row, the list's shape and the composer, with the reason line saying what it waits for.
  if (!status && error) return <p className="ex-note" role="status">{error}</p>;
  const target = status?.pushTo ?? null;
  const count = status ? status.files.filter(staged).length : 0;
  const select = (items: GitFile[], include: boolean) => {
    if (!status) return;
    const files = items.filter(f => !conflicted(f) && (include ? !fullyStaged(f) : staged(f)));
    if (files.length) void run({ head: status.head, branch: status.branch, type: include ? 'stage' : 'unstage', files: files.map(({ path, index, worktree }) => ({ path, index, worktree })), indexVersion: status.indexVersion });
  };
  const conflicts = status ? status.files.filter(conflicted).length : 0;
  const commitReason = !status ? 'Reading Git changes…'
    : status.conflicts ? (conflicts ? 'Resolve conflicts before committing.' : 'Resolve conflicts outside this folder before committing.')
    : status.stagedOutside ? 'Open the repository root to commit files staged outside this folder.'
    : !count ? 'Select files to commit.' : !message.trim() ? 'Enter a commit message.' : '';
  const pushReason = !status ? 'Reading Git changes…'
    : !target ? 'Configure a remote and check out a branch to push'
    : status.ahead === 0 ? `Nothing to push: ${target.remote}/${target.branch} already has every commit. Commit changes first.`
    : status.conflicts ? 'Resolve conflicts before pushing.' : status.head === '(initial)' ? 'Commit something before pushing.' : '';
  /** The button whose action is running says so (motion.css lets it breathe until it is back). */
  const going = (kind: typeof operation) => operation === kind ? ' is-working' : '';
  return <div className="git-panel" aria-busy={busy || !status} onPointerEnter={status ? freshen : undefined}
    onFocus={e => { if (status && !e.currentTarget.contains(e.relatedTarget)) freshen(); }}>
    <div className="git-branch">
      <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><circle cx="12" cy="5" r="1.5"/><path d="M4 4.5v7m0-2c4 0 8 0 8-3"/></svg>
      {status ? <strong>{status.branch ?? 'Detached HEAD'}</strong> : <i className="git-ghost" style={{ width: 56 }} />}
      {target && <span title={`Push to ${target.remote}/${target.branch}`}>→ {target.remote}/{target.branch}</span>}
    </div>
    {status ? <GitChanges files={status.files} file={file} open={setFile} busy={busy} select={select} /> : <Reading />}
    {status && file && <GitDiff root={root} path={file} status={status} close={() => setFile(null)} />}
    <div className="git-compose">
      {status && (status.conflicts || (rejectedOn && rejectedOn === status.branch)) && <button className={`git-action${going('merge')}`} disabled={busy} onClick={() => void run('merge')}>{operation === 'merge' ? 'Opening chat…' : 'Merge with AI'}</button>}
      {error && <p className="git-error" role="alert">{error}</p>}
      {status?.checksUnavailable && <p>Git could not check all changes for whitespace or conflict markers.</p>}
      {notice && <p className="git-notice" role="status">{notice}</p>}
      {/* Keyed by what it says, so a new reason fades in (motion.css) where the last one stood. */}
      {commitReason && (!status || status.files.length > 0 || status.stagedOutside || status.conflicts) && <p key={commitReason} className="git-commit-reason" id="git-commit-reason" role={status ? undefined : 'status'}>{commitReason}</p>}
      <textarea aria-label="Commit message" placeholder="Commit message" rows={2} maxLength={16000} value={message} disabled={busy} onChange={e => setMessage(e.target.value)} />
      <div className="git-buttons">
        <button className={`git-action primary${going('commit')}`} disabled={busy || !!commitReason} aria-describedby={commitReason ? "git-commit-reason" : undefined}
          onClick={() => status && void run({ head: status.head, branch: status.branch, type: 'commit', indexVersion: status.indexVersion, message })}>{operation === 'commit' ? 'Committing…' : 'Commit'}{count > 0 ? ` (${count})` : ''}</button>
        <button className={`git-action${going('push')}`} disabled={busy || !!pushReason}
          title={pushReason || `Push branch to ${target!.remote}/${target!.branch}`}
          onClick={() => status && target && void run({ head: status.head, branch: status.branch, type: 'push', remote: target.remote, destination: target.branch })}>{operation === 'push' ? 'Pushing…' : 'Push'}{status?.ahead ? ` (${status.ahead})` : ''}</button>
      </div>
    </div>
  </div>;
}
