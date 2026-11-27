import { useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { ActivityEntry } from '../../../shared/types.ts';
import { requestLabels, titleOf } from '../briefing.ts';
import { CardIcon, requestIcons } from './CardIcon.tsx';

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

export function ActivityLogMenu({ entries, onOpen }: {
  entries: ActivityEntry[];
  onOpen(id: string, trigger: HTMLElement, keyboard: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const today = new Date().toDateString();
  return <>
    <button className="canvas-corner-button log-button" ref={trigger} type="button" popoverTarget="activity-log" title="Activity log" aria-label="Log" aria-expanded={open}>
      <CardIcon name="history" />
    </button>
    {createPortal(<section className="activity-log" id="activity-log" ref={panel} popover="auto" onToggle={e => setOpen(e.newState === 'open')} aria-labelledby="log-heading">
      <h2 id="log-heading">Activity log</h2>
      {open && (entries.length === 0 ? <p>Completions and review requests will appear here.</p> :
        <ol>{entries.map((e, i) => {
          const stamp = new Date(e.at);
          return <li key={JSON.stringify([e.sessionId, e.kind, e.at])} style={{ '--i': i } as CSSProperties}>
            <button type="button" onClick={event => {
              panel.current?.hidePopover();
              if (trigger.current) onOpen(e.sessionId, trigger.current, event.detail === 0);
            }}>
              <span className="log-event" data-kind={e.kind}><CardIcon name={requestIcons[e.kind]} />{requestLabels[e.kind]}</span>
              <time dateTime={stamp.toISOString()} title={stamp.toLocaleString()}>
                {stamp.toDateString() !== today && date.format(stamp) + ' · '}{time.format(stamp)}
              </time>
              <strong title={titleOf(e)}>{titleOf(e)}</strong>
              {e.folder && <span className="log-folder">{e.folder}</span>}
            </button>
          </li>;
        })}</ol>)}
    </section>, document.body)}
  </>;
}
