// ACP agents: the coding agents the owner configured to run over the Agent Client Protocol (see
// docs/acp.md). Pure, so main (settings, IPC checks, the engine) and the page (Settings, New
// session) agree on what an agent is and which ones there are.

/** Which creature an agent's cards wear: Claude Code's, Codex's, or the generic one. */
export type AcpIcon = 'claude' | 'codex' | 'agent';
export const ACP_ICONS: { id: AcpIcon; label: string }[] = [
  { id: 'agent', label: 'Generic agent' }, { id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' },
];

/** One ACP agent as Settings keeps it: how to start it, and how its cards look. */
export interface AcpAgentConfig {
  /** Stable and short ("gemini"): card badges, start_task's provider and saved sessions use it. */
  id: string;
  name: string;
  /** A program on the login shell's PATH ("gemini") or an absolute path. */
  command: string;
  /** Explicit New session visibility. Claude and Codex adapters default to hidden. */
  showInNewSession?: boolean;
  args: string[];
  /** Added to the agent's environment (over the app's own minimal one). */
  env: Record<string, string>;
  icon: AcpIcon;
}

/** An agent as Settings and New session show it: the config, and what was found on this Mac. */
export interface AcpAgentView extends AcpAgentConfig {
  /** The program that runs, when found; null when it is not installed. */
  path: string | null;
  /** How to install it, for a preset (shown while it is not found). */
  install: string | null;
}

/** A card's or a chat's agent: enough to name it on a badge and pick its creature. */
export interface AcpBadge { id: string; name: string; icon: AcpIcon }

export interface AcpPreset extends AcpAgentConfig { install: string; note: string }

/** Agents known to speak ACP. Adding one installs nothing: it only fills in the command. */
export const ACP_PRESETS: AcpPreset[] = [
  {
    id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--acp'], env: {}, icon: 'agent',
    install: 'npm i -g @google/gemini-cli', note: 'Gemini CLI speaks ACP itself. Older versions take --experimental-acp instead of --acp.',
  },
  {
    id: 'claude-acp', name: 'Claude Code (ACP)', command: 'claude-agent-acp', args: [], env: {}, icon: 'claude',
    install: 'npm i -g @agentclientprotocol/claude-agent-acp', note: 'Claude Code through its ACP adapter. It uses your Claude Code login.',
  },
  {
    id: 'codex-acp', name: 'Codex (ACP)', command: 'codex-acp', args: [], env: {}, icon: 'codex',
    install: 'npm i -g @zed-industries/codex-acp', note: 'Codex through its ACP adapter. It uses your Codex login.',
  },
];

/** Recognise the two presets and custom entries pointing to either adapter executable. */
export function isNativeAdapter(agent: AcpAgentConfig): boolean {
  const program = agent.command.trim().split('/').pop();
  return agent.id === 'claude-acp' || agent.id === 'codex-acp' || program === 'claude-agent-acp' || program === 'codex-acp';
}

export function showsInNewSession(agent: AcpAgentConfig): boolean {
  return agent.showInNewSession ?? !isNativeAdapter(agent);
}

/** At most this many agents, args and env entries; far above any real setup. */
export const MAX_AGENTS = 32;
const MAX_ARGS = 64;
const MAX_ENV = 64;
const MAX_TEXT = 4096;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT && !v.includes('\0');
export const isAcpIcon = (v: unknown): v is AcpIcon => v === 'claude' || v === 'codex' || v === 'agent';
export const isAcpAgentId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

/** Why an agent config cannot be kept, or null. Also checked again in main for each save. */
export function acpAgentProblem(v: unknown): string | null {
  if (!isRecord(v)) return 'An ACP agent must be an object';
  if (!isAcpAgentId(v.id)) return 'An ACP agent id is 1–40 lowercase letters, digits and dashes, starting with a letter or digit';
  if (v.id === 'claude' || v.id === 'codex' || v.id === 'acp') return `"${v.id}" is taken by a built-in provider; choose another id`;
  if (!isText(v.name) || v.name.trim() === '' || v.name.length > 60) return 'An ACP agent needs a name of at most 60 characters';
  if (!isText(v.command) || v.command.trim() === '') return 'An ACP agent needs a command';
  if (v.command.includes('/') && !v.command.startsWith('/')) return 'A command is a program name on PATH or an absolute path';
  if (!Array.isArray(v.args) || v.args.length > MAX_ARGS || !v.args.every(isText)) return 'Arguments must be a list of strings';
  if (!isRecord(v.env) || Object.keys(v.env).length > MAX_ENV) return 'Environment must map names to values';
  for (const [key, value] of Object.entries(v.env)) {
    if (!ENV_KEY.test(key) || !isText(value)) return `Environment entry ${JSON.stringify(key)} must be NAME=value`;
  }
  if (v.showInNewSession !== undefined && typeof v.showInNewSession !== 'boolean') return 'New session visibility must be true or false';
  if (!isAcpIcon(v.icon)) return 'Unknown icon';
  return null;
}

/** A fresh copy with only the known fields, or throws the problem. */
export function acpAgentConfig(v: unknown): AcpAgentConfig {
  const problem = acpAgentProblem(v);
  if (problem !== null) throw new TypeError(problem);
  const a = v as AcpAgentConfig;
  return { id: a.id, name: a.name.trim(), command: a.command.trim(), args: [...a.args], env: { ...a.env }, icon: a.icon,
    ...(a.showInNewSession !== undefined && { showInNewSession: a.showInNewSession }) };
}

/** A whole list as Settings saves it: each valid, ids unique. */
export function acpAgentList(v: unknown): AcpAgentConfig[] {
  if (!Array.isArray(v) || v.length > MAX_AGENTS) throw new TypeError(`ACP agents must be a list of at most ${MAX_AGENTS}`);
  const list = v.map(acpAgentConfig);
  const ids = new Set<string>();
  for (const a of list) {
    if (ids.has(a.id)) throw new TypeError(`Two ACP agents have the id ${a.id}`);
    ids.add(a.id);
  }
  return list;
}

/** `KEY=value` lines (blank lines and # comments skipped) → env; throws on a bad line. */
export function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const key = eq === -1 ? line : line.slice(0, eq).trim();
    if (eq === -1 || !ENV_KEY.test(key)) throw new TypeError(`Line ${n + 1}: write NAME=value`);
    out[key] = line.slice(eq + 1);
  }
  return out;
}

