// The lines between linked cards ("B runs after A"), drawn on the board so they pan and zoom with
// it, and the port a link is dragged from. Card places are read from the page (each card's box on
// the board, transforms included), so a line follows a card that is dragged, glides to a new slot
// or rides a moving zone: it is drawn again after every render and on every frame while anything
// on the board moves (kick). See docs/links.md.
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type Ref, type RefObject } from 'react';
import { curve, type Box, type Line } from './links.ts';

/** How long lines are redrawn every frame after something may have started moving. */
const FOLLOW_MS = 480;

export interface ConnectorsHandle {
  /** Something on the board may move for a while (a card glide): follow it. */
  kick(ms?: number): void;
}

export interface ConnectorsProps {
  board: RefObject<HTMLDivElement | null>;
  /** The view's zoom now. */
  scale(): number;
  lines: Line[];
  /** A card's name for labels ("Fix login"). */
  nameOf(id: string): string;
  /** A link dragged from one card onto another: `to` runs after `from`. */
  onLink(from: string, to: string): void;
  onNewSession?(from: string, zoneId?: string): void;
  /** The line's ×. */
  onUnlink(from: string, to: string): void;
  /** Whether a card may start a link (not a planned card, not one being dragged). */
  canLink?(id: string): boolean;
  ref?: Ref<ConnectorsHandle>;
}

