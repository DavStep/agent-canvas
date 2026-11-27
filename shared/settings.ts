// The owner's new-session defaults and model menus, kept pure so main and the page agree: which
// thinking level a model takes, the defaults the New session dialog opens with, and the models a
// menu lists.
import type { ProviderOptions, SessionDefaults } from './bridge.ts';
import { effortLabel, type ModelOption } from './chat.ts';

/** The thinking level to use with `model`: the one wanted when the model takes it, else the
    model's own default; null when the model has no levels to pick (or says no default). */
export function effortFor(model: ModelOption | undefined, wanted: string | null): string | null {
  const efforts = model?.efforts ?? [];
  if (efforts.length === 0) return null;
  if (wanted !== null && efforts.includes(wanted)) return wanted;
  return model?.defaultEffort != null && efforts.includes(model.defaultEffort) ? model.defaultEffort : null;
}

/** The provider's options with the owner's saved defaults chosen, where it still offers them. */
export function applyDefaults(options: ProviderOptions, defaults: SessionDefaults | undefined): ProviderOptions {
  const saved = defaults?.model ?? null;
  const model = saved !== null && options.models.some((m) => m.id === saved) ? saved : options.model;
  const effort = effortFor(options.models.find((m) => m.id === model), defaults?.effort ?? options.effort);
  return { ...options, model, effort };
}

/** The models a menu lists: those the owner chose to show (all when none are chosen, or none of
    the chosen are offered any more), and always the one selected now. */
export function visibleModels(models: ModelOption[], shown: string[] | null | undefined, selected: string | null): ModelOption[] {
  if (!shown) return models;
  const picked = models.filter((m) => shown.includes(m.id) || m.id === selected);
  return picked.some((m) => shown.includes(m.id)) ? picked : models;
}

/** A thinking menu's choices for `model`, lowest first. A model that names no default of its own
    (Claude) leads with Auto: no level is passed, and the model decides. Empty: no menu. */
export function effortChoices(model: ModelOption | undefined): { id: string; label: string }[] {
  const efforts = model?.efforts ?? [];
  if (efforts.length === 0) return [];
  const levels = efforts.map((e) => ({ id: e, label: effortLabel(e) }));
  return model?.defaultEffort != null ? levels : [{ id: AUTO_EFFORT, label: 'Auto' }, ...levels];
}
/** The menu's id for "no level passed" (null in the request). */
export const AUTO_EFFORT = '';
