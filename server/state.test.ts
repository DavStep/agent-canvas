import { describe, expect, it } from 'vitest';
import type { SubagentView } from '../shared/types.ts';
import type { RawSession } from './adapter/sessionFiles.ts';
import type { TranscriptTail } from './adapter/transcript.ts';
import { ReplyTracker, toView } from './state.ts';

const raw = (patch: Partial<RawSession> = {}): RawSession => ({
  pid: 1, sessionId: 's1', hostSessionId: 'h1', cwd: '/work/alpha', name: 'Name', status: 'busy',
  waitingFor: null, startedAt: 100, statusUpdatedAt: 200, procStart: null, nameSource: null, ...patch,
});
const tail: TranscriptTail = {
  lastPrompt: 'Do it', lastAnswer: 'Done.', branch: 'main', model: 'claude-x', pendingTool: null, lastBlock: 'text',
};
const subs: SubagentView[] = [{ id: 'a1', type: 'Explore', description: 'Look', state: 'working' }];

describe('a session name', () => {
  it("replaces the app's derived placeholder with the transcript's title, else the prompt", () => {
    const derived = raw({ name: 'alpha-d9', nameSource: 'derived' });
    expect(toView(derived, { ...tail, title: 'Chat titles' }, [], false, 'elsewhere').name).toBe('Chat titles');
    expect(toView(derived, tail, [], false, 'elsewhere').name).toBe('Do it');
    expect(toView(derived, null, [], false, 'elsewhere').name).toBe('');
  });
  it('keeps a name the owner gave', () => {
    expect(toView(raw({ name: 'Mine', nameSource: 'user' }), { ...tail, title: 'Other' }, [], false, 'elsewhere').name).toBe('Mine');
  });
});

describe('toView', () => {
  it('treats a detached HEAD as no branch', () => {
    expect(toView(raw(), { ...tail, branch: 'HEAD' }, [], false, 'elsewhere').branch).toBeNull();
    expect(toView(raw(), { ...tail, branch: 'HEADS-up' }, [], false, 'elsewhere').branch).toBe('HEADS-up');
  });
  it('maps busy to working with subagents and copies the session fields', () => {
    expect(toView(raw(), tail, subs, false, 'elsewhere')).toEqual({
      id: 's1', provider: 'claude', hostId: 'h1', name: 'Name', cwd: '/work/alpha', folder: 'alpha', state: 'working', need: null,
      activity: 'Writing a reply', rawStatus: 'busy', stateSince: 200, startedAt: 100, branch: 'main',
      model: 'claude-x', lastPrompt: 'Do it', lastAnswer: 'Done.', subagents: subs, owner: 'elsewhere', ownerNote: null, host: null,
    });
  });
  it('carries the host it is given', () => {
    const host = { app: 'Terminal', tty: 'ttys006', showable: true };
    expect(toView(raw(), tail, [], false, 'elsewhere', host).host).toEqual(host);
  });
  it('a CLI waiting on a dialog in its terminal, with nothing pending in the transcript, needs you "in terminal"', () => {
    const empty: TranscriptTail = { lastPrompt: null, lastAnswer: null, branch: null, model: null, pendingTool: null, lastBlock: null };
    for (const t of [null, empty, tail]) {
      expect(toView(raw({ status: 'waiting', waitingFor: 'dialog open' }), t, [], false, 'elsewhere'))
        .toMatchObject({ state: 'needs_you', need: 'terminal', activity: 'Waiting on a prompt in its terminal' });
    }
    expect(toView(raw({ status: 'waiting', waitingFor: 'Dialog' }), null, [], false, 'elsewhere')).toMatchObject({ need: 'terminal' });
  });
  it('a pending question or tool call in the transcript wins over the dialog', () => {
    const ask: TranscriptTail = { ...tail, pendingTool: { name: 'AskUserQuestion', input: { questions: [{ question: 'Which colour?' }] } } };
    expect(toView(raw({ status: 'waiting', waitingFor: 'dialog open' }), ask, [], false, 'elsewhere'))
      .toMatchObject({ state: 'needs_you', need: 'question', activity: 'Which colour?' });
    const bash: TranscriptTail = { ...tail, pendingTool: { name: 'Bash', input: { command: 'rm -rf build' } } };
    expect(toView(raw({ status: 'waiting', waitingFor: 'dialog open' }), bash, [], false, 'elsewhere'))
      .toMatchObject({ state: 'needs_you', need: 'permission', activity: 'Wants to run: rm -rf build' });
  });
  it('maps shell to working', () => {
    expect(toView(raw({ status: 'shell' }), null, subs, false, 'elsewhere')).toMatchObject({ state: 'working', need: null, subagents: subs });
  });
  it('maps waiting on a permission kind to needs_you/permission', () => {
    for (const waitingFor of ['permission prompt', 'sandbox request', 'worker request']) {
      expect(toView(raw({ status: 'waiting', waitingFor }), tail, subs, false, 'elsewhere'))
        .toMatchObject({ state: 'needs_you', need: 'permission', subagents: [] });
    }
  });
  it('maps other waiting to needs_you/question', () => {
    expect(toView(raw({ status: 'waiting', waitingFor: 'input needed' }), tail, [], false, 'elsewhere'))
      .toMatchObject({ state: 'needs_you', need: 'question', activity: 'Has a question' });
    expect(toView(raw({ status: 'waiting', waitingFor: null }), null, [], false, 'elsewhere')).toMatchObject({ need: 'question' });
  });
  it('maps idle to needs_you/reply when a reply is pending, else idle', () => {
    expect(toView(raw({ status: 'idle' }), tail, subs, true, 'elsewhere'))
      .toMatchObject({ state: 'needs_you', need: 'reply', activity: 'Done.', subagents: [] });
    expect(toView(raw({ status: 'idle' }), tail, subs, false, 'elsewhere'))
      .toMatchObject({ state: 'idle', need: null, activity: null, subagents: [] });
  });
  it('maps any other status to unknown', () => {
    expect(toView(raw({ status: 'compacting' }), tail, subs, true, 'elsewhere'))
      .toMatchObject({ state: 'unknown', need: null, activity: null, rawStatus: 'compacting', subagents: [] });
  });
  it('fills tail fields with null when there is no tail', () => {
    expect(toView(raw({ status: 'idle' }), null, [], false, 'elsewhere'))
      .toMatchObject({ branch: null, model: null, lastPrompt: null, lastAnswer: null });
  });
});

