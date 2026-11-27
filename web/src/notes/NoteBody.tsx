// A note's text as the board shows it: plain paragraphs that keep their line breaks, with a little
// Markdown on top (# headings, **bold**, *italic*, `code`, - and 1. lists, `- [ ]` checkboxes, and
// links that open in the browser as a chat's do). A checkbox can be ticked right on the board.
// Inline Markdown is the chat's own (chat/Markdown.tsx), so a note reads as a message does.
import { memo, type ReactNode } from 'react';
import { taskLine } from '../../../shared/boardNotes.ts';
import { openExternal } from '../bridge.ts';
import { parseInline, type Inline } from '../chat/Markdown.tsx';

type Line =
  | { type: 'heading'; level: number; text: string }
  | { type: 'task'; n: number; checked: boolean; text: string; depth: number }
  | { type: 'item'; ordered: string | null; text: string; depth: number }
  | { type: 'para'; lines: string[] }
  | { type: 'gap' };

const HEADING = /^\s{0,3}(#{1,3})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

/** The note's lines, grouped: a run of plain lines is one paragraph (its breaks kept). */
export function noteLines(text: string): Line[] {
  const out: Line[] = [];
  let tasks = 0;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const task = taskLine(raw);
    if (task) { out.push({ type: 'task', n: tasks++, checked: task.checked, text: task.label, depth: Math.min(3, Math.floor(task.indent.length / 2)) }); continue; }
    const heading = HEADING.exec(raw);
    if (heading) { out.push({ type: 'heading', level: heading[1]!.length, text: heading[2]! }); continue; }
    const item = ITEM.exec(raw);
    if (item) { out.push({ type: 'item', ordered: /\d/.test(item[2]!) ? item[2]! : null, text: item[3]!, depth: Math.min(3, Math.floor(item[1]!.length / 2)) }); continue; }
    if (raw.trim() === '') { if (out.length > 0 && out[out.length - 1]!.type !== 'gap') out.push({ type: 'gap' }); continue; }
    const last = out[out.length - 1];
    if (last?.type === 'para') last.lines.push(raw);
    else out.push({ type: 'para', lines: [raw] });
  }
  while (out[out.length - 1]?.type === 'gap') out.pop();
  return out;
}

function Inlines({ nodes }: { nodes: Inline[] }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text': return n.text;
      case 'code': return <code key={i}>{n.text}</code>;
      case 'strong': return <strong key={i}><Inlines nodes={n.children} /></strong>;
      case 'em': return <em key={i}><Inlines nodes={n.children} /></em>;
      case 'media': return n.media.label ?? n.media.src;
      case 'link': return (
        <a key={i} href={n.href} title={n.href} className="md-link" rel="noreferrer"
          // A link is a link, not the start of a drag or an edit.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); openExternal(n.href).catch(() => {}); }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); openExternal(n.href).catch(() => {}); } }}>
          <Inlines nodes={n.children} />
        </a>
      );
    }
  });
}

const Text = ({ text }: { text: string }) => <Inlines nodes={parseInline(text)} />;

export const NoteBody = memo(function NoteBody({ text, onToggle }: { text: string; onToggle?(n: number): void }) {
  const lines = noteLines(text);
  return (
    <div className="bn-text">
      {lines.map((l, i) => {
        switch (l.type) {
          case 'gap': return <div key={i} className="bn-gap" aria-hidden="true" />;
          case 'heading': {
            const H = l.level === 1 ? 'h3' : l.level === 2 ? 'h4' : 'h5';
            return <H key={i} className="bn-h"><Text text={l.text} /></H>;
          }
          case 'para': return <p key={i}>{l.lines.map((line, j) => <span key={j}>{j > 0 && <br />}<Text text={line} /></span>)}</p>;
          case 'item': return (
            <div key={i} className="bn-item" style={{ marginInlineStart: l.depth * 14 }}>
              <span className="bn-bullet" aria-hidden="true">{l.ordered ?? '•'}</span>
              <span className="bn-item-text"><Text text={l.text} /></span>
            </div>
          );
          case 'task': return (
            <label key={i} className={`bn-task${l.checked ? ' is-done' : ''}`} style={{ marginInlineStart: l.depth * 14 }}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={l.checked} disabled={!onToggle} onChange={() => onToggle?.(l.n)} />
              <span className="bn-item-text"><Text text={l.text} /></span>
            </label>
          );
        }
      })}
    </div>
  );
});
