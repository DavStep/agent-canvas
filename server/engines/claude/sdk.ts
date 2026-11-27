// The Claude Agent SDK as Agent canvas uses it: the only file that imports the SDK. Everything
// else sees `SdkLike` / `QueryLike` (tests inject a fake) and the message types re-exported here.
import { createSdkMcpServer, query, renameSession, tool } from '@anthropic-ai/claude-agent-sdk';
import { createRequire } from 'node:module';
import path from 'node:path';
import type {
  AccountInfo, EffortLevel, McpServerConfig, ModelInfo, Options, PermissionMode, PermissionResult, PermissionUpdate, PermissionUpdateDestination,
  Query, SDKControlGetUsageResponse, SDKMessage, SDKRateLimitInfo, SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

export type {
  AccountInfo, EffortLevel, McpServerConfig, ModelInfo, Options, PermissionMode, PermissionResult, PermissionUpdate, PermissionUpdateDestination,
  SDKMessage, SDKRateLimitInfo, SDKUserMessage,
};
export type UsageResponse = SDKControlGetUsageResponse;

/** The part of a running query the engine calls. */
export type QueryLike = AsyncIterable<SDKMessage> & Pick<Query,
  'interrupt' | 'setModel' | 'setPermissionMode' | 'supportedModels' | 'accountInfo' | 'close'
  | 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'>;

export interface SdkLike {
  renameSession?: typeof renameSession;
  query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): QueryLike;
}

/** In a packaged app the SDK resolves its bundled Claude Code inside app.asar, which cannot be
    executed: electron-builder unpacks the binary's package (asarUnpack), and this is that path. */
export function unpackedPath(file: string | null): string | null {
  if (file === null) return null;
  const packed = `${path.sep}app.asar${path.sep}`;
  return file.includes(packed) ? file.replace(packed, `${path.sep}app.asar.unpacked${path.sep}`) : null;
}

/** The query options that point the SDK at the unpacked binary, when there is one. The SDK warns
    about its MCP default whenever an executable is given; 'argv' is that default, kept as is. */
export function executableOptions(resolved: string | null): Pick<Options, 'pathToClaudeCodeExecutable' | 'mcpServersDelivery'> {
  const file = unpackedPath(resolved);
  return file === null ? {} : { pathToClaudeCodeExecutable: file, mcpServersDelivery: 'argv' };
}

/** Where the SDK would find its binary: the platform package beside it, as the SDK resolves it. */
export function bundledExecutable(): string | null {
  try {
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    return createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${exe}`);
  } catch {
    return null;
  }
}

let executable: ReturnType<typeof executableOptions> | null = null;

/** The options a query really runs with: the caller's, pointed at the unpacked binary. A caller
    that asks for a delivery itself (the canvas agent: 'initialize', which keeps an HTTP server's
    headers off the command line) keeps it; the binary is always the one bundled with this SDK,
    which is what 'initialize' needs. */
export function queryOptions(options: Options, exe: ReturnType<typeof executableOptions>): Options {
  return { ...options, ...exe, ...(options.mcpServersDelivery !== undefined ? { mcpServersDelivery: options.mcpServersDelivery } : {}) };
}

export const realSdk: SdkLike = {
  renameSession,
  query: (params) => {
    executable ??= executableOptions(bundledExecutable());
    return query({ ...params, options: queryOptions(params.options, executable) });
  },
};

/** One tool of an in-process MCP server, as the rest of the app describes it: a zod shape for
    its arguments, and a handler that answers with text (an error is text too, marked). */
export interface McpToolSpec {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  /** True for a tool that only reads. */
  readOnly?: boolean;
  handler(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

/** Builds in-process MCP servers (tests inject a fake, so they need no SDK). */
export interface McpLike {
  /** A server for one query's `mcpServers`. */
  server(name: string, tools: McpToolSpec[]): McpServerConfig;
}

export const realMcp: McpLike = {
  server: (name, tools) => createSdkMcpServer({
    name,
    // Few tools, used all the time: always in the prompt, never behind tool search.
    alwaysLoad: true,
    tools: tools.map((t) => tool(t.name, t.description, t.shape as Parameters<typeof tool>[2], async (args) => {
      const { text, isError } = await t.handler(args as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
    }, { annotations: { readOnlyHint: t.readOnly === true } })),
  }),
};

/** Plan usage windows. The SDK marks this call experimental, so it is reached only through here. */
export function usage(q: QueryLike): Promise<UsageResponse> {
  return q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
}
