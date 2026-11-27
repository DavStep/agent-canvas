// An open thread: something the owner talked about in a chat and left hanging. The detector
// (server/threads) makes them, the canvas shows them in its Open threads area, and dragging one
// into a chat or onto a zone carries this much context with it.
import type { Provider } from './chat.ts';

export interface OpenThread {
  /** The source chat and the turn that asked, hashed: the same loop always gets the same id, so a
      thread the owner dismissed is never made again. */
  id: string;
  /** A short name for the thread ("Tile Merger events"). */
  title: string;
  /** Two to four lines: what was discussed, and what was proposed. */
  summary: string;
  /** The question or decision still waiting on the owner. */
  question: string;
  /** The chat it came from: its card id, its name when the thread was made, and its provider. */
  sessionId: string;
  sessionName: string;
  provider: Provider;
  /** The project folder the chat ran in, and the zone key the canvas groups it under. */
  cwd: string;
  folder: string;
  /** When the question was asked, and when this thread was first made (epoch ms). */
  askedAt: number;
  foundAt: number;
  /** The passage a prepared message quotes, as the chat wrote it. */
  excerpt: string;
  /** 'done': the owner marked it done, or the source chat took it up again. */
  state: 'open' | 'done';
}

/** What the canvas and the canvas agent can do to a thread. A dismissal is remembered for good
    (so the detector does not make it again) and `restore` is the undo of one. */
export type ThreadOp =
  | { type: 'dismiss'; id: string }
  | { type: 'restore'; id: string }
  | { type: 'done'; id: string };

export const isThreadOp = (v: unknown): v is ThreadOp => {
  if (typeof v !== 'object' || v === null) return false;
  const op = v as { type?: unknown; id?: unknown };
  return (op.type === 'dismiss' || op.type === 'restore' || op.type === 'done') && typeof op.id === 'string' && op.id !== '';
};

/** A short stable hash (FNV-1a, base36): the same text always gives the same id. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** A thread's id: its chat, the minute it was asked, and the question. The minute (not the
    millisecond) keeps the id steady when a transcript is read again and rounds differently. */
export function threadKey(sessionId: string, askedAt: number, question: string): string {
  return `${sessionId}#${hash(`${Math.floor(askedAt / 60_000)}\n${question.trim().slice(0, 200)}`)}`;
}

const quote = (text: string): string => text.split('\n').map((line) => `> ${line}`).join('\n');

/** The message a dropped thread puts in the composer, or sends as a new session's first prompt:
    the summary, the open question, where it came from, and the passage itself. The owner reads it
    before it goes anywhere, so it says plainly what it is picking up. */
export function preparedMessage(t: OpenThread, opts: { ago?: string } = {}): string {
  const when = opts.ago === undefined ? '' : ` about ${opts.ago} ago`;
  const from = t.sessionName === '' ? `an earlier ${t.provider === 'codex' ? 'Codex' : 'Claude'} chat` : `“${t.sessionName}”`;
  return [
    `Picking up something we left open: **${t.title}**.`,
    '',
    t.summary,
    '',
    `**Still open:** ${t.question}`,
    '',
    `This came from ${from}${when}${t.cwd === '' ? '' : `, working in ${t.cwd}`}. What it said then:`,
    '',
    quote(t.excerpt),
  ].join('\n');
}
