// What the canvas reads from: the live Store or the demo source.
import type { LayoutOp, Snapshot } from '../shared/types.ts';

export interface Source {
  snapshot(): Snapshot;
  onChange(cb: () => void): () => void;
  applyLayout(op: LayoutOp): void;
  markSeen(ids: string[] | 'all'): void;
  /** Abort on an interrupted session: back to a normal card; `undo` brings the interruption back. */
  dismissInterruption(id: string, undo?: boolean): void;
}
