// The demo's open threads: two questions left in demo sessions (server/demo.ts), so the board's
// Open threads area has something to show and the e2e test something to drag.
import type { OpenThread } from '../../shared/threads.ts';

const HOME = '/Users/demo/Documents';
const MIN = 60_000;

export function demoThreads(now: number): OpenThread[] {
  return [
    {
      id: 'demo-thread-events',
      title: 'Timed events for the miner',
      summary: 'Four event ideas were laid out: Tile Rush, Gem Hunt, Stack Race and Swap Duel.\nStack Race was recommended first, since it reuses the move counter and needs no new art.',
      question: 'Should events be gated by location or by Coins, and should they start with bots or real players?',
      sessionId: 'demo-preview',
      sessionName: 'Preview improvement suggestions',
      provider: 'claude',
      cwd: `${HOME}/garden-sim`,
      folder: 'garden-sim',
      askedAt: now - 26 * 60 * MIN,
      foundAt: now - 25 * 60 * MIN,
      excerpt: 'My pick is Stack Race: it reuses the move counter, needs no new art, and a weekly leaderboard keeps it fresh.\n\nTo take this further: should events be gated by location or by Coins, and do you want bots or real players to start with?',
      state: 'open',
    },
    {
      id: 'demo-thread-rollback',
      title: 'Rollback step for deploys',
      summary: 'The deploy script has no way back when a release fails its health check.\nA rollback step that redeploys the previous tag was proposed.',
      question: 'Want the rollback to run by itself on a failed health check, or only when asked?',
      sessionId: 'demo-deploy',
      sessionName: 'Deploy changes',
      provider: 'claude',
      cwd: `${HOME}/sailcloth-io`,
      folder: 'sailcloth-io',
      askedAt: now - 3 * 60 * MIN,
      foundAt: now - 2 * 60 * MIN,
      excerpt: 'A rollback step would redeploy the previous tag and post to the channel.\n\nWant the rollback to run by itself on a failed health check, or only when asked?',
      state: 'open',
    },
  ];
}
