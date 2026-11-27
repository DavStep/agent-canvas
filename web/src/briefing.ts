import type { NeedKind, SessionView } from '../../shared/types.ts';

/** The word after "Needs you ·" on cards and in the rail. */
export function needLabel(need: NeedKind | null): string {
  return need === 'terminal' ? 'in terminal' : need === 'reply' ? 'done' : need ?? 'reply';
}

/** A session that finished its turn and has not been opened since: news, not a request. It
    clears itself when its chat is opened. */
export const isDone = (s: Pick<SessionView, 'state' | 'need'>): boolean => s.state === 'needs_you' && s.need === 'reply';

/** A session stopped until the owner acts: an approval, a question or a terminal prompt. */
/** Words that open a request for information rather than for work. */
const ASKS = /^(?:what|what's|whats|why|how|how's|where|where's|when|who|who's|whom|whose|which|explain|describe|tell me)\b/i;
/** "Can you…", "Could you…", "Please…": work asked for politely, even when it ends in "?". */
const POLITE_REQUEST = /^(?:(?:can|could|would|will|won't|wouldn't)\s+(?:you|u)\b(?!\s+(?:please\s+)?(?:explain|tell|describe|clarify|remind)\b)|please\b)/i;

/** The owner's prompt asks something rather than asks for something done: it ends in "?" or
    opens with a question word, and is not a polite request ("Can you fix…?"). */
export function isQuestion(prompt: string | null | undefined): boolean {
  const text = (prompt ?? '').trim().replace(/^(?:hey|hi|hello|ok|okay|so|and|but|also|btw)\b[\s,!.:-]*/i, '');
  if (text === '' || POLITE_REQUEST.test(text)) return false;
  return /\?[\s)"'`*_]*$/.test(text) || ASKS.test(text);
}

/** A finished session whose last turn answered a question and changed nothing: "Answered", not "Done". */
export const isAnswered = (s: Pick<SessionView, 'state' | 'need' | 'lastPrompt' | 'recentSteps'>): boolean =>
  isDone(s) && isQuestion(s.lastPrompt) && !(s.recentSteps ?? []).some((step) => step.kind === 'edit');

/** What a finished session's state line says: "Answered" for a question, else "Done". */
export const doneLabel = (s: Pick<SessionView, 'state' | 'need' | 'lastPrompt' | 'recentSteps'>): string =>
  isAnswered(s) ? 'Answered' : 'Done';

export const isBlocked = (s: Pick<SessionView, 'state' | 'need'>): boolean => s.state === 'needs_you' && s.need !== 'reply';

/** A session's title as shown everywhere: its name, or "Untitled session". */
export function titleOf(session: Pick<SessionView, 'name'>): string {
  const name = session.name.trim();
  return name === '' ? 'Untitled session' : name;
}

export const requestLabels: Record<NeedKind, string> = {
  permission: 'Approval requested', question: 'Question', reply: 'Done', terminal: 'Terminal prompt', interrupted: 'Interrupted',
};

export function requestDetail(session: SessionView): string {
  if (session.need === 'reply' && session.lastAnswer?.trim()) return session.lastAnswer.trim();
  return session.activity?.trim() ?? '';
}

export function requestedCommand(session: SessionView): string | null {
  const prefix = 'Wants to run: ';
  return session.need === 'permission' && session.activity?.startsWith(prefix)
    ? session.activity.slice(prefix.length).trim() || null : null;
}

/** Markdown flattened to the words it shows: link and image text, code without backticks, no
    emphasis, heading, quote or list marks, all on one line. Cards and the queue show plain text. */
export function plainText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,:;!?]|$)/g, '$1$2')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A tool step's label with an MCP tool's server prefix dropped: "mcp__ccd_turn__update_plan" reads "update plan". */
export function stepLabel(label: string): string {
  return label.replace(/^mcp__.+?__(\S+)/, (_, tool: string) => tool.replace(/_/g, ' '));
}
