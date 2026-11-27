// One session on the canvas, in one of the mockup's densities: working, needs you, idle (compact).
import type { CSSProperties, KeyboardEvent, PointerEvent, Ref } from 'react';
import type { RunStep, SessionView, SubagentView } from '../../../shared/types.ts';
import { ago } from '../ago.ts';
import { doneLabel, isAnswered, isDone, plainText, requestDetail, requestLabels, stepLabel, titleOf } from '../briefing.ts';
import { Creature } from '../creature/Creature.tsx';
import { creatureOf } from '../creature/generate.ts';
import { CardIcon, requestIcons } from './CardIcon.tsx';
import { interruptionLabel, isInterrupted, limitReady } from '../../../shared/interruption.ts';
import type { CardWait } from '../links/links.ts';
import { WaitChip } from '../links/WaitChip.tsx';
import { modelLabel } from '../../../shared/modelLabel.ts';

const MAX_SUBS = 4;

/** A subagent's own small creature. */
export function SubCreature({ sub, provider }: { sub: SubagentView; provider: SessionView['provider'] }) {
  return <Creature {...creatureOf({ provider })} state={sub.state} size={20} />;
}

/** The activity line of a working session that says nothing more than its state line. */
const GENERIC_WORKING = 'Working';

/** The card's current-activity line: what a working session is doing, or what a waiting one says. */
export const hasActivity = (s: SessionView): boolean =>
  (s.state === 'working' || s.state === 'needs_you') && s.activity !== null && s.activity.trim() !== ''
  && !(s.state === 'working' && s.activity === GENERIC_WORKING);

/** A finished, unopened session is "done" (green, clears on open); any other wait is "needs" (amber). */
const stateClass = (s: SessionView, now: number): string =>
  s.state === 'working' ? 'is-working' : isDone(s) ? 'is-done' : isInterrupted(s) ? (readyToContinue(s, now) ? 'is-ready-continue' : 'is-interrupted')
    : s.state === 'needs_you' ? 'is-needs' : s.state === 'idle' ? 'is-idle' : 'is-idle is-unknown';

/** Cut off by a limit that has since reset: no longer red, only waiting for Continue. */
const readyToContinue = (s: SessionView, now: number): boolean => !!s.interruption && isInterrupted(s) && limitReady(s.interruption, now);

/** "Idle", or "Unknown" with the status as the app wrote it (when it wrote one) beside it. */
function QuietChips({ session }: { session: SessionView }) {
  if (session.state === 'idle') return <span className="chip">Idle</span>;
  const raw = session.rawStatus.trim();
  return <>
    <span className="chip">Unknown</span>
    {raw !== '' && <span className="chip raw" title={`Status as the app wrote it: ${raw}`}>{raw}</span>}
  </>;
}

/** State at a glance, including what a waiting chat needs from the owner. */
export function StateLine({ session, now = Date.now() }: { session: SessionView; now?: number }) {
  if (session.state === 'working') return <div className="state"><i className="live" />Working</div>;
  // A limit that has reset: calm, with what to do next.
  if (readyToContinue(session, now)) {
    return <div className="state"><span className="request-state is-ready-continue" title={session.interruption!.reason}>
      <i className="ready-dot" aria-hidden="true" />Ready to continue
    </span></div>;
  }
  // Cut off by a limit, an error or its process ending: a red dot with "!" and what happened.
  if (session.interruption && isInterrupted(session)) {
    return <div className="state"><span className="request-state is-interrupted" title={session.interruption.reason}>
      <i className="alert-dot" aria-hidden="true">!</i>{interruptionLabel(session.interruption, now)}
    </span></div>;
  }
  if (session.state === 'needs_you') {
    return <div className="state"><span className={`request-state${isDone(session) ? ' is-done' : ''}`}><CardIcon name={requestIcons[session.need ?? 'reply']} />{isDone(session) ? doneLabel(session) : requestLabels[session.need ?? 'reply']}</span></div>;
  }
  return <div className="state"><QuietChips session={session} /></div>;
}

function Tick() {
  return <svg width="10" height="8" viewBox="0 0 10 8" aria-hidden="true"><path className="tick" d="M1 4.2 3.8 7 9 1" /></svg>;
}

export function SubState({ sub }: { sub: SubagentView }) {
  return sub.state === 'working'
    ? <span className="sub-state"><i className="live" />working</span>
    : <span className="sub-state"><Tick />done</span>;
}

function activityIcon(s: SessionView): Parameters<typeof CardIcon>[0]['name'] {
  if (s.need === 'interrupted') return s.interruption && limitReady(s.interruption, Date.now()) ? 'message' : 'alert';
  if (s.need === 'terminal' || s.need === 'permission') return 'command';
  if (s.need) return 'message';
  const verb = s.activity?.split(' ', 1)[0]?.toLowerCase();
  switch (verb) {
    case 'editing': return 'edit';
    case 'reading': return 'read';
    case 'searching': return 'search';
    case 'running': case 'running:': return 'command';
    case 'writing': return 'message';
    default: return 'tool';
  }
}

