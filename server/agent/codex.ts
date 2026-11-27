import { z } from 'zod';
import type { ProjectProfile } from './project.ts';
import { agentPrompt } from './prompt.ts';
import { CANVAS_TOOLS, type CanvasApi, type ToolResult } from './tools.ts';
import type { DynamicToolCallParams } from '../engines/codex/protocol/v2/DynamicToolCallParams.ts';

export interface CodexCanvasAgent {
  cwd: string;
  api: CanvasApi;
  projectFor?(id: string): ProjectProfile | undefined;
  auth: { command: string; args: string[] };
}

export function codexAgentOptions(agent: CodexCanvasAgent | undefined, cwd: string, start: boolean, project?: ProjectProfile) {
  if (!agent || (!project && cwd !== agent.cwd)) return {};
  return {
    modelProvider: 'canvas_openai',
    config: {
      'model_providers.canvas_openai': {
        name: 'OpenAI API', base_url: 'https://api.openai.com/v1', wire_api: 'responses', auth: agent.auth,
      },
    },
    developerInstructions: project?.prompt ?? agentPrompt(),
    ...(start ? { dynamicTools: (project?.tools ?? CANVAS_TOOLS).map(tool => ({
      type: 'function', name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(z.object(tool.shape)),
    })) } : {}),
  };
}

export async function callCanvasTool(
  api: CanvasApi, params: DynamicToolCallParams, approve: ((title: string, detail: string) => Promise<boolean>) | null, tools = CANVAS_TOOLS,
): Promise<ToolResult> {
  const tool = tools.find(t => t.name === params.tool);
  const args = params.arguments;
  if (!tool || params.namespace || !args || typeof args !== 'object' || Array.isArray(args)) {
    return { isError: true, text: 'Unknown canvas tool or invalid arguments.' };
  }
  // `approve` is null in Full access: the owner chose not to be asked.
  if (!tool.safe && approve && !await approve(`Allow ${tool.name}?`, JSON.stringify(args, null, 2))) {
    return { isError: true, text: 'The owner declined this action.' };
  }
  return tool.handler(api, args);
}
