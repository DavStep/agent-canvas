// A permission request: the loudest thing on screen while it waits. Enter allows and Esc denies,
// only while the card itself has focus; answered or expired, it is one quiet line.
import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ApprovalAnswer, ChatItem } from '../../../shared/chat.ts';
import { isPlan, ToolMeta, toolRowLabel, type ToolItem } from './items/ToolRow.tsx';
import { Markdown } from './Markdown.tsx';

export type ApprovalItem = Extract<ChatItem, { kind: 'approval' }>;

/** What a key does on an approval card. `onCard`: the card itself has focus; `within`: focus is
    on the card or a control inside it. A focused button keeps its own Enter. */
export function approvalKey(e: { key: string; onCard: boolean; within: boolean; pending: boolean; modifiers: boolean }): ApprovalAnswer | null {
  if (!e.pending || e.modifiers) return null;
  if (e.key === 'Enter' && e.onCard) return 'allow';
  if (e.key === 'Escape' && e.within) return 'deny';
  return null;
}

/** The detail without a first paragraph that only repeats the command already on the tool row. */
function detailText(detail: string, tool: ToolItem | null): string {
  const [first, ...rest] = detail.split(/\n\s*\n/);
  return tool !== null && first?.trim() === tool.target.trim() ? rest.join('\n\n').trim() : detail.trim();
}

const DONE: Record<Exclude<ApprovalItem['status'], 'pending'>, string> = {
  allowed: 'Allowed', allowedAlways: 'Always allowed', denied: 'Denied', expired: 'Expired',
};

export interface ApprovalCardProps {
  item: ApprovalItem;
  /** The tool call it is about, shown at the card's top while it waits. */
  tool: ToolItem | null;
  onAnswer(answer: ApprovalAnswer): Promise<void> | void;
}

/** Drawn again only when its props change: unchanged items keep their identity (applyUpdate),
    so a streaming chat redraws only the item that grows. */
export const ApprovalCard = memo(function ApprovalCard({ item, tool, onAnswer }: ApprovalCardProps) {
  const card = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = item.status === 'pending';

  // A new request takes focus unless the owner is busy elsewhere (typing, another control).
  useEffect(() => {
    if (!pending) return;
    const active = document.activeElement;
    if (active === null || active === document.body) card.current?.focus({ preventScroll: true });
  }, [pending]);

  const answer = (a: ApprovalAnswer) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    Promise.resolve(onAnswer(a)).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    }).finally(() => setBusy(false));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const a = approvalKey({
      key: e.key, onCard: e.target === e.currentTarget, within: true, pending, modifiers: e.metaKey || e.ctrlKey || e.altKey || e.shiftKey,
    });
    if (a === null) return;
    e.preventDefault();
    e.stopPropagation();
    answer(a);
  };

  if (item.status !== 'pending') {
    const label = item.status === 'allowedAlways' && item.alwaysLabel !== null ? `${DONE.allowedAlways} · ${item.alwaysLabel}` : DONE[item.status];
    return (
      <div className={`t-asked is-${item.status}`} role="group" aria-label="Permission request">
        <span className="t-asked-title">{item.title}</span>
        <span className="t-asked-status">{label}</span>
      </div>
    );
  }

  // A plan is read and approved here: all of it, as Markdown.
  const plan = tool !== null && isPlan(tool);
  const command = tool?.tool === 'command' ? tool.target : null;
  const detail = plan ? item.detail.trim() : detailText(item.detail, tool);
  const toolLabel = tool ? toolRowLabel(tool) : null;
  return (
    <div ref={card} className="t-ask" role="group" aria-label="Permission request" tabIndex={0} onKeyDown={onKeyDown}>
      {tool !== null && toolLabel !== null && (
        <div className="t-tool is-head">
          <span className="name">{toolLabel.name}</span>
          {command === null && <span className="target" title={tool.target}>{toolLabel.target}</span>}
          <ToolMeta label={toolLabel} status={tool.status} />
        </div>
      )}
      <div className="t-ask-body">
        <h3>{item.title}</h3>
        {detail !== '' && (plan
          ? <div className="t-ask-detail t-plan"><Markdown text={detail} /></div>
          : <p className="t-ask-detail">{detail}</p>)}
        {command && <pre className="t-ask-command"><code>{command}</code></pre>}
        <div className="t-ask-actions">
          <button type="button" className="t-btn allow" disabled={busy} onClick={() => answer('allow')}>Allow</button>
          {item.alwaysLabel !== null && (
            <button type="button" className="t-btn outline" disabled={busy} title={`Saved to ${item.alwaysLabel}`} onClick={() => answer('allowAlways')}>
              Always allow
            </button>
          )}
          <button type="button" className="t-btn ghost" disabled={busy} onClick={() => answer('deny')}>Deny</button>
          <span className="t-ask-keys" aria-hidden="true"><kbd>↵</kbd><span>allow</span><kbd>esc</kbd><span>deny</span></span>
        </div>
        {item.alwaysLabel !== null && <p className="t-ask-note">Always allow applies to {item.alwaysLabel}.</p>}
        {error !== null && <p className="t-ask-error" role="alert">{error}</p>}
      </div>
    </div>
  );
});
