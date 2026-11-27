import { describe, expect, it } from 'vitest';
import { ApprovalCard } from './ApprovalCard.tsx';
import { AssistantItem } from './items/AssistantItem.tsx';
import { NoticeItem } from './items/NoticeItem.tsx';
import { ReasoningItem } from './items/ReasoningItem.tsx';
import { ToolRow } from './items/ToolRow.tsx';
import { UserItem } from './items/UserItem.tsx';
import { Markdown } from './Markdown.tsx';
import { QuestionCard } from './QuestionCard.tsx';

describe('thread items are memoised', () => {
  it('each item component (and Markdown) redraws only when its props change', () => {
    const MEMO = Symbol.for('react.memo');
    for (const c of [ApprovalCard, AssistantItem, NoticeItem, ReasoningItem, ToolRow, UserItem, Markdown, QuestionCard]) {
      expect((c as unknown as { $$typeof: symbol }).$$typeof).toBe(MEMO);
    }
  });
});
