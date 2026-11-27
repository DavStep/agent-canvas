// A line from the app or the engine: info (stopped), warn (opened in another app), error (crashed).
import { memo } from 'react';
import type { ChatItem } from '../../../../shared/chat.ts';

/** Drawn again only when its props change: unchanged items keep their identity (applyUpdate),
    so a streaming chat redraws only the item that grows. */
export const NoticeItem = memo(function NoticeItem({ item }: { item: Extract<ChatItem, { kind: 'notice' }> }) {
  return (
    <div className={`t-notice is-${item.level}`} role={item.level === 'info' ? undefined : 'status'}>
      <i aria-hidden="true" />
      <span>{item.text}</span>
    </div>
  );
});
