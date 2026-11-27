import { describe, expect, it } from 'vitest';
import { ACP_PRESETS, acpAgentConfig, acpAgentList, acpAgentProblem, isNativeAdapter, showsInNewSession, type AcpAgentConfig } from './acp.ts';

const agent = (over: Partial<AcpAgentConfig> = {}): AcpAgentConfig =>
  ({ id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--acp'], env: {}, icon: 'agent', ...over });

describe('which ACP agents New session shows', () => {
  it('hides the Claude and Codex adapters by default (presets, or any agent running their programs), shows the rest', () => {
    const preset = (id: string) => ACP_PRESETS.find((p) => p.id === id)!;
    expect(showsInNewSession(preset('gemini'))).toBe(true);
    expect(showsInNewSession(preset('claude-acp'))).toBe(false);
    expect(showsInNewSession(preset('codex-acp'))).toBe(false);
    expect(isNativeAdapter(agent({ id: 'my-claude', command: '/opt/homebrew/bin/claude-agent-acp' }))).toBe(true);
    expect(isNativeAdapter(agent({ id: 'mine', command: 'codex-acp' }))).toBe(true);
    expect(isNativeAdapter(agent({ id: 'goose', command: 'goose' }))).toBe(false);
    expect(showsInNewSession(agent({ id: 'goose', command: 'goose' }))).toBe(true);
  });

  it("the owner's choice wins either way, and is kept and checked like the rest of the config", () => {
    expect(showsInNewSession({ ...ACP_PRESETS[1]!, showInNewSession: true })).toBe(true);
    expect(showsInNewSession(agent({ showInNewSession: false }))).toBe(false);
    expect(acpAgentConfig(agent({ showInNewSession: true }))).toMatchObject({ showInNewSession: true });
    expect(acpAgentConfig(agent())).not.toHaveProperty('showInNewSession');
    expect(acpAgentProblem({ ...agent(), showInNewSession: 'yes' })).toMatch(/visibility/);
    expect(acpAgentList([agent({ showInNewSession: false })])[0]).toMatchObject({ showInNewSession: false });
  });
});
