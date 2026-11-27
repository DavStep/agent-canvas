// The conversation: the day, the owner's messages, the session's replies with their tool rows
// grouped, approvals and questions in place. It follows the newest item until the owner
// scrolls up, and loads older pages near the top.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AcpBadge } from '../../../shared/acp.ts';
import type { ApprovalAnswer, ChatItem, SessionProvider } from '../../../shared/chat.ts';
import { Creature } from '../creature/Creature.tsx';
import { creatureOf, type CreatureState } from '../creature/generate.ts';
import { ApprovalCard, type ApprovalItem } from './ApprovalCard.tsx';
import { AssistantItem } from './items/AssistantItem.tsx';
import { NoticeItem } from './items/NoticeItem.tsx';
import { ReasoningItem } from './items/ReasoningItem.tsx';
import { ToolRow, type ToolItem } from './items/ToolRow.tsx';
import { ToolGroupSummary } from './items/ToolGroupSummary.tsx';
import { UserItem } from './items/UserItem.tsx';
import { QuestionCard } from './QuestionCard.tsx';
import type { SessionInterruption } from '../../../shared/types.ts';
import { countdown, interruptionLabel, limitLine, limitReady, resetClock } from '../../../shared/interruption.ts';
import { useLiveNow } from './useLiveNow.ts';
import { resetFromText } from '../../../shared/resetTime.ts';
import { promptLine } from '../../../shared/attachments.ts';
import { isQuestion } from '../briefing.ts';

/** How far above the bottom the owner may be and still follow the newest item. */
export const FOLLOW_SLACK = 80;
/** Older items load when the owner scrolls this close to the top. */
const OLDER_AT = 240;

export function followsNewest(el: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= FOLLOW_SLACK;
}

type ActivityBlock = Extract<ThreadBlock, { type: 'tools' | 'item' }>;

export type ThreadBlock =
  | { type: 'work'; key: string; blocks: ActivityBlock[] }
  | { type: 'day'; key: string; label: string }
  | { type: 'who'; key: string; at: number }
  | { type: 'item'; key: string; item: Exclude<ChatItem, { kind: 'tool' } | { kind: 'approval' }> }
  | { type: 'tools'; key: string; items: ToolItem[] }
  | { type: 'approval'; key: string; item: ApprovalItem; tool: ToolItem | null };

const pad = (n: number) => String(n).padStart(2, '0');
export const clock = (at: number): string => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function dayLabel(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `Today ${clock(at)}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${clock(at)}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })} ${clock(at)}`;
}

/** Items → what the thread draws, in order. */
export function threadBlocks(items: ChatItem[], now: number): ThreadBlock[] {
  // A tool waiting on a pending approval is drawn inside the approval card.
  const held = new Map<string, string>();
  for (const i of items) if (i.kind === 'approval' && i.status === 'pending' && i.toolItemId !== null) held.set(i.toolItemId, i.id);
  const tools = new Map(items.filter((i): i is ToolItem => i.kind === 'tool').map((t) => [t.id, t]));

  const out: ThreadBlock[] = [];
  let lastDay: string | null = null;
  let needWho = true;
  for (const item of items) {
    if (item.kind === 'reasoning' && !item.streaming && !item.text.trim()) continue;
    const day = new Date(item.at).toDateString();
    if (day !== lastDay) {
      out.push({ type: 'day', key: `day-${item.id}`, label: dayLabel(item.at, now) });
      lastDay = day;
    }
    if (item.kind === 'user') { out.push({ type: 'item', key: item.id, item }); needWho = true; continue; }
    if (item.kind === 'notice') { out.push({ type: 'item', key: item.id, item }); continue; }
    if (needWho) { out.push({ type: 'who', key: `who-${item.id}`, at: item.at }); needWho = false; }
    if (item.kind === 'tool') {
      if (held.has(item.id)) continue;
      const last = out[out.length - 1];
      if (last?.type === 'tools' && item.name !== 'image_generation' && last.items[0]?.name !== 'image_generation') last.items.push(item);
      else out.push({ type: 'tools', key: `tools-${item.id}`, items: [item] });
    } else if (item.kind === 'approval') {
      const tool = item.status === 'pending' && item.toolItemId !== null ? tools.get(item.toolItemId) ?? null : null;
      out.push({ type: 'approval', key: item.id, item, tool });
    } else {
      out.push({ type: 'item', key: item.id, item });
    }
  }
  // Once an answer arrives, collapse its routine progress into one disclosure. Interruptions,
  // decisions, failures, and media keep their own place in the conversation.
  const compact: ThreadBlock[] = [];
  let progress: ActivityBlock[] = [];
  for (const block of out) {
    const routine = block.type === 'tools' && block.items.every(t => t.status === 'done' && !t.exitCode && !t.media?.length);
    if (routine || (block.type === 'item' && (block.item.kind === 'reasoning' ||
      (block.item.kind === 'assistant' && block.item.commentary && !block.item.text.includes(']('))))) {
      progress.push(block);
      continue;
    }
    if (progress.length > 1 && block.type === 'item' && block.item.kind === 'assistant' && !block.item.commentary) {
      compact.push({ type: 'work', key: `work-${progress[0]!.key}`, blocks: progress });
    } else compact.push(...progress);
    progress = [];
    compact.push(block);
  }
  return compact.concat(progress);
}

