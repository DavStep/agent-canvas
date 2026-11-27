// The chat screen's left rail: every session grouped Needs you, Working, Idle, like the Claude
// app's sidebar, with a zone filter. Choosing a row opens that chat.
import { useState, type CSSProperties } from 'react';
import type { Layout, SessionView, ZoneLayout } from '../../../shared/types.ts';
import { ago } from '../ago.ts';
import { isAnswered, isBlocked, isDone, needLabel, titleOf } from '../briefing.ts';
import { interruptionLabel, isInterrupted, limitReady } from '../../../shared/interruption.ts';
import { zonesWithCards } from '../components/Canvas.tsx';
import { zoneHue, ZoneMark } from '../components/ZoneMark.tsx';
import { Creature } from '../creature/Creature.tsx';
import { creatureOf } from '../creature/generate.ts';

export interface RailGroup { key: 'interrupted' | 'needs' | 'done' | 'working' | 'idle'; label: string; sessions: SessionView[] }

/** Sessions (already in card order) grouped for the rail, only the chosen zone's when one is. */
export function railGroups(sessions: SessionView[], layout: Layout, zoneId: string | null): RailGroup[] {
  const shown = zoneId === null ? sessions : zonesWithCards(sessions, layout).find((g) => g.zone.id === zoneId)?.cards ?? [];
  const keep = new Set(shown.map((s) => s.id));
  const inZone = sessions.filter((s) => keep.has(s.id));
  const groups: RailGroup[] = [
    { key: 'interrupted', label: 'Interrupted', sessions: inZone.filter(isInterrupted) },
    { key: 'needs', label: 'Needs you', sessions: inZone.filter((s) => isBlocked(s) && !isInterrupted(s)) },
    { key: 'done', label: 'Done', sessions: inZone.filter(isDone) },
    { key: 'working', label: 'Working', sessions: inZone.filter((s) => s.state === 'working') },
    { key: 'idle', label: 'Idle', sessions: inZone.filter((s) => s.state === 'idle' || s.state === 'unknown') },
  ];
  return groups.filter((g) => g.sessions.length > 0);
}

function detailOf(s: SessionView, now: number): string | null {
  if (s.interruption && isInterrupted(s)) return interruptionLabel(s.interruption, now);
  if (s.state === 'needs_you') return isAnswered(s) ? 'answered' : needLabel(s.need);
  if (s.state === 'working') return s.activity;
  return null;
}

function Chevron() {
  return <svg className="i chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5l3-3" /></svg>;
}

export interface RailProps {
  projectIds?: ReadonlySet<string>;
  sessions: SessionView[];
  layout: Layout;
  currentId: string;
  now: number;
  onOpen(id: string): void;
  /** "+ New session" (⌘N), in the zone filtered to when there is one. */
  onNewSession(zone: ZoneLayout | null): void;
}

export function Rail({ projectIds, sessions, layout, currentId, now, onOpen, onNewSession }: RailProps) {
  const [zoneId, setZoneId] = useState<string | null>(null);
  const zones = zonesWithCards(sessions, layout).map((g) => g.zone);
  const zone = zones.find((z) => z.id === zoneId) ?? null;
  const groups = railGroups(sessions, layout, zone?.id ?? null);

  return (
    <nav className="rail" aria-label="Sessions">
      <span className="rail-filter">
        <span className="hues" aria-hidden="true">
          {zone ? <span style={{ '--zone-hue': zoneHue(zone) } as CSSProperties}><ZoneMark icon={zone.icon} /></span>
            : zones.slice(0, 4).map((z) => <i key={z.id} style={{ background: zoneHue(z) }} />)}
        </span>
        <span className="label">{zone ? zone.name : 'All zones'}</span>
        <Chevron />
        <select aria-label="Filter by zone" value={zone?.id ?? ''} onChange={(e) => setZoneId(e.target.value === '' ? null : e.target.value)}>
          <option value="">All zones</option>
          {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
        </select>
      </span>
      <div className="rail-sessions">
        {groups.map((g) => (
          <section key={g.key} className="rail-group" aria-label={g.label}>
            <h2><i className={`dot ${g.key}`} />{g.label}<span className="n">{g.sessions.length}</span></h2>
            {g.sessions.map((s) => {
              const detail = detailOf(s, now);
              const quiet = g.key === 'idle';
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`rail-row${quiet ? ' is-idle' : ''}${g.key === 'needs' ? ' is-needs' : g.key === 'done' ? ' is-done' : g.key === 'interrupted' ? (s.interruption && limitReady(s.interruption, now) ? ' is-ready-continue' : ' is-interrupted') : ''}${s.id === currentId ? ' is-selected' : ''}`}
                  aria-current={s.id === currentId ? 'page' : undefined}
                  title={titleOf(s)}
                  onClick={() => onOpen(s.id)}
                >
                  <Creature {...(projectIds?.has(s.id) ? { provider: 'orchestrator' as const } : creatureOf(s))} label={s.acp?.name} state={isDone(s) ? 'done' : s.state} size={20} />
                  <span className="body">
                    <span className="t">{titleOf(s)}</span>
                    {!quiet && (
                      <span className="d"><span>{detail ?? ''}</span><span className="age">{ago(s.stateSince, now)}</span></span>
                    )}
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
      <button type="button" className="rail-new" aria-keyshortcuts="Meta+N" onClick={() => onNewSession(zone)}>
        <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
        New session<kbd>⌘N</kbd>
      </button>
    </nav>
  );
}
