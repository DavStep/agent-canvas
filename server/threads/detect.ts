// The cheap pass: which turns of a chat look like an open loop. Pure and import-free, so it is
// easy to test and costs nothing to run over every transcript on every scan. Anything it finds is
// only a candidate; a small model call (judge.ts) decides whether it is really still open and
// writes the ticket's words.

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  /** Epoch ms. */
  at: number;
}

export interface OpenLoop {
  /** When the assistant asked (epoch ms). */
  askedAt: number;
  /** The question or offer, as it was written. */
  question: string;
  /** The closing part of that turn, for the ticket and the prepared message. */
  excerpt: string;
  /** What the owner said after it, oldest first: the judge reads it, and so does the auto-resolve. */
  after: string[];
}

/** An assistant turn shorter than this is a remark, not a discussion worth a ticket. */
const MIN_ASK_CHARS = 120;
/** How much of the closing part a ticket quotes. */
const MAX_EXCERPT = 1200;
const MAX_QUESTION = 300;
/** How many of the owner's later messages the judge is shown. */
const MAX_AFTER = 4;
const MAX_AFTER_CHARS = 600;

/** Offers that wait on the owner without a question mark ("Tell me, and I'll…"). */
const OFFERS = [
  /\bwant me to\b/i, /\bshould i\b/i, /\bshall i\b/i, /\bdo you want\b/i, /\bwould you like\b/i,
  /\bdo you prefer\b/i, /\blet me know\b/i, /\btell me\b/i, /\bsay the word\b/i,
  /\bif you(?:'| a)?r?e? (?:happy|ok|fine) with\b/i, /\bi can .{0,60}\bif you\b/i, /\bwhich (?:one|of these|would)\b/i,
];

/** Words too common to say two messages are about the same thing. */
const STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'any', 'are', 'because', 'been', 'before', 'both', 'but', 'can',
  'could', 'does', 'doing', 'done', 'each', 'else', 'ever', 'every', 'first', 'for', 'from', 'going', 'have',
  'here', 'into', 'just', 'keep', 'know', 'like', 'make', 'many', 'maybe', 'more', 'most', 'much', 'need',
  'next', 'not', 'now', 'only', 'other', 'over', 'same', 'should', 'since', 'some', 'start', 'still', 'take',
  'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'things', 'this',
  'those', 'time', 'use', 'very', 'want', 'was', 'well', 'were', 'what', 'when', 'where', 'which', 'while',
  'will', 'with', 'would', 'you', 'your',
]);

/** Short replies that answer whatever was asked. */
const AGREEMENT = /^(?:yes|yep|yeah|no|nope|sure|ok(?:ay)?|do it|go ahead|please do|sounds good|both|either|the (?:first|second|latter|former)|option \d|\d)\b/i;

const blocks = (text: string): string[] => text.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b !== '');

const sentences = (text: string): string[] =>
  text.replace(/\s+/g, ' ').split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter((s) => s !== '');

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * The ask at the end of an assistant turn, or null. Only the closing part is read: a question
 * inside a long answer is usually rhetorical, while one at the end is the turn handing back.
 */
export function askIn(text: string): string | null {
  const parts = blocks(text);
  if (parts.length === 0) return null;
  const tail = parts.slice(-2).join('\n\n');
  const asked = sentences(tail).filter((s) => s.endsWith('?'));
  if (asked.length > 0) return cut(asked.slice(-2).join(' '), MAX_QUESTION);
  const offer = sentences(tail).findLast((s) => OFFERS.some((re) => re.test(s)));
  return offer === undefined ? null : cut(offer, MAX_QUESTION);
}

const words = (text: string): Set<string> => new Set(
  text.toLowerCase().match(/[a-z][a-z-]{2,}/g)?.filter((w) => w.length >= 4 && !STOPWORDS.has(w)) ?? [],
);

/**
 * Whether one of the owner's later messages reads as an answer to the question: a short "yes"
 * or "do it" straight after it, or a message about the same things. Deliberately generous — a
 * loop that looks answered costs no model call, and the owner can always ask again.
 */
export function looksAnswered(question: string, replies: readonly string[]): boolean {
  const asked = words(question);
  for (const reply of replies) {
    const text = reply.trim();
    if (text === '') continue;
    if (AGREEMENT.test(text)) return true;
    const shared = [...words(text)].filter((w) => asked.has(w)).length;
    if (shared >= (text.length < 60 ? 1 : 2)) return true;
  }
  return false;
}

export interface LoopOptions {
  now: number;
  /** How long a chat must have been quiet, or how long before the owner came back on something
      else, for an unanswered ask to count as forgotten. */
  idleMs: number;
  /** How many loops one chat may offer, newest first (2 by default). */
  max?: number;
}

/**
 * The open loops in one chat, newest first: an assistant turn that ended by asking the owner
 * something, where no later message of theirs answers it, and either the chat has been quiet
 * since or they came back to something else after a while.
 */
export function openLoops(turns: readonly Turn[], opts: LoopOptions): OpenLoop[] {
  const found: OpenLoop[] = [];
  const max = opts.max ?? 2;
  for (let i = turns.length - 1; i >= 0 && found.length < max; i--) {
    const turn = turns[i]!;
    if (turn.role !== 'assistant' || turn.text.trim().length < MIN_ASK_CHARS) continue;
    // A chat that opens with the assistant is a report, not a conversation.
    if (!turns.slice(0, i).some((t) => t.role === 'user')) continue;
    const question = askIn(turn.text);
    if (question === null) continue;
    const after = turns.slice(i + 1).filter((t) => t.role === 'user' && t.text.trim() !== '');
    if (after.length > 0) {
      // The owner wrote back at once: whatever they said, the ask was not forgotten.
      if (after[0]!.at - turn.at < opts.idleMs) continue;
      if (looksAnswered(question, after.map((t) => t.text))) continue;
    } else if (opts.now - turn.at < opts.idleMs) {
      continue; // just asked: the owner may still be reading it
    }
    const parts = blocks(turn.text);
    found.push({
      askedAt: turn.at,
      question,
      excerpt: cut(parts.slice(-6).join('\n\n').slice(-MAX_EXCERPT), MAX_EXCERPT),
      after: after.slice(0, MAX_AFTER).map((t) => cut(t.text.trim(), MAX_AFTER_CHARS)),
    });
  }
  return found;
}
