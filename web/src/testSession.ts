// Test helper: a SessionView with sensible defaults.
import type { SessionView } from '../../shared/types.ts';

export function session(patch: Partial<SessionView> & { id: string }): SessionView {
  return {
    provider: 'claude', hostId: null, name: patch.id, cwd: '/work/a', folder: 'a', state: 'idle', need: null,
    activity: null, rawStatus: 'idle', stateSince: 0, startedAt: 0, branch: 'main', model: null,
    lastPrompt: null, lastAnswer: null, subagents: [], owner: 'nobody', ownerNote: null, host: null,
    ...patch,
  };
}
