import { describe, expect, it } from 'vitest';
import { executableOptions, queryOptions, realMcp, unpackedPath } from './sdk.ts';

const PACKED = '/Applications/Agent canvas.app/Contents/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude';
const UNPACKED = '/Applications/Agent canvas.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude';

describe('the bundled Claude Code binary in a packaged app', () => {
  it('a path inside app.asar points at the same file in app.asar.unpacked', () => {
    expect(unpackedPath(PACKED)).toBe(UNPACKED);
  });

  it('a path already unpacked, or outside any asar (npm run app, tests), is left to the SDK', () => {
    expect(unpackedPath(UNPACKED)).toBeNull();
    expect(unpackedPath('/repo/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')).toBeNull();
    expect(unpackedPath(null)).toBeNull();
  });

  it('options: pathToClaudeCodeExecutable (and the delivery the SDK uses by default) only when packed', () => {
    expect(executableOptions(PACKED)).toEqual({ pathToClaudeCodeExecutable: UNPACKED, mcpServersDelivery: 'argv' });
    expect(executableOptions('/repo/node_modules/x/claude')).toEqual({});
    expect(executableOptions(null)).toEqual({});
  });
});

describe('queryOptions', () => {
  const exe = executableOptions(PACKED);

  it('a packaged query runs the unpacked binary with the default delivery', () => {
    expect(queryOptions({ cwd: '/work' }, exe)).toEqual({ cwd: '/work', pathToClaudeCodeExecutable: UNPACKED, mcpServersDelivery: 'argv' });
    expect(queryOptions({ cwd: '/work' }, {})).toEqual({ cwd: '/work' });
  });

  it("a caller's own delivery is kept (the agent's headers stay off the command line), the binary is not", () => {
    expect(queryOptions({ cwd: '/work', mcpServersDelivery: 'initialize', pathToClaudeCodeExecutable: '/other/claude' }, exe))
      .toEqual({ cwd: '/work', pathToClaudeCodeExecutable: UNPACKED, mcpServersDelivery: 'initialize' });
    expect(queryOptions({ mcpServersDelivery: 'initialize' }, {})).toEqual({ mcpServersDelivery: 'initialize' });
  });
});

describe('realMcp', () => {
  it('builds an in-process server under the given name, with no tool forced to ask (they follow the mode)', () => {
    const tool = { name: 'ping', description: 'Answers pong', shape: {}, handler: async () => ({ text: 'pong', isError: false }) };
    const server = realMcp.server('canvas', [tool, { ...tool, name: 'reset' }]) as { type: string; name: string; instance: unknown; tools?: unknown };
    expect(server).toMatchObject({ type: 'sdk', name: 'canvas' });
    expect(server.instance).toBeTruthy();
    expect(server.tools).toBeUndefined();
  });
});
