import { describe, expect, it } from 'vitest';
import { resumeCommand, shellQuote } from './resume.ts';

describe('resumeCommand', () => {
  it('leaves safe paths bare', () => {
    expect(resumeCommand({ provider: 'claude', hostId: null, cwd: '/Users/demo/Documents/garden-sim', id: 'abc-123' }))
      .toBe('cd /Users/demo/Documents/garden-sim && claude --resume abc-123');
  });

  it('single-quotes paths with spaces, quotes and shell characters', () => {
    expect(shellQuote("/Users/demo/My Project's $HOME")).toBe(`'/Users/demo/My Project'\\''s $HOME'`);
    expect(shellQuote('')).toBe(`''`);
    expect(resumeCommand({ provider: 'claude', hostId: null, cwd: '/tmp/a b', id: 'x;rm -rf ~' }))
      .toBe(`cd '/tmp/a b' && claude --resume 'x;rm -rf ~'`);
  });

  it('resumes the Codex thread by its native ID', () => {
    expect(resumeCommand({ provider: 'codex', hostId: 'abc-123', cwd: '/tmp/a b', id: 'codex:abc-123' }))
      .toBe("cd '/tmp/a b' && codex resume abc-123");
  });
});
