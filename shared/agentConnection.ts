export const AGENT_CONNECTIONS = {
  'claude-login': 'Claude Code login',
  'claude-api': 'Claude API',
  'codex-api': 'Codex API',
} as const;
export type AgentConnection = keyof typeof AGENT_CONNECTIONS;
export const isAgentConnection = (v: unknown): v is AgentConnection =>
  typeof v === 'string' && Object.hasOwn(AGENT_CONNECTIONS, v);

/** Legacy conversations keep their original directory. The API directories pin auth on resume. */
export function agentDirectory(root: string, connection: AgentConnection): string {
  return connection === 'claude-login' ? root : `${root}/${connection}`;
}

export function isAgentDirectory(root: string | null | undefined, cwd: string): boolean {
  return !!root && (cwd === root || cwd === agentDirectory(root, 'claude-api') || cwd === agentDirectory(root, 'codex-api'));
}
