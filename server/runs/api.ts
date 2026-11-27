// What the agents' tools (server/agent/linkTools.ts, project.ts) need of the run queue. Main
// implements it over the RunStore and the scheduler's views.
import type { QueuedRun, RunBy, RunOp, RunView } from '../../shared/runs.ts';
import type { RunDraft } from './store.ts';

export interface RunsApi {
  /** Every run as the canvas shows it, with its status and reason. */
  views(): RunView[];
  maxRunning(): Readonly<Record<string, number>>;
  /** A change, as the page makes them; throws a RunError with a sentence when it cannot be done. */
  apply(op: RunOp, by: RunBy): QueuedRun | null;
  /** A planned session, a handoff, or a prompt for a session; throws a RunError. */
  queue(draft: RunDraft): QueuedRun;
}
