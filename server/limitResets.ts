// Watches usage limits that cut turns off, and acts once each one resets: one macOS notification
// for the sessions it freed ("Usage limit reset: 2 sessions can continue"), and, when the owner
// chose "Continue cut-off sessions automatically", a queued Continue for each. The queue (server/
// runs) sends them as its project's max running allows, through the chat's ordinary send, so each
// keeps its own model and permission mode. Only a limit seen still holding while the app ran
// counts: one that reset before it opened shows "Ready to continue" without a notification.
import { continuePrompt, isInterrupted, limitActive, limitReady } from '../shared/interruption.ts';
import type { SessionView } from '../shared/types.ts';
import type { RunDraft } from './runs/store.ts';

export type LimitResetChoice = 'ask' | 'continue';

export interface LimitResetDeps {
  /** One notification for the sessions a reset freed. */
  notify(count: number, sessionIds: string[]): void;
  /** The owner's setting: Ask (default), or continue cut-off sessions automatically. */
  choice(): LimitResetChoice;
  /** The run queue (RunStore.queue): Continue waits there for room in its project. */
  queue(draft: RunDraft): unknown;
  now?(): number;
}

/** The notification's words. */
export const resetNotice = (count: number): { title: string; body: string } => ({
  title: `Usage limit reset: ${count === 1 ? '1 session' : `${count} sessions`} can continue`,
  body: count === 1 ? 'Open Agent canvas to continue it.' : 'Open Agent canvas to continue them.',
});

export class LimitResets {
  private readonly now: () => number;
  /** Limits seen still holding (session id → its interruption's `at`). */
  private readonly held = new Map<string, number>();
  /** Resets already told (`id@at`), so each one notifies and continues once. */
  private readonly told = new Set<string>();

  constructor(private readonly deps: LimitResetDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Called with the cards (and the canvas agent's conversation) on every change. `sessions`:
   * the canvas's cards, the only ones the queue can continue. Returns the ids that just reset.
   */
  update(sessions: readonly SessionView[], agent: SessionView | null = null): string[] {
    const now = this.now();
    const all = agent ? [...sessions, agent] : [...sessions];
    const freed: SessionView[] = [];
    const still = new Set<string>();
    for (const v of all) {
      const i = v.interruption;
      if (!i || i.kind !== 'limit' || !isInterrupted(v)) continue;
      const key = `${v.id}@${i.at}`;
      if (limitActive(i, now)) {
        this.held.set(v.id, i.at);
        still.add(v.id);
      } else if (limitReady(i, now) && this.held.get(v.id) === i.at && !this.told.has(key)) {
        this.told.add(key);
        freed.push(v);
      }
    }
    // Continued by hand, aborted, or gone: nothing to tell when it would have reset.
    for (const id of [...this.held.keys()]) if (!still.has(id)) this.held.delete(id);
    if (freed.length === 0) return [];
    this.deps.notify(freed.length, freed.map((v) => v.id));
    if (this.deps.choice() === 'continue') {
      const cards = new Set(sessions.map((s) => s.id));
      for (const v of freed) {
        // The agent's conversation is no card the queue can send to; a session another app holds
        // waits for the owner there.
        if (!cards.has(v.id) || v.owner === 'elsewhere') continue;
        try {
          this.deps.queue({ target: { kind: 'session', id: v.id }, after: [], prompt: continuePrompt(v.interruption!), by: 'owner' });
        } catch (err) {
          // Already queued (a run waits for it): that run continues it.
          process.stderr.write(`agent-canvas: could not queue Continue for ${v.id}: ${(err as Error).message}\n`);
        }
      }
    }
    return freed.map((v) => v.id);
  }
}
