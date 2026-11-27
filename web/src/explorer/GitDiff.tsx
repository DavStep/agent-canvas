import { useEffect, useMemo, useRef, useState } from 'react';
import { gitBridge } from '../bridge.ts';
import { DiffView } from '../chat/DiffView.tsx';
import { errorText } from '../preview/BrowserTab.tsx';
import { EXIT_MS, instant } from '../useClosing.ts';
import type { GitStatus } from '../../../shared/projectGit.ts';

function Patch({ text, path }: { text: string; path: string }) {
  // Code lines in unified patches carry a prefix, so these unprefixed headings
  // can only be the boundaries emitted by the main process.
  const parts = useMemo(() => text.split(/^(Staged|Working tree|Untracked)\n/gm), [text]);
  return <div className="git-patches" tabIndex={0} aria-label="Changed lines">
    {parts[0] && <pre>{parts[0]}</pre>}
    {parts.map((title, i) => {
      if (i % 2 === 0) return null;
      const patch = parts[i + 1] ?? '';
      const hunk = /^@@ -/m.exec(patch);
      const special = patch.slice(0, hunk?.index).split('\n').filter(line => /^(old mode|new mode|similarity index|rename |copy )/.test(line));
      return <section key={i}><h4>{title === 'Working tree' ? 'Unstaged changes' : title === 'Staged' ? 'Staged for commit' : 'New file'}</h4>
        {hunk && special.length > 0 && <pre>{special.join('\n')}</pre>}
        {hunk && patch.length <= 150_000 ? <DiffView diff={{ path, unified: patch, added: 0, removed: 0 }} full showPath={false} /> :
          <pre>{patch || 'Empty file'}</pre>}
      </section>;
    })}
  </div>;
}

export function GitDiff({ root, path, status, close }: { root: string; path: string; status: GitStatus; close(): void }) {
  // The diff last read, and the file it belongs to. Git is read again whenever the status is (on
  // focus, after every action): the lines already shown stay until the new ones are back, and only
  // another file starts from "Loading diff…".
  const of = `${root}\n${path}`;
  const [read, setRead] = useState<{ of: string; text: string } | null>(null);
  const text = read?.of === of ? read.text : null;
  const dialog = useRef<HTMLDialogElement>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let live = true;
    const show = (value: string) => { if (live) setRead({ of, text: value }); };
    gitBridge.diff(root, path).then(show, err => show(errorText(err)));
    return () => { live = false; };
  }, [root, path, status, of]);
  // The expanded review sinks out as the other dialogs do (docs/motion.md): it stays for its exit, then closes.
  const [leaving, setLeaving] = useState(false);
  const exit = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (exit.current !== null) clearTimeout(exit.current); }, []);
  const shut = () => {
    if (instant()) { dialog.current?.close(); return; }
    if (exit.current !== null) return;
    setLeaving(true);
    exit.current = setTimeout(() => { exit.current = null; setLeaving(false); dialog.current?.close(); }, EXIT_MS);
  };
  const patch = text === null ? <p className="ex-note is-loading" role="status">Loading diff…</p> : <Patch key={of} text={text} path={path} />;
  const issues = status.files.find(f => f.path === path)?.issues;
  const findings = !!issues?.length && <ul className="git-findings" aria-label="Git warnings">{issues.map((issue, i) => <li key={i}><b>{issue.staged ? 'Staged' : 'Unstaged'} · Line {issue.line}</b> {issue.message}</li>)}</ul>;
  const title = <strong title={path}>{path}</strong>;
  return <section className="git-diff" aria-label={`Diff for ${path}`}>
    <header>{title}<button className="git-text-action" onClick={() => { dialog.current?.showModal(); setExpanded(true); }}>Expand</button>
      <button className="ex-icon" aria-label="Close diff" onClick={close}>×</button></header>
    {!expanded && <>{findings}{patch}</>}
    <dialog ref={dialog} className={`git-review${leaving ? ' is-closing' : ''}`} aria-label={`Review ${path}`} onClose={() => setExpanded(false)}
      onCancel={e => { e.preventDefault(); shut(); }}
      onKeyDown={e => { if (e.key === 'Escape') e.stopPropagation(); }}>
      {expanded && <><header>{title}<button className="ex-icon" aria-label="Close expanded diff" onClick={shut}>×</button></header>
        {findings}{patch}</>}
    </dialog>
  </section>;
}
