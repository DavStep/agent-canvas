// The Live work tab: the current turn's tool calls in order, and the shown one in full (a
// command's output, an edit's whole diff, the excerpt a read returned).
import { useLayoutEffect, useRef } from 'react';
import type { ChatItem, ChatState } from '../../../shared/chat.ts';
import { MediaPreview } from '../chat/ChatMedia.tsx';
import { DiffView } from '../chat/DiffView.tsx';
import { ToolMeta, toolRowLabel, toolRowText, type ToolItem } from '../chat/items/ToolRow.tsx';
import { clock } from '../chat/Thread.tsx';
import { stripAnsi } from './findLocalUrl.ts';

const isTool = (i: ChatItem): i is ToolItem => i.kind === 'tool';

/** The tool calls since the owner's last message (all of them when none is loaded). */
export function turnTools(items: ChatItem[]): ToolItem[] {
  let start = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind === 'user') { start = i + 1; break; }
  }
  return items.filter((item, index): item is ToolItem => isTool(item) && (index >= start || item.status === 'running'));
}

/** Following: the turn's newest call. Otherwise the one the owner picked, wherever it is. */
export function shownTool(items: ChatItem[], follow: boolean, selectedId: string | null): ToolItem | null {
  if (follow) {
    const calls = turnTools(items);
    return calls.findLast(t => t.status === 'waiting' || t.status === 'running') ?? calls.at(-1) ?? null;
  }
  if (selectedId === null) return null;
  const item = items.find((i) => i.id === selectedId);
  return item?.kind === 'tool' ? item : null;
}

/** VS Code's link to a file: absolute paths as they are, relative ones from the session's folder.
    Null for a path that climbs out with `..` or has no folder to start from. */
export function editorUrl(path: string, cwd: string): string | null {
  if (path === '') return null;
  let abs = path;
  if (!path.startsWith('/')) {
    if (!cwd.startsWith('/')) return null;
    abs = `${cwd}/${path}`;
  }
  const steps = abs.split('/').filter((s) => s !== '' && s !== '.');
  if (steps.length === 0 || steps.includes('..')) return null;
  return `vscode://file/${steps.map(encodeURIComponent).join('/')}`;
}

/** Long outputs show their last lines. */
const MAX_OUTPUT_LINES = 2000;
function outputText(text: string): string {
  const clean = stripAnsi(text);
  const lines = clean.split('\n');
  return lines.length <= MAX_OUTPUT_LINES ? clean : `…\n${lines.slice(-MAX_OUTPUT_LINES).join('\n')}`;
}

/** The file an edit or a read is about. */
function filePath(item: ToolItem): string | null {
  if (item.tool === 'edit') return item.diffs[0]?.path ?? (item.target || null);
  if (item.tool === 'read') return item.target || null;
  return null;
}

function statusWord(item: ToolItem): string {
  switch (item.status) {
    case 'waiting': return 'waiting for you';
    case 'running': return 'running';
    case 'denied': return 'denied';
    case 'failed': return item.exitCode !== null ? `exit ${item.exitCode}` : 'failed';
    case 'done':
      if (item.tool === 'edit') return 'applied';
      if (item.tool === 'command' && item.exitCode !== null) return `exit ${item.exitCode}`;
      return toolRowLabel(item).meta ?? 'done';
  }
}

function StatusIcon({ status }: { status: ToolItem['status'] }) {
  switch (status) {
    case 'done':
      return <svg className="i ok" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 8.5 2.5 2.5L12 5.5" /></svg>;
    case 'failed':
    case 'denied':
      return <svg className="i bad" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m5 5 6 6M11 5l-6 6" /></svg>;
    case 'waiting':
      return <span className="wait" aria-hidden="true"><i className="dot needs" /></span>;
    case 'running':
      return <span className="wait" aria-hidden="true"><i className="dot working" /></span>;
  }
}

