// Quitting: Cmd+Q, the menu's Quit and the Dock's Quit all come here. The canvas only shows the
// sessions, so a quit never cuts one short: with nothing busy the app stops its engines and
// exits; with a turn running or an approval or question waiting, the window and Dock icon go away
// and the app keeps running unseen until every session has finished, then exits by itself.
// Opening the app again in the meantime brings it back as it was. A signal or the Mac shutting
// down stops everything at once. Electron-free, so it is tested directly.

export interface BusySession {
  title: string;
  reason: 'turn' | 'approval' | 'question';
}

export interface QuitDeps {
  /** The sessions still busy, with their card titles. */
  busy(): BusySession[];
  /** Hides the window and the Dock icon; the app keeps running. */
  hide(): void;
  /** Brings the Dock icon and the window back. */
  show(): void;
  /** Tells the owner, unseen, that a session finishing in the background now waits for them. */
  notify(waiting: BusySession): void;
  /** Sets every engine stopping and waits for them (and the reader) to finish. */
  stop(): Promise<void>;
  exit(): void;
}

/** A stop that hangs must not keep the app from quitting. */
const STOP_TIMEOUT_MS = 10_000;
/** How often the background finish looks for sessions still busy. */
const CHECK_MS = 1_000;

export type QuitPhase = 'idle' | 'finishing' | 'stopping';

export class QuitFlow {
  private state: QuitPhase = 'idle';
  private stopping: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Waiting sessions already told of, so each wait notifies once. */
  private told = new Set<string>();
  private readonly stopTimeoutMs: number;
  private readonly checkMs: number;

  constructor(private readonly deps: QuitDeps, opts: { stopTimeoutMs?: number; checkMs?: number } = {}) {
    this.stopTimeoutMs = opts.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    this.checkMs = opts.checkMs ?? CHECK_MS;
  }

  get phase(): QuitPhase {
    return this.state;
  }

  /** A quit was asked for. Busy sessions are left to finish in the background; `force` (a signal,
      the Mac shutting down) stops them at once. A request while stopping joins it. */
  request(opts: { force?: boolean } = {}): Promise<void> {
    if (this.stopping) return this.stopping;
    if (opts.force === true) return this.quit();
    if (this.state === 'finishing') return Promise.resolve();
    if (this.deps.busy().length === 0) return this.quit();
    this.state = 'finishing';
    this.told.clear();
    this.deps.hide();
    this.check();
    return Promise.resolve();
  }

  /** The owner opened the app again while it was finishing: it stays, as it was. */
  reopened(): void {
    if (this.state !== 'finishing') return;
    this.state = 'idle';
    this.clearTimer();
    this.deps.show();
  }

  private check(): void {
    this.timer = null;
    if (this.state !== 'finishing') return;
    const busy = this.deps.busy();
    if (busy.length === 0) {
      void this.quit();
      return;
    }
    const waiting = new Set<string>();
    for (const b of busy) {
      if (b.reason === 'turn') continue;
      const key = `${b.title}\u0000${b.reason}`;
      waiting.add(key);
      if (!this.told.has(key)) this.deps.notify(b);
    }
    this.told = waiting;
    this.timer = setTimeout(() => this.check(), this.checkMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private quit(): Promise<void> {
    this.clearTimer();
    this.state = 'stopping';
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.stopTimeoutMs); });
    this.stopping = Promise.race([Promise.resolve().then(() => this.deps.stop()).catch(() => {}), timeout])
      .finally(() => {
        clearTimeout(timer);
        this.deps.exit();
      });
    return this.stopping;
  }
}
