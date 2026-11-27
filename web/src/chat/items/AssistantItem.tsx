// The session's reply, as safe Markdown; a caret while it streams.
import { memo } from 'react';
import type { ChatItem } from '../../../../shared/chat.ts';
import { Markdown } from '../Markdown.tsx';

/** Drawn again only when its props change: unchanged items keep their identity (applyUpdate),
    so a streaming chat redraws only the item that grows. */
export const AssistantItem = memo(function AssistantItem({ item }: { item: Extract<ChatItem, { kind: 'assistant' }> }) {
  return (
    <div className={`t-reply${item.streaming ? ' is-streaming' : ''}`} aria-busy={item.streaming || undefined}>
      <Markdown text={item.text} />
    </div>
  );
});
