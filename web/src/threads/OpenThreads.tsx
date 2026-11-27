// Open threads as notes on the board: each question the owner left in a chat and moved on from
// sits beside the card of the chat it came from, on a folded sheet. It says what was discussed and
// what is still open, links back to that chat, and can be continued, marked done, or aborted (it
// is not wanted: it goes for good, with an undo). It can also be dragged into a chat (the
// composer, or a card: its chat opens with the message ready) or onto a zone (a session starts
// there with it).
import { useEffect, useLayoutEffect, useRef, type DragEvent } from 'react';
import type { OpenThread } from '../../../shared/threads.ts';
import { useBoardDeparture } from '../canvas/useBoardDeparture.ts';
import { ago } from '../ago.ts';
import { COLUMN_W } from '../canvas/zoneFlow.ts';
import { THREAD_MIME, dropAt, projectLabel, readDragged, type ThreadDrop } from './threads.ts';

const TARGET = 'is-thread-target';
/** A thread note is a card wide, so it takes one column beside its card. */
export const THREAD_NOTE_W = COLUMN_W;
/** Its height before it is measured. */
export const THREAD_NOTE_H = 236;

export interface ThreadNoteProps {
  thread: OpenThread;
  now: number;
  dragging: boolean;
  /** The chat it came from is still around to open. */
  canOpen: boolean;
  onOpenSource(): void;
  /** "Continue": the source chat opens with the message in its composer (a new session when it is gone). */
  onContinue(): void;
  onDone(): void;
  onAbort(): void;
  onDragStart(): void;
  onDragEnd(): void;
  /** Its drawn height, so the zone's cards make room for all of it. */
  onHeight(height: number): void;
}

export function ThreadNote({ thread: t, now, dragging, canOpen, onOpenSource, onContinue, onDone, onAbort, onDragStart, onDragEnd, onHeight }: ThreadNoteProps) {
  const el = useRef<HTMLElement>(null);
  useBoardDeparture(el, 'thread', t.id);
  const report = useRef(onHeight);
  report.current = onHeight;
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    report.current(node.offsetHeight);
    const ro = new ResizeObserver(() => report.current(node.offsetHeight));
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const start = (e: DragEvent<HTMLElement>) => {
    e.dataTransfer.setData(THREAD_MIME, JSON.stringify({ id: t.id }));
    // A plain-text copy too, so a drop into another app gets the question at least.
    e.dataTransfer.setData('text/plain', `${t.title}: ${t.question}`);
    e.dataTransfer.effectAllowed = 'copyLink';
    onDragStart();
  };

  return (
    <article ref={el} className={`thread-note${dragging ? ' is-dragged' : ''}`}
      style={{ width: THREAD_NOTE_W }}
      draggable onDragStart={start} onDragEnd={onDragEnd}
      data-no-pan="" data-item-id={`thread:${t.id}`} data-thread-id={t.id} aria-roledescription="open thread" aria-label={`Open thread: ${t.title}`}>
      <p className="tn-kicker">Open thread</p>
      <h3 className="tn-title">{t.title}</h3>
      <p className="tn-meta">
        <span className="tn-project">{projectLabel(t)}</span>
        <span className="tn-age" title={new Date(t.askedAt).toLocaleString()}>{ago(t.askedAt, now)}</span>
      </p>
      <p className="tn-summary">{t.summary}</p>
      <p className="tn-question"><span className="tn-q-label">Still open</span> {t.question}</p>
      <button type="button" className="tn-source" disabled={!canOpen} onClick={onOpenSource}
        title={canOpen ? 'Open the chat this came from' : 'That chat is no longer on the canvas'}>
        {t.sessionName || 'Untitled chat'}
      </button>
      <div className="tn-actions">
        <button type="button" className="menu-btn tn-abort" onClick={onAbort} aria-label={`Abort ${t.title}`}
          title="Remove this open thread">Abort</button>
        <button type="button" className="menu-btn" onClick={onDone} aria-label={`Done: ${t.title}`} title="It is settled">Done</button>
        <button type="button" className="menu-btn primary" onClick={onContinue} aria-label={`Continue ${t.title}`}
          title={canOpen ? 'Open its chat with the message ready to send' : 'Start a session in its folder with it'}>Continue</button>
      </div>
    </article>
  );
}

/** While a thread note is dragged: the drop target under the pointer gets a ring, and a drop does the work. */
export function useThreadDrops(threads: OpenThread[], onDrop: (t: OpenThread, drop: ThreadDrop) => void, onHover: (drop: ThreadDrop | null) => void) {
  const live = useRef({ threads, onDrop, onHover });
  live.current = { threads, onDrop, onHover };
  useEffect(() => {
    let lit: Element | null = null;
    const light = (el: Element | null) => {
      if (lit === el) return;
      lit?.classList.remove(TARGET);
      el?.classList.add(TARGET);
      lit = el;
    };
    const ours = (e: globalThis.DragEvent) => e.dataTransfer?.types.includes(THREAD_MIME) === true;
    // Capture, so the board's own drop handling (images, notes, files) never sees a thread.
    const over = (e: globalThis.DragEvent) => {
      if (!ours(e)) return;
      const at = dropAt(e.target instanceof Element ? e.target : null);
      e.stopPropagation();
      if (at === null) { light(null); live.current.onHover(null); return; }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = at.drop.kind === 'composer' || at.drop.kind === 'card' ? 'copy' : 'link';
      light(at.target);
      live.current.onHover(at.drop);
    };
    const drop = (e: globalThis.DragEvent) => {
      if (!ours(e)) return;
      e.stopPropagation();
      const at = dropAt(e.target instanceof Element ? e.target : null);
      light(null);
      live.current.onHover(null);
      if (at === null) return;
      e.preventDefault();
      const t = readDragged(e.dataTransfer?.getData(THREAD_MIME) ?? '', live.current.threads);
      if (t !== null) live.current.onDrop(t, at.drop);
    };
    const end = () => { light(null); live.current.onHover(null); };
    window.addEventListener('dragenter', over, true);
    window.addEventListener('dragover', over, true);
    window.addEventListener('drop', drop, true);
    window.addEventListener('dragend', end, true);
    return () => {
      light(null);
      window.removeEventListener('dragenter', over, true);
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('drop', drop, true);
      window.removeEventListener('dragend', end, true);
    };
  }, []);
}
