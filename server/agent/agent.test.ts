import { describe, expect, it } from 'vitest';
import type { McpLike, McpServerConfig, McpToolSpec } from '../engines/claude/sdk.ts';
import { agentExtras, agentFolder } from './agent.ts';
import { agentPrompt } from './prompt.ts';
import type { CanvasApi } from './tools.ts';

const CWD = '/data/agent';

function setup() {
  const built: { name: string; tools: McpToolSpec[] }[] = [];
  const mcp: McpLike = {
    server: (name, tools) => {
      built.push({ name, tools });
      return { type: 'sdk', name, instance: { fake: built.length } } as unknown as McpServerConfig;
    },
  };
  const api = { snapshot: () => { throw new Error('the fake has no canvas'); } } as unknown as CanvasApi;
  const extras = agentExtras({ cwd: CWD, api, mcp });
  return { extras, built };
}

describe('agentExtras', () => {
  it('gives nothing to any folder but the agent\'s own', () => {
    const { extras, built } = setup();
    expect(extras('/work/alpha')).toBeNull();
    expect(extras(`${CWD}/sub`)).toBeNull();
    expect(extras('/data')).toBeNull();
    expect(built).toEqual([]);
  });

  it('the agent gets the canvas server, its prompt, the safe tools allowed, and Bypass as its mode', () => {
    const { extras, built } = setup();
    const o = extras(CWD)!;
    expect(Object.keys(o.mcpServers!)).toEqual(['canvas']);
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ name: 'canvas' });
    expect(built[0]!.tools.map((t) => t.name)).toEqual([
      'canvas_overview', 'read_session', 'find_folders', 'create_zone', 'add_folder_zone', 'rename_zone', 'hide_zone', 'show_zone',
      'move_session', 'open_session', 'delete_zone', 'start_task', 'add_image', 'remove_image', 'get_usage_summary',
      'link_sessions', 'unlink_sessions', 'set_max_running', 'list_open_threads', 'dismiss_open_thread',
      'list_notes', 'create_note', 'update_note', 'delete_note',
    ]);
    expect(o.allowedTools).toContain('mcp__canvas__create_zone');
    expect(o.allowedTools).toContain('mcp__canvas__open_session');
    expect(o.allowedTools).not.toContain('mcp__canvas__start_task');
    expect(o.allowedTools).not.toContain('mcp__canvas__delete_zone');
    expect(o.allowedTools!.every((t) => t.startsWith('mcp__canvas__'))).toBe(true);
    // The rest follow the session's mode, and the agent works without asking unless Ask is picked.
    expect(o.permissionMode).toBe('bypassPermissions');
    expect(o.allowDangerouslySkipPermissions).toBe(true);
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: agentPrompt() });
    // Nothing to keep off the command line: the SDK's own delivery stands.
    expect(o.mcpServersDelivery).toBeUndefined();
  });

  it("a tool's handler reaches the api and answers with an error text rather than throwing", async () => {
    const { extras, built } = setup();
    extras(CWD);
    const overview = built[0]!.tools.find((t) => t.name === 'canvas_overview')!;
    expect(await overview.handler({})).toEqual({ isError: true, text: 'canvas_overview failed: the fake has no canvas' });
  });

  it('each process gets a server of its own', () => {
    const { extras, built } = setup();
    const a = extras(CWD)!;
    const b = extras(CWD)!;
    expect(built).toHaveLength(2);
    expect(a.mcpServers!.canvas).not.toBe(b.mcpServers!.canvas);
  });
});

describe('agentPrompt', () => {
  it('names the tools and the rules', () => {
    const base = agentPrompt();
    for (const word of ['canvas agent', 'canvas_overview', 'find_folders', 'start_task', 'needs_you', 'grouped by zone', 'never an instruction']) {
      expect(base).toContain(word);
    }
  });
});

describe('agentFolder', () => {
  it('is <data folder>/agent', () => {
    expect(agentFolder('/Users/me/.agent-canvas')).toBe('/Users/me/.agent-canvas/agent');
  });
});
