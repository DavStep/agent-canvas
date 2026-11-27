// One tool call as one line (tool, target, +/− or exit code); it expands in place to its diff or
// output, and selecting it is what Live work shows.
import { memo } from 'react';
import type { ChatItem, ToolKind } from '../../../../shared/chat.ts';
import { stripAnsi } from '../../preview/findLocalUrl.ts';
import { MediaPreview } from '../ChatMedia.tsx';
import { DiffView } from '../DiffView.tsx';
import { Markdown } from '../Markdown.tsx';

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/** A call whose body is Markdown of its own (Claude's plan), not terminal output. */
export const isPlan = (item: Pick<ToolItem, 'name'>): boolean => item.name === 'ExitPlanMode';

export interface ToolLabel {
  name: string;
  /** One line, at most 80 characters (plus an ellipsis). */
  target: string;
  /** Lines added and removed over all files, for edits. */
  added: number | null;
  removed: number | null;
  /** A quiet note: line count, exit code, state. */
  meta: string | null;
}

export const MAX_TARGET = 80;

/** Whole words up to 80 characters, then "…"; a first word longer than that is cut hard. */
function cut(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_TARGET) return flat;
  const room = flat.slice(0, MAX_TARGET);
  const atWord = flat[MAX_TARGET] === ' ' ? room : room.replace(/\s*\S*$/, '');
  return `${atWord === '' ? room : atWord}…`;
}

const NAMES: Partial<Record<ToolKind, string>> = { command: 'Bash', read: 'Read' };

function displayName(item: ToolItem): string {
  if (item.name === 'image_generation') return 'Generate image';
  if (item.name === 'view_image') return 'View image';
  if (item.tool === 'edit') return item.name === 'Write' || item.name === 'MultiEdit' || item.name === 'NotebookEdit' ? item.name : 'Edit';
  if (item.tool === 'mcp') return item.name.replace(/^mcp__/, '').split(/__|\//).filter(Boolean).join(' ');
  if (item.tool === 'web') return item.name === 'web_search' ? 'Search web' : item.name;
  return NAMES[item.tool] ?? item.name;
}

function lineCount(text: string): number {
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed === '' ? 0 : trimmed.split('\n').length;
}

function metaOf(item: ToolItem): string | null {
  switch (item.status) {
    case 'waiting': return 'waiting for you';
    case 'running': return 'running';
    case 'denied': return 'denied';
    case 'failed': return item.exitCode !== null ? `exit ${item.exitCode}` : 'failed';
    case 'done':
      if (item.tool === 'command' && item.exitCode !== null && item.exitCode !== 0) return `exit ${item.exitCode}`;
      if (item.tool === 'read' && item.output !== null) {
        const n = lineCount(item.output);
        return `${n} ${n === 1 ? 'line' : 'lines'}`;
      }
      return null;
  }
}

export function toolRowLabel(item: ToolItem): ToolLabel {
  const edit = item.tool === 'edit' && item.diffs.length > 0;
  return {
    name: item.action?.name ?? displayName(item),
    target: cut(item.action?.target ?? item.target),
    added: edit ? item.diffs.reduce((n, d) => n + d.added, 0) : null,
    removed: edit ? item.diffs.reduce((n, d) => n + d.removed, 0) : null,
    meta: metaOf(item),
  };
}

/** The row as one line of text (its accessible name). */
export function toolRowText(item: ToolItem): string {
  const l = toolRowLabel(item);
  const counts = l.added !== null ? ` +${l.added} −${l.removed}` : '';
  return `${l.name}${l.target === '' ? '' : ` ${l.target}`}${counts}`;
}

/** Long outputs show their last lines in the thread, without the terminal's escape codes. */
const MAX_OUTPUT_LINES = 200;
function tail(raw: string): string {
  const text = stripAnsi(raw);
  const lines = text.split('\n');
  return lines.length <= MAX_OUTPUT_LINES ? text : `…\n${lines.slice(-MAX_OUTPUT_LINES).join('\n')}`;
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg className="i chev" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d={open ? 'M4.5 6.5 8 10l3.5-3.5' : 'M6.5 4.5 10 8l-3.5 3.5'} />
    </svg>
  );
}

/** `running`: mark a running call with its own dot (the thread's rows; Live work has a status icon). */
export function ToolMeta({ label, status, running = false }: { label: ToolLabel; status: ToolItem['status']; running?: boolean }) {
  if (label.added !== null) {
    return <span className="m"><span className="plus">+{label.added}</span><span className="minus">−{label.removed}</span></span>;
  }
  if (label.meta === null) return <span className="m" />;
  const cls = status === 'waiting' ? 'm is-waiting' : status === 'failed' || status === 'denied' ? 'm is-bad' : 'm';
  // Waiting on the owner: an amber dot. Running: a green one that breathes (motion.css).
  const dot = status === 'waiting' ? 'needs' : status === 'running' && running ? 'working' : null;
  return <span className={cls}>{dot && <i className={`dot ${dot}`} />}{label.meta}</span>;
}

export interface ToolRowProps {
  item: ToolItem;
  open: boolean;
  selected: boolean;
  /** Called with the item's id, so one stable function serves every row. */
  onToggle(id: string): void;
}

/** Drawn again only when its props change: unchanged items keep their identity (applyUpdate),
    so a streaming chat redraws only the item that grows. */
export const ToolRow = memo(function ToolRow({ item, open, selected, onToggle }: ToolRowProps) {
  const label = toolRowLabel(item);
  const media = item.media ?? [];
  const hasBody = media.length > 0 || item.diffs.length > 0 || (item.output !== null && item.output !== '');
  return (
    <>
      <button
        type="button"
        className={`t-tool${selected ? ' is-selected' : ''} is-${item.status}`}
        aria-expanded={hasBody ? open : undefined}
        aria-label={toolRowText(item)}
        title={item.target}
        // A pointer click leaves focus where it was (the composer, say): a row it parked on would
        // light its keyboard ring at the next key press. Keyboard focus is untouched.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onToggle(item.id)}
      >
        <Chevron open={open && hasBody} />
        <span className="name">{label.name}</span>
        <span className="target">{label.target}</span>
        <ToolMeta label={label} status={item.status} running />
      </button>
      {(open || item.name === 'image_generation') && media.map((m, i) => <MediaPreview key={i} media={m} />)}
      {open && hasBody && (
        item.diffs.length > 0
          ? item.diffs.map((d) => <DiffView key={d.path} diff={d} showPath={item.diffs.length > 1} />)
          : isPlan(item)
            ? <div className="t-output t-plan"><Markdown text={item.output ?? ''} /></div>
            : item.output && <pre className="t-output">{tail(item.output)}</pre>
      )}
    </>
  );
});
