import type { ProviderOptions, SessionDefaults } from './bridge.ts';
import type { Provider } from './chat.ts';
import { modelLabel } from './modelLabel.ts';

/** The pairs allowed until the owner edits the list in Settings → Models (and the migration's
    starting point: a saved list keeps only what was ticked). */
export const MODEL_PROFILES = {
  claude: [
    { model: 'claude-opus-5-5', effort: 'high', label: 'Opus 5.5' },
    { model: 'claude-opus-5-5', effort: 'medium', label: 'Opus 5.5' },
    { model: 'claude-fable-5-2', effort: 'medium', label: 'Fable 5.2' },
    { model: 'claude-fable-5-2', effort: 'high', label: 'Fable 5.2' },
  ],
  codex: [
    { model: 'gpt-6.2-astra', effort: 'high', label: 'Astra 6.2' },
    { model: 'gpt-6.2-sol', effort: 'high', label: 'Sol 6.2' },
  ],
} as const;
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
/** Every exact model Settings → Models can add, per provider, with the thinking levels it takes. */
export const MODEL_CATALOG: Record<Provider, readonly CatalogModel[]> = {
  claude: [
    { model: 'claude-opus-5-5', label: 'Opus 5.5', efforts: CLAUDE_EFFORTS },
    { model: 'claude-fable-5-2', label: 'Fable 5.2', efforts: CLAUDE_EFFORTS },
    { model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: CLAUDE_EFFORTS },
    { model: 'claude-haiku-5-5', label: 'Haiku 5.5', efforts: ['low', 'medium', 'high'] },
  ],
  codex: [
    { model: 'gpt-6.2-astra', label: 'Astra 6.2', efforts: CODEX_EFFORTS },
    { model: 'gpt-6.2-sol', label: 'Sol 6.2', efforts: CODEX_EFFORTS },
    { model: 'gpt-6.1-terra', label: 'Terra 6.1', efforts: CODEX_EFFORTS },
    { model: 'gpt-6-luna', label: 'Luna 6', efforts: CODEX_EFFORTS },
  ],
};
export interface CatalogModel { model: string; label: string; efforts: readonly string[] }
export type Profile = { model: string; effort: string; label: string };
export type ModelPermissions = Partial<Record<Provider, string[]>>;
export const profileId = ({ model, effort }: Pick<Profile, 'model' | 'effort'>): string => `${model}|${effort}`;
/** The pair's name in Settings and the menus ("Opus 5.5 High"); one place to swap the formatter. */
export const profileLabel = ({ model, label, effort }: Profile): string =>
  modelLabel(model.startsWith('gpt-') ? 'codex' : 'claude', model, effort, { models: [{ id: model, label }] });
/** The pairs allowed before the owner edits the list. */
export function knownProfiles(provider: Provider): Profile[] {
  return [...MODEL_PROFILES[provider]];
}
/** Every pair the catalog offers for `provider`, model by model. */
export function catalogProfiles(provider: Provider): Profile[] {
  return MODEL_CATALOG[provider].flatMap(m => m.efforts.map(effort => ({ model: m.model, effort, label: m.label })));
}
/** The pair an id names, when the catalog offers it. */
export function profileFromId(provider: Provider, id: string): Profile | undefined {
  return catalogProfiles(provider).find(p => profileId(p) === id);
}
/** The allowed list as ids, in the owner's order: a saved list keeps the pairs still offered (no
    repeats); none saved, or none of it left, is the starting set. */
export function allowedIds(provider: Provider, allowed?: readonly string[]): string[] {
  const kept = [...new Set(allowed ?? [])].filter(id => profileFromId(provider, id) !== undefined);
  return kept.length > 0 ? kept : knownProfiles(provider).map(profileId);
}
export function allowedProfiles(provider: Provider, allowed?: readonly string[]): Profile[] {
  return allowedIds(provider, allowed).map(id => profileFromId(provider, id)!);
}
/** The list with `id` added at its end; null when the catalog does not offer it or it is there already. */
export function addAllowed(provider: Provider, list: readonly string[], id: string): string[] | null {
  if (profileFromId(provider, id) === undefined || list.includes(id)) return null;
  return [...list, id];
}
/** The list without `id`, and the default to switch to when `id` was it (the pair after it, else
    the one before). null when `id` is the last pair left: one always stays. */
export function removeAllowed(list: readonly string[], id: string, defaultId: string | null):
  { list: string[]; nextDefault: string | null } | null {
  const at = list.indexOf(id);
  if (at < 0 || list.length <= 1) return null;
  const next = list.filter(x => x !== id);
  return { list: next, nextDefault: defaultId === id ? (next[at] ?? next[at - 1]!) : null };
}

export function chooseProfile(
  provider: Provider, allowed: Profile[], defaults: SessionDefaults | undefined,
  request: SessionDefaults = { model: null, effort: null },
): Profile {
  const preferred = allowed.find(p => p.model === defaults?.model && p.effort === defaults.effort) ?? allowed[0];
  const candidates = allowed.filter(p => (request.model === null || p.model === request.model)
    && (request.effort === null || p.effort === request.effort));
  const result = (preferred && candidates.includes(preferred) ? preferred : candidates[0]);
  if (!result) throw new Error(`Model and thinking level not enabled for ${provider}: ${request.model ?? 'default'} / ${request.effort ?? 'default'}. Check Profile → Models.`);
  return result;
}

export function restrictOptions(provider: Provider, options: ProviderOptions, profiles: Profile[], defaults?: SessionDefaults): ProviderOptions {
  const fallback = chooseProfile(provider, profiles, defaults);
  const models = [...new Set(profiles.map(p => p.model))].map(id => {
    const list = profiles.filter(p => p.model === id);
    return { id, label: list[0]!.label, isDefault: false, efforts: list.map(p => p.effort),
      defaultEffort: (list.find(p => p.effort === fallback.effort) ?? list[0]!).effort };
  });
  return { ...options, models, model: fallback.model, effort: fallback.effort };
}
