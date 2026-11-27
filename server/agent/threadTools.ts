// The canvas agent's view of the open threads (server/threads): the questions the owner left in
// chats they moved on from, as the board's Open threads area shows them. It can list them and
// close one (done or dismissed); it cannot make them, the detector does.
import { z } from 'zod';
import type { OpenThread, ThreadOp } from '../../shared/threads.ts';
import { ago, type CanvasApi, type CanvasTool, type define as Define } from './tools.ts';

/** What the thread tools need of the app; main.ts sets it over the thread store. */
export interface ThreadsApi {
  /** Open threads, newest question first. */
  list(): OpenThread[];
  /** Dismiss (never made again) or done; false when no such open thread is kept. */
  apply(op: ThreadOp): boolean;
}

const fact = (t: OpenThread, now: number) => ({
  id: t.id,
  title: t.title,
  summary: t.summary,
  question: t.question,
  project: t.cwd || '(none)',
  session: { id: t.sessionId, name: t.sessionName || '(untitled)', provider: t.provider },
  asked: `${ago(t.askedAt, now)} ago`,
});

export function threadTools(define: typeof Define): CanvasTool[] {
  const api = (a: CanvasApi): ThreadsApi | null => a.threads ?? null;
  return [
    define({
      name: 'list_open_threads',
      description: 'The open threads on the board: questions or proposals the owner discussed in a chat (a Claude session, a Codex chat or this one) and never came back to, each with a title, a short summary, the question still waiting, its project folder and the session it came from. Read-only.',
      shape: {},
      safe: true, readOnly: true,
      handler: async (a) => {
        const threads = api(a);
        if (!threads) return { text: 'Open threads are not available in this app.', isError: true };
        const open = threads.list();
        if (open.length === 0) return { text: 'No open threads.', isError: false };
        return { text: JSON.stringify(open.map((t) => fact(t, a.now())), null, 2), isError: false };
      },
    }),
    define({
      name: 'dismiss_open_thread',
      description: 'Closes an open thread on the board. reason "done" when it has been dealt with (it was answered, or the work started), "dismiss" when the owner does not want it (it is never made again). The owner can undo either from the board.',
      shape: {
        id: z.string().describe('The thread id from list_open_threads'),
        reason: z.enum(['done', 'dismiss']).optional().describe('done (default) or dismiss'),
      },
      safe: false,
      handler: async (a, { id, reason }) => {
        const threads = api(a);
        if (!threads) return { text: 'Open threads are not available in this app.', isError: true };
        const thread = threads.list().find((t) => t.id === id);
        if (!thread) return { text: `No open thread has the id ${id}. list_open_threads lists them.`, isError: true };
        threads.apply({ type: reason === 'dismiss' ? 'dismiss' : 'done', id });
        return { text: `${reason === 'dismiss' ? 'Dismissed' : 'Marked done'}: ${thread.title}.`, isError: false };
      },
    }),
  ];
}
