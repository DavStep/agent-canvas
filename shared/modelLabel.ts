// One friendly name for a model, wherever the app shows one: "Opus 5.5 High", "Astra 6.2 Medium".
// Raw ids stay the data (settings, the SDKs, the agent's tools); this is only what people read.
import type { ModelOption, SessionProvider } from './chat.ts';
import { effortLabel } from './chat.ts';

export interface ModelLabelContext {
  /** The provider's model menu, when known: names an alias or an ACP agent's model. */
  models?: readonly Pick<ModelOption, 'id' | 'label'>[];
  /** An ACP agent's configured name, put ahead of its model. */
  agentName?: string | null;
}

const titleWord = (w: string): string => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w);
const titleCase = (s: string): string => s.split(' ').map(titleWord).join(' ');

/** "[1m]" and the like: the context-window suffix, "1M". */
function splitSuffix(id: string): { base: string; suffix: string | null } {
  const m = /^(.*?)\[([^\]]+)\]$/.exec(id);
  return m ? { base: m[1]!, suffix: m[2]!.toUpperCase() } : { base: id, suffix: null };
}

/** Provider routing prefixes: "anthropic/", "us.anthropic.", "openai/", "models/". */
function stripPrefix(id: string): string {
  return id.replace(/^(?:[a-z]{2}\.)?(?:anthropic|openai|models|bedrock|vertex)[./]/i, '');
}

/** claude-opus-5-5, claude-haiku-4-5-20251001, claude-3-5-sonnet-20241022 → "Opus 5.5" … */
function claudeName(id: string): string | null {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?(?:-v\d+(?::\d+)?)?$/.exec(id);
  if (m) return `${titleWord(m[1]!)} ${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}`;
  const old = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-(\d{8}))?(?:-v\d+(?::\d+)?)?$/.exec(id);
  if (old) return `${titleWord(old[3]!)} ${old[1]}${old[2] !== undefined ? `.${old[2]}` : ''}`;
  return null;
}

/** gpt-6.2-astra, gpt-6-luna, gpt-6.2-astra-mini → "Astra 6.2", "Luna 6", "Astra 6.2 Mini"; gpt-5 → "GPT-5". */
function gptName(id: string): string | null {
  const m = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z][a-z0-9]*))?((?:-[a-z0-9]+)*)$/.exec(id);
  if (!m) return null;
  const rest = m[3] ? m[3].slice(1).split('-').map(titleWord).join(' ') : '';
  const name = m[2] ? `${titleWord(m[2])} ${m[1]}` : `GPT-${m[1]}`;
  return rest ? `${name} ${rest}` : name;
}

/** An id the patterns do not know: no prefix, words split and title-cased, "4-5" kept as "4.5". */
function prettify(id: string): string {
  if (/\s/.test(id)) return id;   // already a name ("Fable 5.2")
  const words = id.replace(/(\d)-(\d)/g, '$1.$2').split(/[-_/:]+/).filter(Boolean);
  const word = (w: string) => (/^\d/.test(w) || /^o\d/.test(w) ? w : /^gpt$/i.test(w) ? 'GPT' : titleWord(w));
  return words.map(word).join(' ') || id;
}

/** The model's name alone, without the thinking level. */
export function modelName(provider: SessionProvider, modelId: string | null | undefined, ctx: ModelLabelContext = {}): string {
  const raw = modelId?.trim() ?? '';
  if (raw === '') return ctx.agentName?.trim() ?? '';
  const { base, suffix } = splitSuffix(raw);
  const id = stripPrefix(base);
  const known = ctx.models?.find((m) => m.id === raw) ?? ctx.models?.find((m) => m.id === base);
  const listed = known && known.label && known.label !== known.id ? known.label : null;
  let name = claudeName(id) ?? gptName(id) ?? listed ?? prettify(id);
  if (suffix && !name.toUpperCase().includes(suffix)) name = name ? `${name} ${suffix}` : suffix;
  const agent = provider === 'acp' ? ctx.agentName?.trim() : undefined;
  if (agent && !name.toLowerCase().startsWith(agent.split(' ')[0]!.toLowerCase())) name = `${agent} ${name}`;
  return name;
}

/** "Opus 5.5 High": the model's name and, when known, its thinking level. '' when there is no model. */
export function modelLabel(provider: SessionProvider, modelId: string | null | undefined, effort?: string | null, ctx: ModelLabelContext = {}): string {
  const name = modelName(provider, modelId, ctx);
  if (name === '' || !effort) return name;
  return `${name} ${titleCase(effortLabel(effort))}`;
}

/** A model menu's options with friendly names (ids unchanged). */
export function namedModels<T extends Pick<ModelOption, 'id' | 'label'>>(provider: SessionProvider, models: readonly T[]): T[] {
  return models.map((m) => ({ ...m, label: modelName(provider, m.id, { models }) }));
}