function stepTime(step: RunStep): string {
  if (step.status === 'failed') return 'failed';
  if (step.status === 'running') return 'running';
  if (step.durationMs === undefined) return 'done';
  const seconds = step.durationMs / 1000;
  return seconds < 60 ? `${Math.round(seconds * 10) / 10}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

function RunActivity({ session: s }: { session: SessionView }) {
  const activity = hasActivity(s) ? plainText(s.state === 'needs_you' ? requestDetail(s) || s.activity! : s.activity!) : null;
  const steps = s.recentSteps ?? [];
  if (!activity && !steps.length) return null;
  return <ol className="run-steps" aria-label="Recent activity">
    {steps.map((step, i) => <li key={i} className={`run-step is-${step.status}`} title={step.label}>
      <CardIcon name={step.kind} /><span>{stepLabel(step.label)}</span><small>{stepTime(step)}</small>
    </li>)}
    {activity && <li key={`now:${activity}`} className="run-step is-current">
      <CardIcon name={activityIcon(s)} /><span title={activity}>{activity}</span>
    </li>}
  </ol>;
}

function Subagents({ subs, provider }: { subs: SubagentView[]; provider: SessionView['provider'] }) {
  const shown = subs.slice(0, MAX_SUBS);
  const done = subs.filter((sub) => sub.state === 'done').length;
  return (
    <div className="subs" aria-label="Subagents">
      <div className="sub-progress"><span>Subagents</span><span>{done}/{subs.length} done</span>
        <progress aria-label="Completed subagents" value={done} max={subs.length} />
      </div>
      {shown.map((sub) => (
        <div className="sub" key={sub.id}>
          <SubCreature sub={sub} provider={provider} />
          <span className="sub-name" title={sub.type}>{sub.description.trim() || sub.type}</span>
          <SubState sub={sub} />
        </div>
      ))}
      {subs.length > shown.length && <span className="subs-more">and {subs.length - shown.length} more</span>}
    </div>
  );
}

export interface CardProps {
  session: SessionView;
  orchestrator?: boolean;
  canvasId?: string;
  selected: boolean;
  now: number;
  onSelect(id: string, trigger: HTMLElement, keyboard: boolean): void;
  /** A press on the card: the start of a drag, or a click if it barely moves. */
  onPointerDown?(e: PointerEvent<HTMLElement>): void;
  /** The pointer currently holds this card. */
  dragging?: boolean;
  /** The card's place in its zone: staggers its entrance (docs/motion.md). */
  index?: number;
  /** ` is-hit` while the search box finds this card (Zone.tsx `searchClass`). */
  searchClass?: string;
  /** A prompt queued for this card, waiting on other sessions (web/src/links): its state shows "Waiting for …". */
  wait?: CardWait | null;
  ref?: Ref<HTMLElement>;
}

export function Card({
  session: s, orchestrator = false, canvasId, selected, now, onSelect, onPointerDown, dragging, index = 0, searchClass = '', wait = null, ref,
}: CardProps) {
  const title = orchestrator ? 'Project orchestrator' : titleOf(s);
  const since = ago(s.stateSince, now);
  const openChat = (trigger: HTMLElement, keyboard: boolean) => onSelect(s.id, trigger, keyboard);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChat(e.currentTarget, true); }
  };
  const compact = s.state === 'idle' || s.state === 'unknown';

  const ageText = since === 'yesterday' ? since : compact ? `${since} ago` : since;
  const age = <span className="card-age" title={`${compact ? 'Last active' : s.state === 'working' ? 'Working' : isAnswered(s) ? 'Answered' : isDone(s) ? 'Finished' : isInterrupted(s) ? 'Interrupted' : 'Waiting'} · ${ageText}`}>
    <CardIcon name="clock" />{ageText}
  </span>;
  const branch = s.branch && <span className="card-fact" title={`Branch · ${s.branch}`}>
    <CardIcon name="branch" /><span>{s.branch}</span>
  </span>;
  return (
    <article
      ref={ref}
      className={`card ${stateClass(s, now)}${orchestrator ? ' project-chat-card' : ''}${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}${wait ? ` is-waiting${wait.blocked ? ' is-blocked' : ''}` : ''}${searchClass}`}
      style={{ '--i': index } as CSSProperties}
      data-card-id={canvasId ?? s.id}
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      onClick={(e) => openChat(e.currentTarget, e.detail === 0)}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    >
      <div className="card-head">
        <h3 className="title" title={title}>{title}</h3>
        <Creature {...(orchestrator ? { provider: 'orchestrator' as const } : creatureOf(s))} label={s.acp?.name} state={isDone(s) ? 'done' : s.state} size={40} />
      </div>
      {orchestrator && compact && s.lastAnswer && <p className="project-chat-excerpt">{plainText(s.lastAnswer)}</p>}
      {compact ? (
        <div className="meta">
          {wait ? <WaitChip wait={wait} /> : <QuietChips session={s} />}
          {s.acp && <span className="chip card-agent" title={`ACP agent · ${s.acp.name}`}>{s.acp.name}</span>}
          {branch}{age}
        </div>
      ) : (
        <>
          <div className="run-status"><StateLine session={s} now={now} />{age}</div>
          <RunActivity session={s} />
          {wait && <div className="link-wait-row"><WaitChip wait={wait} /></div>}
          {(s.acp || s.model || branch) && <div className="card-facts">
            {s.acp && <span className="card-fact card-agent" title={`ACP agent · ${s.acp.name}`}><span>{s.acp.name}</span></span>}
            {s.model && <span className="card-fact" title={`Model · ${modelLabel(s.provider, s.model, s.effort)}`}>
              <CardIcon name="model" /><span>{modelLabel(s.provider, s.model, s.effort)}</span>
            </span>}
            {branch}
          </div>}
          {s.subagents.length > 0 && <Subagents subs={s.subagents} provider={s.provider} />}
        </>
      )}
    </article>
  );
}