function Detail({ item, cwd, canOpenInEditor, onOpenInEditor }: { item: ToolItem; cwd: string; canOpenInEditor: boolean; onOpenInEditor(url: string): void }) {
  const label = toolRowLabel(item);
  const out = useRef<HTMLPreElement>(null);
  const path = filePath(item);
  const url = canOpenInEditor && path !== null ? editorUrl(path, cwd) : null;
  const output = item.output !== null && item.output !== '' ? outputText(item.output) : null;

  // A command's output streams in: keep its newest lines in view unless the owner scrolled up.
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = out.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [output]);
  useLayoutEffect(() => { atBottom.current = true; }, [item.id]);

  let body;
  if (item.diffs.length > 0) {
    body = <div className="pv-diffs">{item.diffs.map((d) => <DiffView key={d.path} diff={d} showPath={item.diffs.length > 1} full />)}</div>;
  } else if (output !== null) {
    body = (
      <pre ref={out} className="pv-output" onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
      }}>{output}</pre>
    );
  } else {
    body = <p className="pv-note">{item.status === 'running' ? 'Running…' : item.status === 'waiting' ? 'Waiting for you to allow it.' : 'No output.'}</p>;
  }

  return (
    <section className="pv-detail" aria-label={`${label.name} ${label.target}`.trim()}>
      <div className="pv-d-head">
        <span className="name">{label.name}</span>
        <span className="target" title={item.target}>{label.target}</span>
        {label.added !== null && <ToolMeta label={label} status={item.status} />}
      </div>
      {item.media?.map((media, i) => <MediaPreview key={i} media={media} />)}
      {item.media?.length && output === null && !item.diffs.length ? null : body}
      <div className="pv-d-foot">
        <span>{clock(item.at)} · {statusWord(item)}</span>
        {url !== null && <button type="button" className="pv-act" onClick={() => onOpenInEditor(url)}>Open in editor</button>}
      </div>
    </section>
  );
}

export interface LiveWorkProps {
  plan?: ChatState['plan'];
  items: ChatItem[];
  /** The session's folder, for relative file paths. */
  cwd: string;
  /** The call shown in full (followed or picked). */
  shown: ToolItem | null;
  canOpenInEditor: boolean;
  onPick(id: string): void;
  onOpenInEditor(url: string): void;
}

export function LiveWork({ items, plan, cwd, shown, canOpenInEditor, onPick, onOpenInEditor }: LiveWorkProps) {
  const tools = turnTools(items);
  return (
    <div className="pv-live">
      {!!plan?.length && <ol className="pv-plan" aria-label="Task plan">{plan.map((s, i) =>
        <li key={i} aria-current={s.status === 'inProgress' ? 'step' : undefined}><span>{s.status === 'inProgress' ? 'Running' : s.status === 'completed' ? 'Done' : 'Pending'}</span>{s.step}</li>)}</ol>}
      <div className="pv-head"><h2>{tools.some(t => t.status === 'running') ? 'Running tasks' : 'This turn'}</h2><span>{tools.length} {tools.length === 1 ? 'call' : 'calls'}</span></div>
      {tools.length === 0 ? <p className="pv-note">No calls this turn yet.</p> : (
        <ol className="pv-calls">
          {[...tools.filter(t => t.status === 'running'), ...tools.filter(t => t.status !== 'running')].map((t) => {
            const label = toolRowLabel(t);
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className={`pv-call${shown?.id === t.id ? ' is-selected' : ''} is-${t.status}`}
                  aria-label={toolRowText(t)}
                  aria-current={shown?.id === t.id || undefined}
                  title={t.target}
                  onClick={() => onPick(t.id)}
                >
                  <StatusIcon status={t.status} />
                  <span className="name">{label.name}</span>
                  <span className="target">{label.target}</span>
                  {t.status === 'waiting' ? <span className="m" /> : <ToolMeta label={label} status={t.status} />}
                  {t.status === 'waiting' && <span className="sub">waiting for you</span>}
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {shown !== null && <Detail key={shown.id} item={shown} cwd={cwd} canOpenInEditor={canOpenInEditor} onOpenInEditor={onOpenInEditor} />}
    </div>
  );
}
