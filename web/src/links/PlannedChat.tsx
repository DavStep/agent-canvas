// The queued first turn, shown in the chat panel until the provider creates its live session.
import type { RunView } from '../../../shared/runs.ts';
import { PanelHeader } from '../chat/ChatScreen.tsx';
import { PanelEdge, type PanelEdgeProps } from '../chat/PanelEdge.tsx';
import { UserItem } from '../chat/items/UserItem.tsx';
import { plannedName } from './links.ts';

export function PlannedChat({ run, onClose, width, onResize, closing }: PanelEdgeProps & {
  run: RunView;
  onClose(): void;
  closing?: boolean;
}) {
  return (
    <aside className={`chat-screen is-panel${closing ? ' is-closing' : ''}`} aria-label="Chat panel" inert={closing} aria-hidden={closing || undefined}>
      <PanelHeader title={plannedName(run)} meta={run.folder} onClose={onClose} />
      <section className="desk" aria-label="Chat">
        <div className="thread" role="log" aria-label="Conversation">
          <div className="thread-col">
            {run.attachmentNames?.length && <p className="cs-meta">{run.attachmentNames.join(' · ')}</p>}
            {run.prompt && <UserItem item={{ kind: 'user', id: run.id, at: run.createdAt, text: run.prompt, images: [] }} />}
          </div>
        </div>
        <div className="cs-banner" role="status">{run.reason}</div>
      </section>
      <PanelEdge width={width} onResize={onResize} />
    </aside>
  );
}
