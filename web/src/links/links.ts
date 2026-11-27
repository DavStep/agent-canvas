// The canvas's view of links between sessions (shared/runs.ts): what each waiting card says,
// the planned cards to draw, the lines to draw and their style, and the curve each line takes.
// Pure, so it is tested without a page. Connectors.tsx draws it; docs/links.md describes it.
import { isPlanId, type RunView } from '../../../shared/runs.ts';
import type { SessionView } from '../../../shared/types.ts';
import { projectDraftId } from '../agent/agent.ts';

/** What a waiting card shows: its reason ("Waiting for Fix login"), the queued prompt on hover. */
export interface CardWait {
  runId: string;
  status: RunView['status'];
  reason: string;
  prompt: string;
  blocked: boolean;
}

/** The cards that wait, by card id. Sent runs are not waits any more. */
export function cardWaits(runs: readonly RunView[] | undefined): Map<string, CardWait> {
  const out = new Map<string, CardWait>();
  for (const r of runs ?? []) {
    if (r.status === 'started' || r.node === null) continue;
    out.set(r.node, { runId: r.id, status: r.status, reason: r.reason, prompt: r.prompt, blocked: r.status === 'blocked' });
  }
  return out;
}

/** A planned session's name on its card: its title, else its prompt's first line. */
export function plannedName(run: RunView): string {
  if (run.target.kind === 'new' && run.target.title) return run.target.title;
  const line = run.prompt.split('\n', 1)[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || 'Planned session';
}

/** Cards for planned sessions not started yet, drawn in their folder's zone. */
export function plannedCards(runs: readonly RunView[] | undefined): SessionView[] {
  return (runs ?? []).filter((r) => r.target.kind === 'new' && r.status !== 'started' && r.node !== null).map((r) => {
    const t = r.target as Extract<RunView['target'], { kind: 'new' }>;
    return {
      id: r.node!, provider: t.provider, hostId: null, name: plannedName(r), cwd: t.cwd, folder: r.folder,
      state: 'idle', need: null, activity: null, rawStatus: 'planned', stateSince: r.createdAt, startedAt: r.createdAt,
      branch: null, model: t.model, lastPrompt: r.prompt, lastAnswer: null, subagents: [], owner: 'nobody', ownerNote: null, host: null,
    };
  });
}

export const isPlanned = (id: string): boolean => isPlanId(id);

/** A line's look: dashed while it waits (flowing while its upstream works), solid once done, red when blocked. */
export type LineState = 'working' | 'pending' | 'done' | 'started' | 'blocked';

export interface Line {
  key: string;
  runId: string;
  from: string;
  /** The card the line ends on, as drawn (a handoff with no orchestrator yet: its zone's placeholder). */
  to: string;
  state: LineState;
}

/** Every line to draw, one per upstream of each run. */
export function linesOf(runs: readonly RunView[] | undefined): Line[] {
  const out: Line[] = [];
  for (const r of runs ?? []) {
    const to = r.node ?? (r.target.kind === 'handoff' ? projectDraftId(`folder:${r.folder}`) : null);
    if (to === null) continue;
    const failed = r.status === 'blocked' && !r.edges.some((e) => e.state === 'interrupted');
    for (const e of r.edges) {
      const state: LineState = r.status === 'started' ? 'started'
        : failed || e.state === 'interrupted' ? 'blocked'
          : e.state;
      out.push({ key: `${r.id}:${e.from}`, runId: r.id, from: e.from, to, state });
    }
  }
  return out;
}

export interface Box { x: number; y: number; width: number; height: number }
export interface Pt { x: number; y: number }

/** Where a line leaves A and enters B, and the cubic curve between them: sideways when the cards
    are side by side, down when one is above the other; the bend grows with the distance. */
export function curve(a: Box, b: Box): { start: Pt; end: Pt; c1: Pt; c2: Pt; d: string; mid: Pt; arrow: string } {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  // Side by side when they do not overlap across; else above and below.
  const apartX = dx > 0 ? b.x - (a.x + a.width) : a.x - (b.x + b.width);
  const sideways = apartX > 16 || Math.abs(dx) > Math.abs(dy) * 1.2;
  let start: Pt; let end: Pt; let n1: Pt; let n2: Pt;
  if (sideways) {
    const right = dx >= 0;
    start = { x: right ? a.x + a.width : a.x, y: ac.y };
    end = { x: right ? b.x : b.x + b.width, y: bc.y };
    n1 = { x: right ? 1 : -1, y: 0 };
    n2 = { x: right ? -1 : 1, y: 0 };
  } else {
    const down = dy >= 0;
    start = { x: ac.x, y: down ? a.y + a.height : a.y };
    end = { x: bc.x, y: down ? b.y : b.y + b.height };
    n1 = { x: 0, y: down ? 1 : -1 };
    n2 = { x: 0, y: down ? -1 : 1 };
  }
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  const bend = Math.max(36, Math.min(180, dist * 0.45));
  const c1 = { x: start.x + n1.x * bend, y: start.y + n1.y * bend };
  const c2 = { x: end.x + n2.x * bend, y: end.y + n2.y * bend };
  // The arrow's tip sits on B's edge; the line stops at its base.
  const ARROW = 7;
  const ux = -n2.x; const uy = -n2.y; // the direction the line arrives in
  const base = { x: end.x - ux * ARROW, y: end.y - uy * ARROW };
  const arrow = `M${end.x} ${end.y}L${base.x - uy * 4.5} ${base.y + ux * 4.5}L${base.x + uy * 4.5} ${base.y - ux * 4.5}Z`;
  const r = (n: number) => Math.round(n * 10) / 10;
  const d = `M${r(start.x)} ${r(start.y)}C${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(base.x)} ${r(base.y)}`;
  const mid = {
    x: 0.125 * start.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * base.x,
    y: 0.125 * start.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * base.y,
  };
  return { start, end, c1, c2, d, mid, arrow };
}
