// The session's reasoning: one quiet line ("Thought for 6s") that opens in place.
import { memo, useState } from 'react';
import type { ChatItem } from '../../../../shared/chat.ts';
import { LinkedText } from '../Markdown.tsx';
import { Chevron } from './ToolRow.tsx';

type Reasoning = Extract<ChatItem, { kind: 'reasoning' }>;

export function reasoningLabel(item: Pick<Reasoning, 'streaming' | 'durationMs'>): string {
  if (item.streaming) return 'Thinking…';
  if (item.durationMs === null) return 'Thought';
  const s = Math.max(1, Math.round(item.durationMs / 1000));
  return s < 60 ? `Thought for ${s}s` : `Thought for ${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Drawn again only when its props change: unchanged items keep their identity (applyUpdate),
    so a streaming chat redraws only the item that grows. */
export const ReasoningItem = memo(function ReasoningItem({ item }: { item: Reasoning }) {
  const [open, setOpen] = useState(false);
  const hasText = item.text.trim() !== '';
  return (
    <div className="t-reasoning">
      <button type="button" className="t-thought" aria-expanded={hasText ? open : undefined} onClick={() => setOpen((o) => !o)}>
        <Chevron open={open && hasText} />
        {reasoningLabel(item)}
      </button>
      {open && hasText && <div className="t-thought-text"><LinkedText text={item.text} /></div>}
    </div>
  );
});
