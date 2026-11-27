import { describe, expect, it } from 'vitest';
import { session } from '../testSession.ts';
import {
  AGENT_PANEL, AGENT_PROMPTS, afterClose, afterStart, agentBlocked, agentChatId, agentMeta, isAgentShortcut, newConversation, orbState,
} from './agent.ts';

describe('orbState', () => {
  it('is quiet before the first message and while the agent rests', () => {
    expect(orbState(null)).toMatchObject({ kind: 'idle', label: 'Agent', name: 'Canvas agent' });
    expect(orbState(undefined).kind).toBe('idle');
    expect(orbState(session({ id: 'a', state: 'idle' })).kind).toBe('idle');
    expect(orbState(session({ id: 'a', state: 'unknown' })).kind).toBe('idle');
  });

  it('says working, and names the state for a screen reader', () => {
    expect(orbState(session({ id: 'a', state: 'working' }))).toEqual({ kind: 'working', label: 'Working', name: 'Canvas agent, working' });
  });

  it('is amber only when stopped on the owner; a finished answer is "Replied"', () => {
    for (const need of ['permission', 'question', 'terminal'] as const) {
      expect(orbState(session({ id: 'a', state: 'needs_you', need }))).toEqual({ kind: 'needs', label: 'Needs you', name: 'Canvas agent, needs you' });
    }
    expect(orbState(session({ id: 'a', state: 'needs_you', need: 'reply' }))).toEqual({ kind: 'done', label: 'Replied', name: 'Canvas agent, replied' });
  });

  it('shows nothing live while the reader is unreachable', () => {
    expect(orbState(session({ id: 'a', state: 'working' }), false).kind).toBe('idle');
  });
});

describe('agentChatId', () => {
  it('is the empty state until the agent has a session', () => {
    expect(agentChatId(AGENT_PANEL, null)).toBeNull();
    expect(agentChatId(AGENT_PANEL, undefined)).toBeNull();
  });

  it("shows the snapshot's conversation, and the one a first message just started before the snapshot has it", () => {
    expect(agentChatId(AGENT_PANEL, { id: 'agent-1' })).toBe('agent-1');
    expect(agentChatId(afterStart('agent-2'), null)).toBe('agent-2');
    // The snapshot still names the conversation before: the one just started wins.
    expect(agentChatId(afterStart('agent-2'), { id: 'agent-1' })).toBe('agent-2');
  });

  it('"New conversation" returns to the empty state; closing the panel without sending forgets it', () => {
    const fresh = newConversation();
    expect(agentChatId(fresh, { id: 'agent-1' })).toBeNull();
    expect(agentChatId(afterClose(fresh), { id: 'agent-1' })).toBe('agent-1');
    const started = afterStart('agent-2');
    expect(afterClose(started)).toBe(started);
  });
});

describe('agentBlocked', () => {
  it('blocks nothing while asking or when the agent can run', () => {
    expect(agentBlocked(null)).toBeNull();
    expect(agentBlocked({ connection: 'claude-login', available: true, reason: null })).toBeNull();
  });

  it('gives the reason the agent cannot run, or a plain one when none came', () => {
    expect(agentBlocked({ connection: 'claude-login', available: false, reason: 'Claude Code is signed out on this Mac.' })).toBe('Claude Code is signed out on this Mac.');
    expect(agentBlocked({ connection: 'claude-login', available: false, reason: null })).toBe('The canvas agent is not available right now.');
  });
});

describe('agentMeta', () => {
  it('names the connection', () => {
    expect(agentMeta(null)).toEqual([]);
    expect(agentMeta({ connection: 'claude-login', available: true, reason: null })).toEqual(['Claude Code login']);
    expect(agentMeta({ connection: 'codex-api', available: true, reason: null }, 'claude-api')).toEqual(['Claude API']);
  });
});

describe('the examples and the shortcut', () => {
  it('offers three or four prompts, each with text for the message field', () => {
    expect(AGENT_PROMPTS.length).toBeGreaterThanOrEqual(3);
    expect(AGENT_PROMPTS.length).toBeLessThanOrEqual(4);
    for (const p of AGENT_PROMPTS) expect(p.text.trim()).not.toBe('');
  });

  it('⌘J alone is the shortcut', () => {
    const key = { key: 'j', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(isAgentShortcut(key)).toBe(true);
    expect(isAgentShortcut({ ...key, key: 'J' })).toBe(true);
    expect(isAgentShortcut({ ...key, shiftKey: true })).toBe(false);
    expect(isAgentShortcut({ ...key, metaKey: false })).toBe(false);
    expect(isAgentShortcut({ ...key, key: 'k' })).toBe(false);
  });
});
