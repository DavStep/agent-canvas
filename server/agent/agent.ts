// Claude's canvas agent sessions share the canvas MCP server and the agent instructions.
import { agentDirectory } from '../../shared/agentConnection.ts';
import path from 'node:path';
import { realMcp, type McpLike, type Options } from '../engines/claude/sdk.ts';
import type { ProjectProfile } from './project.ts';
import { agentPrompt } from './prompt.ts';
import { CANVAS_TOOLS, toolId, SERVER_NAME, type CanvasApi } from './tools.ts';

/** The agent's folder inside the app's data folder. */
export const agentFolder = (dataHome: string): string => path.join(dataHome, 'agent');

export interface AgentOptions {
  /** The agent's folder: a Claude session whose cwd is exactly this is the agent. */
  cwd: string;
  api: CanvasApi;
  mcp?: McpLike;
}

/** The Claude engine's extras for the login and API agent folders. A new MCP server is built for
    each process, as one server instance serves one connection. */
export function agentExtras(opts: AgentOptions): (cwd: string, project?: ProjectProfile) => Partial<Options> | null {
  const mcp = opts.mcp ?? realMcp;
  return (cwd, project) => {
    if (!project && cwd !== opts.cwd && cwd !== agentDirectory(opts.cwd, 'claude-api')) return null;
    const tools = project?.tools ?? CANVAS_TOOLS;
    const canvas = mcp.server(SERVER_NAME, tools.map((t) => ({
      name: t.name, description: t.description, shape: t.shape, readOnly: t.readOnly, handler: (args) => t.handler(opts.api, args),
    })));
    return {
      mcpServers: { [SERVER_NAME]: canvas },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: project?.prompt ?? agentPrompt() },
      // Reads and easily undone layout changes run at once in every mode; the rest follow the mode.
      allowedTools: tools.filter(t => t.safe).map(t => toolId(t.name)),
      ...(project ? { tools: [], strictMcpConfig: true } : { disallowedTools: ["Agent", "Task"] }),
      // The engine always passes a mode, which wins over this one: a resume with none known comes
      // back in Auto, or in Bypass where that is the chat's saved mode (main's restore). The flag
      // lets the owner switch a live agent chat to Bypass.
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    };
  };
}
