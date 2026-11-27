// Card order: needs-you first (permission, question, reply), then working, idle, unknown;
// within each, the most recent first (the latest state change, then the latest start), so the
// oldest sit at the bottom.
import type { SessionView } from '../../shared/types.ts';

function rank(s: SessionView): number {
  switch (s.state) {
    case 'needs_you': return s.need === 'permission' ? 0 : s.need === 'question' ? 1 : 2;
    case 'working': return 3;
    case 'idle': return 4;
    default: return 5;
  }
}

export function sortCards(sessions: SessionView[]): SessionView[] {
  return [...sessions].sort((a, b) =>
    rank(a) - rank(b) || b.stateSince - a.stateSince || b.startedAt - a.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