/** "42s", "3m 05s", "1h 12m": how long a turn took. */
export function tookLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

/** The finished turn a thread ends on: its last item is a complete answer. `tookMs` runs from the
    prompt that started it, and is null when that prompt is not on the page or the times are off. */
export function finishedTurn(items: ChatItem[]): { tookMs: number | null } | null {
  const last = items[items.length - 1];
  if (last?.kind !== 'assistant' || last.streaming || last.commentary) return null;
  const prompt = items.findLast((i) => i.kind === 'user');
  const took = prompt ? last.at - prompt.at : 0;
  return { tookMs: took >= 1000 ? took : null };
}

/** How the turn a thread ends on ended, for its closing divider: Done only for a real finish. */
/** `reset`: cut off by a limit that has since reset (calm green: it can be continued). `resetsAt`:
    a pending limit's reset, so the divider can count down to it. */
export interface TurnEnding { kind: 'done' | 'stopped' | 'limit' | 'reset' | 'error' | 'killed'; label: string; tookMs: number | null; resetsAt?: number }

/** Claude's own words for a usage limit, which arrive as an ordinary answer ("You've hit your
    5-hour limit · resets 11:10pm"); Codex's likewise ("You've hit your usage limit…"). */
const LIMIT_TEXT = /^(?:API Error: )?(?:You've hit your\b.*\blimit|Claude AI usage limit reached|.*usage limit reached)/i;
const MANUAL_STOP = /^\[Request interrupted by user/;

/** The divider under a resting thread: the session's interruption when it has one, else what the
    last item shows (a limit message, an error, the owner's Stop), else Done for a complete answer. */
export function turnEnding(items: ChatItem[], interruption: SessionInterruption | null, now: number): TurnEnding | null {
  const last = items[items.length - 1];
  if (interruption) {
    if (interruption.kind !== 'limit') return { kind: interruption.kind, label: interruptionLabel(interruption, now), tookMs: null };
    const ready = limitReady(interruption, now);
    return { kind: ready ? 'reset' : 'limit', label: limitLine(interruption, now), tookMs: null,
      ...(!ready && interruption.resetsAt !== null ? { resetsAt: interruption.resetsAt } : {}) };
  }
  if (!last) return null;
  if (last.kind === 'notice') {
    if (last.level === 'error') return { kind: 'error', label: 'Error', tookMs: null };
    return last.text === 'Stopped' ? { kind: 'stopped', label: 'Stopped', tookMs: null } : null;
  }
  if (last.kind === 'user' && MANUAL_STOP.test(last.text)) return { kind: 'stopped', label: 'Stopped', tookMs: null };
  const done = finishedTurn(items);
  if (!done || last.kind !== 'assistant') return null;
  const text = last.text.trim();
  if (text.length < 400 && LIMIT_TEXT.test(text)) {
    const resetsAt = resetFromText(text, last.at);
    if (resetsAt === null) return { kind: 'limit', label: 'Limit hit', tookMs: null };
    if (resetsAt <= now) return { kind: 'reset', label: 'Limit reset · you can continue', tookMs: null };
    return { kind: 'limit', label: `Limit hit · resets ${resetClock(resetsAt, now)} · in ${countdown(resetsAt, now)}`, tookMs: null, resetsAt };
  }
  if (/^API Error:/.test(text)) return { kind: 'error', label: 'Error', tookMs: null };
  return { kind: 'done', label: answeredTurn(items) ? 'Answered' : 'Done', tookMs: done.tookMs };
}

/** The last turn answered a question and edited nothing: its divider says Answered, not Done. */
function answeredTurn(items: ChatItem[]): boolean {
  const at = items.findLastIndex((i) => i.kind === 'user');
  if (at < 0 || !isQuestion(promptLine((items[at] as Extract<ChatItem, { kind: 'user' }>).text))) return false;
  return !items.slice(at + 1).some((i) => i.kind === 'tool' && (i.tool === 'edit' || i.diffs.length > 0));
}

export interface ThreadProps {
  sessionId: string;
  provider: SessionProvider;
  /** An ACP session's agent: its name and icon stand in for the provider's. */
  acp?: AcpBadge;
  creatureState: CreatureState;
  projectOrchestrator?: boolean;
  items: ChatItem[];
  hasOlder: boolean;
  now: number;
  /** The session is at rest (no turn running): a thread that ends on an answer is marked Done. */
  resting: boolean;
  /** The call the owner picked in Live work (null while it follows the newest): its row is marked
      and, in a collapsed group, revealed. */
  pickedTool: string | null;
  onSelectTool(id: string): void;
  onLoadOlder(): Promise<void>;
  onAnswerApproval(id: string, answer: ApprovalAnswer): Promise<void>;
  onAnswerQuestion(id: string, answers: Record<string, string>): Promise<void>;
  /** What an empty thread says instead of "No messages yet." */
  emptyNote?: ReactNode;
  /** How the session's last turn was cut off, if it was: the divider says so instead of Done. */
  interruption?: SessionInterruption | null;
  /** Shown right under the closing divider: the interrupted turn's Continue and Abort. */
  footer?: ReactNode;
}

export function Thread(p: ThreadProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const fromBottom = useRef(0);
  const firstId = useRef<string | null>(null);
  const loading = useRef(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  // Track expansion by a member id so appending or prepending calls preserves the disclosure.
  const [expandedTools, setExpandedTools] = useState<Set<string>>(() => new Set());
  useLayoutEffect(() => {
    const id = p.pickedTool;
    if (id !== null) setExpandedTools((ids) => ids.has(id) ? ids : new Set(ids).add(id));
  }, [p.pickedTool]);

  const loadOlder = () => {
    if (loading.current || !p.hasOlder) return;
    loading.current = true;
    p.onLoadOlder().catch(() => {}).finally(() => { loading.current = false; });
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    follow.current = followsNewest(el);
    fromBottom.current = el.scrollHeight - el.scrollTop;
    if (el.scrollTop < OLDER_AT) loadOlder();
  };

  // After each change: stay on the newest item while following; keep the view still when an
  // older page arrives above it.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = p.items[0]?.id ?? null;
    const prepended = firstId.current !== null && first !== firstId.current;
    firstId.current = first;
    if (follow.current) el.scrollTop = el.scrollHeight;
    else if (prepended) el.scrollTop = el.scrollHeight - fromBottom.current;
    fromBottom.current = el.scrollHeight - el.scrollTop;
  }, [p.items]);

  // The thread also grows without a new item (a row opened, an image loaded): stay at the
  // bottom then too while following.
  useEffect(() => {
    const el = scroller.current;
    const col = column.current;
    if (!el || !col || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => {
      if (follow.current) el.scrollTop = el.scrollHeight;
      follow.current = followsNewest(el);
      fromBottom.current = el.scrollHeight - el.scrollTop;
    });
    watch.observe(col);
    return () => watch.disconnect();
  }, []);

  // Stable callbacks, so the memoised rows and cards redraw only when their own item changes.
  const latest = useRef(p);
  useLayoutEffect(() => { latest.current = p; });
  const toggle = useCallback((id: string) => {
    setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    latest.current.onSelectTool(id);
  }, []);
  const answers = useRef(new Map<string, { approval(a: ApprovalAnswer): Promise<void>; question(a: Record<string, string>): Promise<void> }>());
  const answersFor = (id: string) => {
    let h = answers.current.get(id);
    if (!h) {
      h = { approval: (a) => latest.current.onAnswerApproval(id, a), question: (a) => latest.current.onAnswerQuestion(id, a) };
      answers.current.set(id, h);
    }
    return h;
  };

  const providerName = p.acp?.name ?? (p.provider === 'codex' ? 'Codex' : 'Claude');
  const blocks = threadBlocks(p.items, p.now);
  const settled = p.resting ? turnEnding(p.items, p.interruption ?? null, p.now) : null;
  // A pending limit counts down by the second, and the divider turns to "Limit reset" on time.
  const liveNow = useLiveNow(p.now, settled?.resetsAt ?? null);
  const ending = settled && liveNow !== p.now ? turnEnding(p.items, p.interruption ?? null, liveNow) : settled;
  const draw = (b: ThreadBlock, insideWork = false): ReactNode => {
    switch (b.type) {
      case 'work': {
        const ids = b.blocks.flatMap(block => block.type === 'tools' ? block.items.map(t => t.id) : [block.key]);
        const expanded = ids.some(id => expandedTools.has(id));
        return <div key={b.key} className="t-activity-block">
          <button type="button" className="t-activity" aria-expanded={expanded} onClick={() => {
            if (!expanded) follow.current = false;
            setExpandedTools(current => {
              const next = new Set(current);
              if (expanded) ids.forEach(id => next.delete(id)); else next.add(ids[0]!);
              return next;
            });
          }}><span aria-hidden="true">{expanded ? '⌄' : '›'}</span>Activity · {ids.length} steps</button>
          {expanded && b.blocks.map(block => draw(block, true))}
        </div>;
      }
      case 'day': return <div key={b.key} className="t-day">{b.label}</div>;
      case 'who':
        return (
          <div key={b.key} className="t-who">
            <Creature {...(p.projectOrchestrator ? { provider: 'orchestrator' as const } : creatureOf({ provider: p.provider, acp: p.acp }))} state={p.creatureState} size={20} />
            <b>{p.projectOrchestrator ? 'Project orchestrator' : providerName}</b><span>{clock(b.at)}</span>
          </div>
        );
      case 'tools': {
        const grouped = !insideWork && b.items.length > 1;
        const expanded = !grouped || b.items.some((t) => expandedTools.has(t.id));
        const toggleGroup = () => {
          // Keep the disclosure under the pointer when a long list opens at the bottom.
          if (!expanded) follow.current = false;
          setExpandedTools((ids) => {
            const next = new Set(ids);
            if (expanded) for (const t of b.items) next.delete(t.id);
            else next.add(b.items[0]!.id);
            return next;
          });
        };
        return (
          <div key={b.key} className="t-activity-block">
            {grouped && <ToolGroupSummary items={b.items} expanded={expanded} onToggle={toggleGroup} />}
            {expanded && <div className="t-log">
              {b.items.map((t) => <ToolRow key={t.id} item={t} open={open.has(t.id)} selected={p.pickedTool === t.id} onToggle={toggle} />)}
            </div>}
          </div>
        );
      }
      case 'approval':
        return <ApprovalCard key={b.key} item={b.item} tool={b.tool} onAnswer={answersFor(b.item.id).approval} />;
      case 'item':
        switch (b.item.kind) {
          case 'user': return <UserItem key={b.key} item={b.item} />;
          case 'assistant': return <AssistantItem key={b.key} item={b.item} />;
          case 'reasoning': return <ReasoningItem key={b.key} item={b.item} />;
          case 'notice': return <NoticeItem key={b.key} item={b.item} />;
          case 'question': return <QuestionCard key={b.key} item={b.item} onAnswer={answersFor(b.item.id).question} />;
        }
    }
  };

  return (
    <div ref={scroller} className="thread" onScroll={onScroll} aria-label="Conversation" role="log">
      <div ref={column} className="thread-col">
        {p.hasOlder && <button type="button" className="t-older" onClick={loadOlder}>Earlier messages</button>}
        {blocks.length === 0 ? <div className="t-empty">{p.emptyNote ?? 'No messages yet.'}</div> : blocks.map(block => draw(block))}
        {ending && (ending.kind === 'done' ? (
          <div className="t-done" role="status">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.4 5 8.8l4.5-5.4" /></svg>
            <b>{ending.label}</b>{ending.tookMs !== null && <span>in {tookLabel(ending.tookMs)}</span>}
          </div>
        ) : (
          // Not done: stopped by the owner (quiet), or cut off (red, with a "!" like the card's dot).
          // A limit that has reset: calm green, a dot instead of the "!".
          <div className={`t-done is-${ending.kind === 'stopped' ? 'stopped' : ending.kind === 'reset' ? 'reset' : 'interrupted'}`} role="status">
            {ending.kind === 'reset' ? <i className="ready-dot" aria-hidden="true" /> : ending.kind !== 'stopped' && <i className="alert-dot" aria-hidden="true">!</i>}
            <b>{ending.label}</b>
          </div>
        ))}
        {p.footer}
      </div>
    </div>
  );
}
