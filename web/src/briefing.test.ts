import { describe, expect, it } from 'vitest';
import { doneLabel, isAnswered, isBlocked, isDone, isQuestion, needLabel, plainText, requestDetail, requestedCommand, stepLabel, titleOf } from './briefing.ts';
import { session } from './testSession.ts';

describe('session request labels', () => {
  it('uses the full latest answer for a reply and the current activity for other requests', () => {
    const s = session({ id: 'a', need: 'reply', activity: 'Summary', lastAnswer: 'Full reply' });
    expect(requestDetail(s)).toBe('Full reply');
    expect(requestDetail({ ...s, need: 'question' })).toBe('Summary');
  });

  it('formats only an explicit command request as code', () => {
    const s = session({ id: 'a', need: 'permission', activity: 'Wants to run: npm test' });
    expect(requestedCommand(s)).toBe('npm test');
    expect(requestedCommand({ ...s, need: 'reply' })).toBeNull();
  });

  it('names an untitled chat and distinguishes terminal prompts', () => {
    expect(titleOf({ name: '  ' })).toBe('Untitled session');
    expect(needLabel('terminal')).toBe('in terminal');
  });
});

describe('plain text', () => {
  it('flattens markdown to the words it shows', () => {
    expect(plainText('Pushed to [DavStep/agent-canvas](https://github.com/DavStep/agent-canvas) as `f673eee`. **All** pass.'))
      .toBe('Pushed to DavStep/agent-canvas as f673eee. All pass.');
    expect(plainText('## Done\n\n- one\n- two\n> quoted')).toBe('Done one two quoted');
    expect(plainText('keep snake_case and 2*3*4')).toBe('keep snake_case and 2*3*4');
  });

  it('drops an MCP tool\'s server prefix from a step label', () => {
    expect(stepLabel('mcp__ccd_turn__update_plan')).toBe('update plan');
    expect(stepLabel('Bash npm test')).toBe('Bash npm test');
  });
});

describe('isDone / isBlocked', () => {
  it('tells finished work (clears on open) from a request that waits on the owner', () => {
    expect(isDone({ state: 'needs_you', need: 'reply' })).toBe(true);
    expect(isBlocked({ state: 'needs_you', need: 'reply' })).toBe(false);
    for (const need of ['permission', 'question', 'terminal'] as const) {
      expect(isDone({ state: 'needs_you', need })).toBe(false);
      expect(isBlocked({ state: 'needs_you', need })).toBe(true);
    }
    expect(isDone({ state: 'idle', need: null })).toBe(false);
    expect(isBlocked({ state: 'working', need: null })).toBe(false);
  });

  it('labels a finished session "done" in the rail', () => {
    expect(needLabel('reply')).toBe('done');
  });
});

describe('answered or done', () => {
  it('tells a question from a request for work', () => {
    expect(isQuestion('whe do x2 stone and x2 hot and auto ad offers apepar?')).toBe(true);
    expect(isQuestion('how does the reader pick a zone')).toBe(true);
    expect(isQuestion('Explain the drag code')).toBe(true);
    expect(isQuestion('ok, why is the card green? ')).toBe(true);
    expect(isQuestion('Can you explain the drag code?')).toBe(true);
    expect(isQuestion('Fix the failing test')).toBe(false);
    expect(isQuestion('Can you fix the failing test?')).toBe(false);
    expect(isQuestion('please add a dark mode?')).toBe(false);
    expect(isQuestion(null)).toBe(false);
  });

  it('says Answered for a finished question that edited nothing, else Done', () => {
    const s = session({ id: 'a', state: 'needs_you', need: 'reply', lastPrompt: 'where do the ad offers appear?' });
    expect(isAnswered(s)).toBe(true);
    expect(doneLabel(s)).toBe('Answered');
    expect(doneLabel({ ...s, lastPrompt: 'Move the ad offers up' })).toBe('Done');
    expect(doneLabel({ ...s, recentSteps: [{ kind: 'edit', label: 'Edit Mine.tsx', status: 'done' }] })).toBe('Done');
    expect(isAnswered({ ...s, need: 'question' })).toBe(false);
  });
});