describe('ReplyTracker', () => {
  it('does not mark a session first seen idle', () => {
    const t = new ReplyTracker();
    t.observe('a', 'idle', 1);
    expect(t.needsReply('a')).toBe(false);
  });
  it('marks busy then idle, and also shell or waiting then idle', () => {
    const t = new ReplyTracker();
    for (const [id, status] of [['a', 'busy'], ['b', 'shell'], ['c', 'waiting']] as const) {
      t.observe(id, status, 1);
      t.observe(id, 'idle', 2);
      expect(t.needsReply(id)).toBe(true);
    }
    expect(t.toJSON()).toEqual({ a: 2, b: 2, c: 2 });
  });
  it('keeps the time it became pending across further idle polls', () => {
    const t = new ReplyTracker();
    t.observe('a', 'busy', 1);
    t.observe('a', 'idle', 2);
    t.observe('a', 'idle', 3);
    expect(t.toJSON()).toEqual({ a: 2 });
  });
  it('clears a pending session when it goes non-idle', () => {
    const t = new ReplyTracker();
    t.observe('a', 'busy', 1);
    t.observe('a', 'idle', 2);
    t.observe('a', 'busy', 3);
    expect(t.needsReply('a')).toBe(false);
    expect(t.toJSON()).toEqual({});
  });
  it('markSeen clears the given ids, or all', () => {
    const t = new ReplyTracker({ a: 1, b: 1, c: 1 });
    t.markSeen(['a']);
    expect(t.toJSON()).toEqual({ b: 1, c: 1 });
    t.markSeen('all');
    expect(t.toJSON()).toEqual({});
  });
  it('restores pending entries and keeps them through a first idle observation', () => {
    const t = new ReplyTracker({ a: 5 });
    t.observe('a', 'idle', 9);
    expect(t.needsReply('a')).toBe(true);
    expect(t.toJSON()).toEqual({ a: 5 });
  });
  it('forget drops entries for sessions that are not live', () => {
    const t = new ReplyTracker({ a: 1, b: 1 });
    t.observe('c', 'busy', 1);
    t.forget(['a']);
    expect(t.toJSON()).toEqual({ a: 1 });
    t.observe('c', 'idle', 2);
    expect(t.needsReply('c')).toBe(false); // its earlier busy was forgotten
  });
});
