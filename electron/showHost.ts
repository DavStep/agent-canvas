// "Show in Terminal": brings the app a Claude session owned elsewhere runs in to the front. The
// page names the card only; main takes the session's pid from its own last poll, walks a fresh
// `ps` table up to a terminal or editor it knows, and opens that app's bundle. Nothing the page
// sends is ever opened, and nothing of the other app's is read.
import { hostOf, type ProcInfo } from '../server/engines/host.ts';
import { validate } from './ipc.ts';

export interface ShowHostDeps {
  /** The pid of the live Claude session another program runs for a card, or null. */
  pidOf(cardId: string): number | null;
  /** The running processes, read afresh. */
  processes(pids: number[]): Promise<Map<number, ProcInfo>>;
  /** Brings an app (an absolute `.app` folder) to the front. */
  open(bundle: string): Promise<void>;
}

export async function showHost(args: unknown[], deps: ShowHostDeps): Promise<void> {
  const cardId = validate.showHost(args);
  const pid = deps.pidOf(cardId);
  if (pid === null) throw new Error('This session is not running in another app');
  const found = hostOf(pid, await deps.processes([pid]));
  if (!found?.bundle) throw new Error('Could not tell which app this session runs in');
  await deps.open(validate.appBundle(found.bundle));
}