export const envLines = (env: Record<string, string>): string => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');

/** Arguments typed on one line, split on spaces; "double" or 'single' quotes keep spaces in one. */
export function parseArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

export const argsLine = (args: string[]): string => args.map((a) => (a === '' || /\s/.test(a) ? `"${a}"` : a)).join(' ');

/** A unique id for a new agent named `name`, avoiding `taken`. */
export function agentIdFor(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'agent';
  const used = new Set([...taken, 'claude', 'codex', 'acp']);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** ACP cards are named `acp:<local id>`; the ACP engine knows each by its local id. */
export const ACP_PREFIX = 'acp:';
export const acpCardId = (localId: string): string => ACP_PREFIX + localId;
export const isAcpCardId = (cardId: string): boolean => cardId.startsWith(ACP_PREFIX);

/** A provider name as the canvas agent gives it ("claude", "codex", "gemini" or "acp:gemini"):
    a built-in provider, or an ACP agent's id. */
export function parseProviderName(name: string): { provider: 'claude' | 'codex' } | { provider: 'acp'; agent: string } | null {
  const n = name.trim().toLowerCase();
  if (n === 'claude' || n === 'codex') return { provider: n };
  const id = n.startsWith(ACP_PREFIX) ? n.slice(ACP_PREFIX.length) : n;
  return isAcpAgentId(id) ? { provider: 'acp', agent: id } : null;
}
