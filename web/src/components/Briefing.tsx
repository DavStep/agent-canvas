import { useState, useSyncExternalStore } from 'react';
import type { SessionView } from '../../../shared/types.ts';
import { ago } from '../ago.ts';
import { doneLabel, isBlocked, isDone, plainText, requestDetail, requestedCommand, requestLabels, titleOf } from '../briefing.ts';
import { interruptionLabel, isInterrupted, limitReady } from '../../../shared/interruption.ts';
import { ORB_DOTS } from './dots.ts';
import { Creature } from '../creature/Creature.tsx';
import { creatureOf } from '../creature/generate.ts';

const narrow = '(max-width: 1239px)';
function subscribeWidth(notify: () => void) {
  const query = window.matchMedia?.(narrow);
  query?.addEventListener('change', notify);
  return () => query?.removeEventListener('change', notify);
}
const pageSizeNow = () => window.matchMedia?.(narrow).matches ? 2 : 3;

function Orb() {
  return <svg className="orb" width="28" height="28" viewBox="0 0 40 40" aria-hidden="true">
    {ORB_DOTS.map(([x, y, w, h, opacity, spark]) => (
      <rect key={`${x},${y}`} className={spark ? 'spark' : undefined} x={x} y={y} width={w} height={h}
        opacity={spark || opacity === 1 ? undefined : opacity} />
    ))}
  </svg>;
}

/** The strip's sessions: those that need the owner (interrupted ones too), requests before
    finished work, each the longest waiting first. Independent of where the cards sit. */
export function stripOrder(sessions: SessionView[]): SessionView[] {
  return sessions.filter((s) => s.state === 'needs_you')
    .sort((a, b) => Number(isDone(a)) - Number(isDone(b)) || a.stateSince - b.stateSince || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface BriefingProps {
  sessions: SessionView[] | null;
  now: number;
  onSelect(id: string, trigger: HTMLElement, keyboard: boolean): void;
  connected: boolean;
}

export function Briefing({ sessions, now, onSelect, connected }: BriefingProps) {
  // Requests first, then finished work not opened yet; within each the longest waiting first, so
  // a new one joins at the end and the chips already shown stay where they are.
  const waiting = connected ? stripOrder(sessions ?? []) : [];
  const blocked = waiting.filter(isBlocked).length;
  const done = waiting.length - blocked;
  const pageSize = useSyncExternalStore(subscribeWidth, pageSizeNow, () => 3);
  const [first, setFirst] = useState(0);
  const last = Math.max(0, Math.ceil(waiting.length / pageSize) - 1);
  const current = Math.min(Math.floor(first / pageSize), last);
  const start = current * pageSize;
  const visible = waiting.slice(start, start + pageSize);
  return (
    <section className="brief" aria-label="Needs you">
      <h2><Orb />Needs you{blocked > 0 && <span key={`b${blocked}`} title={`${blocked} waiting on you`}>{blocked}</span>}
        {done > 0 && <span key={`d${done}`} className="brief-done" title={`${done} finished, not opened yet`}>{done} done</span>}</h2>
      {visible.length ? <div className="brief-requests">
        {visible.map((s) => {
          const kind = s.need ?? 'reply';
          const label = s.interruption && isInterrupted(s) ? interruptionLabel(s.interruption, now) : isDone(s) ? doneLabel(s) : requestLabels[kind];
          const detail = requestedCommand(s) ?? plainText(requestDetail(s));
          return <button key={s.id} type="button" className={`brief-tag${isDone(s) ? ' is-done' : isInterrupted(s) ? (s.interruption && limitReady(s.interruption, now) ? ' is-ready-continue' : ' is-interrupted') : ''}`} onClick={(e) => onSelect(s.id, e.currentTarget, e.detail === 0)}>
            <span className="brief-icon"><Creature {...creatureOf(s)} label={s.acp?.name} state={isDone(s) ? 'done' : s.state} size={24} /></span>
            <span className="brief-lines"><strong>{titleOf(s)}</strong>
              <span><b>{label}</b>{detail && detail !== label && <span className="brief-detail">{detail}</span>}</span>
            </span>
            <small>{ago(s.stateSince, now)}</small>
          </button>;
        })}
      </div> : <p className="brief-empty">{!connected ? 'Reconnecting…' : !sessions ? 'Connecting to the reader…'
        : sessions.length ? 'No requests waiting' : 'No sessions running'}</p>}
      {last > 0 && <nav className="brief-pages" aria-label="Waiting requests">
        <button aria-label="Previous requests" disabled={current === 0} onClick={() => setFirst(start - pageSize)}>‹</button>
        <span>{start + 1}–{start + visible.length}</span>
        <button aria-label="Next requests" disabled={current === last} onClick={() => setFirst(start + pageSize)}>›</button>
      </nav>}
    </section>
  );
}