const cardEl = (board: HTMLElement, id: string): HTMLElement | null =>
  board.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`);

/** A card's box in board coordinates. */
function boxOf(b: DOMRect, el: HTMLElement, k: number): Box {
  const r = el.getBoundingClientRect();
  return { x: (r.left - b.left) / k, y: (r.top - b.top) / k, width: r.width / k, height: r.height / k };
}

type Drag = { from: string; at: { x: number; y: number }; over: string | null };

export function Connectors({ board, scale, lines, nameOf, onLink, onNewSession, onUnlink, canLink = () => true, ref }: ConnectorsProps) {
  const svg = useRef<SVGSVGElement>(null);
  const port = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  /** The card under the pointer, any card: its lines show their ×. */
  const [near, setNear] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const until = useRef(0);
  const frame = useRef(0);

  /** Puts every line, the port and the line in the hand where the cards are now. */
  const paint = useCallback(() => {
    const host = board.current;
    const layer = svg.current;
    if (!host || !layer) return;
    const p = port.current;
    const d = dragRef.current;
    const id = d?.from ?? hovered;
    if (!lines.length && !id && !d) {
      if (p && !p.hidden) p.hidden = true;
      return;
    }
    const k = scale() || 1;
    const origin = host.getBoundingClientRect();
    const boxes = new Map<string, Box | null>();
    const box = (id: string): Box | null => {
      if (!boxes.has(id)) {
        const el = cardEl(host, id);
        boxes.set(id, el ? boxOf(origin, el, k) : null);
      }
      return boxes.get(id)!;
    };
    // Read every endpoint before changing the SVG. Shared endpoints cost one layout read.
    for (const line of lines) { box(line.from); box(line.to); }
    if (id) box(id);
    if (d?.over) box(d.over);
    for (const g of layer.querySelectorAll<SVGGElement>('g.link-line')) {
      const a = box(g.dataset.from!);
      const b = box(g.dataset.to!);
      if (!a || !b) { g.style.display = 'none'; continue; }
      g.style.display = '';
      const c = curve(a, b);
      if (g.querySelector('.link-path')?.getAttribute('d') === c.d) continue;
      for (const p of g.querySelectorAll<SVGPathElement>('.link-path, .link-hit')) p.setAttribute('d', c.d);
      g.querySelector('.link-arrow')?.setAttribute('d', c.arrow);
      const dot = g.querySelector('.link-dot');
      dot?.setAttribute('cx', String(c.start.x));
      dot?.setAttribute('cy', String(c.start.y));
      g.querySelector('.link-x')?.setAttribute('transform', `translate(${c.mid.x} ${c.mid.y})`);
    }
    const temp = layer.querySelector<SVGGElement>('g.link-temp');
    if (temp && d) {
      const a = box(d.from);
      const target = d.over ? box(d.over) : null;
      if (a) {
        const c = curve(a, target ?? { x: d.at.x - 1, y: d.at.y - 1, width: 2, height: 2 });
        temp.querySelector('.link-path')?.setAttribute('d', c.d);
        temp.querySelector('.link-arrow')?.setAttribute('d', c.arrow);
      }
    }
    const at = id ? box(id) : null;
    if (p) {
      if (p.hidden !== (at === null)) p.hidden = at === null;
      if (at) p.style.translate = `${at.x + at.width}px ${at.y + at.height / 2}px`;
    }
  }, [board, scale, hovered, lines]);

  // The loop runs the latest paint: one already running would otherwise draw with the state it
  // started under (the port of a card no longer hovered, or none for the one that is).
  const paintNow = useRef(paint);
  paintNow.current = paint;
  const tracking = useRef(false);
  tracking.current = lines.length > 0 || !!hovered || !!drag;
  const kick = useCallback((ms = FOLLOW_MS) => {
    if (!tracking.current) return;
    until.current = Math.max(until.current, performance.now() + ms);
    if (frame.current) return;
    const loop = () => {
      paintNow.current();
      frame.current = tracking.current && performance.now() < until.current ? requestAnimationFrame(loop) : 0;
    };
    frame.current = requestAnimationFrame(loop);
  }, []);
  useImperativeHandle(ref, () => ({ kick }), [kick]);
  useEffect(() => () => { cancelAnimationFrame(frame.current); frame.current = 0; }, []);

  // A hover or link edit needs one paint. Canvas explicitly kicks tracking when it starts a glide.
  useLayoutEffect(() => { paint(); });

  // Anything that starts moving on the board (a zone gliding, a card's entrance) is followed too;
  // the card under the pointer gets the port.
  useEffect(() => {
    const host = board.current;
    if (!host) return;
    // Colours, shadows and portrait transitions bubble through the board as the
    // pointer crosses it. Only a card or its container moving changes its endpoints.
    const animate = (e: AnimationEvent) => {
      if (!e.pseudoElement && (e.animationName === 'zone-in' || e.animationName === 'card-in')
        && e.target instanceof Element && e.target.matches('.zone, .card')) kick(700);
    };
    const transition = (e: TransitionEvent) => {
      if (e.pseudoElement || !(e.target instanceof Element)) return;
      if (['translate', 'scale', 'rotate', 'transform', '--earlier-open'].includes(e.propertyName)
        && (e.target.matches('.zone, .card') || e.target.querySelector('.card'))) kick(700);
    };
    const over = (e: PointerEvent) => {
      if (dragRef.current) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('.link-port, .link-x')) return;
      const card = target?.closest<HTMLElement>('.card[data-card-id]');
      const id = card?.dataset.cardId ?? null;
      setNear(id);
      setHovered(id !== null && canLink(id) ? id : null);
    };
    const leave = (e: PointerEvent) => {
      const next = e.relatedTarget instanceof Element ? e.relatedTarget : null;
      if (!next || !host.contains(next)) { setHovered(null); setNear(null); }
    };
    host.addEventListener('animationstart', animate);
    host.addEventListener('transitionrun', transition);
    host.addEventListener('pointerover', over);
    host.addEventListener('pointerleave', leave);
    return () => {
      host.removeEventListener('animationstart', animate);
      host.removeEventListener('transitionrun', transition);
      host.removeEventListener('pointerover', over);
      host.removeEventListener('pointerleave', leave);
    };
  }, [board, kick, canLink]);

  /** A pointer position on the board. */
  const onBoard = (e: { clientX: number; clientY: number }) => {
    const b = board.current!.getBoundingClientRect();
    const k = scale() || 1;
    return { x: (e.clientX - b.left) / k, y: (e.clientY - b.top) / k };
  };
  const cardUnder = (hit: Element | null, from: string): string | null => {
    const el = hit?.closest<HTMLElement>('.card[data-card-id]');
    const id = el && board.current?.contains(el) ? el.dataset.cardId ?? null : null;
    return id !== null && id !== from ? id : null;
  };

  const startDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const from = hovered;
    if (!e.isPrimary || e.button !== 0 || from === null) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setDrag({ from, at: onBoard(e), over: null });
    const move = (ev: PointerEvent) => {
      if (ev.pointerId === e.pointerId) setDrag({ from, at: onBoard(ev), over: cardUnder(document.elementFromPoint(ev.clientX, ev.clientY), from) });
    };
    const end = (ev: PointerEvent | null) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      setDrag(null);
      if (!ev) return;
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const to = cardUnder(hit, from);
      if (to !== null) onLink(from, to);
      else if (hit && (hit === board.current?.parentElement || (board.current?.contains(hit) && hit.matches('.board, .zone, .cards, .col')))) {
        onNewSession?.(from, hit.closest<HTMLElement>('.zone')?.dataset.zoneId);
      }
    };
    const up = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) end(ev); };
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) end(null); };
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(null); } };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
  };

  // The card a link is dropped on is lit while the line is over it.
  useEffect(() => {
    const host = board.current;
    const id = drag?.over;
    const el = host && id ? cardEl(host, id) : null;
    el?.classList.add('is-link-target');
    return () => el?.classList.remove('is-link-target');
  }, [board, drag?.over]);

  const portName = hovered ? nameOf(hovered) : '';
  return (
    <>
      <svg ref={svg} className={`links${drag ? ' is-linking' : ''}`} width="1" height="1" aria-hidden={lines.length === 0 && !drag ? true : undefined}>
        {lines.map((l) => {
          const label = `${nameOf(l.to)} runs after ${nameOf(l.from)}`;
          return (
            <g key={l.key} className={`link-line is-${l.state}${near !== null && (l.from === near || l.to === near) ? ' is-near' : ''}`} data-from={l.from} data-to={l.to} data-state={l.state} data-run={l.runId}>
              <title>{label}</title>
              <path className="link-hit" />
              <path className="link-path" />
              <path className="link-arrow" />
              <circle className="link-dot" r="3.5" />
              <g className="link-x" role="button" tabIndex={0} aria-label={`Remove the link: ${label}`} data-no-pan=""
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onUnlink(l.from, l.to)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onUnlink(l.from, l.to); } }}>
                <circle r="9" />
                <path d="M-3 -3L3 3M3 -3L-3 3" />
              </g>
            </g>
          );
        })}
        {drag && <g className="link-temp"><path className="link-path" /><path className="link-arrow" /></g>}
      </svg>
      <button
        ref={port}
        type="button"
        className={`link-port${drag ? ' is-held' : ''}`}
        hidden
        data-no-pan=""
        tabIndex={-1}
        aria-label={portName ? `Drag onto a card or empty canvas to run a session after ${portName}` : 'Link'}
        title={portName ? `Drag onto a card to link it, or empty canvas to create a session after “${portName}”` : undefined}
        onPointerDown={startDrag}
        onClick={(e) => e.stopPropagation()}
      />
    </>
  );
}
