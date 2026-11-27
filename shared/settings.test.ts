import { describe, expect, it } from 'vitest';
import type { ProviderOptions } from './bridge.ts';
import { applyDefaults, AUTO_EFFORT, effortChoices, effortFor, visibleModels } from './settings.ts';

const CODEX: ProviderOptions = {
  models: [
    { id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', isDefault: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'low' },
    { id: 'gpt-6.2-astra', label: 'GPT-6.2-Astra', isDefault: false, efforts: ['low', 'medium', 'high', 'ultra'], defaultEffort: 'low' },
    { id: 'plain', label: 'Plain', isDefault: false },
  ],
  model: 'gpt-6.2-sol', effort: null, modes: [], mode: 'auto',
};

describe('new-session defaults', () => {
  it("choose the saved model and level where the provider offers them, else the provider's own", () => {
    expect(applyDefaults(CODEX, { model: 'gpt-6.2-astra', effort: 'high' })).toMatchObject({ model: 'gpt-6.2-astra', effort: 'high' });
    expect(applyDefaults(CODEX, { model: 'gone', effort: 'ultra' })).toMatchObject({ model: 'gpt-6.2-sol', effort: 'low' });
    expect(applyDefaults(CODEX, { model: 'plain', effort: 'high' })).toMatchObject({ model: 'plain', effort: null });
    expect(applyDefaults(CODEX, undefined)).toMatchObject({ model: 'gpt-6.2-sol', effort: 'low' });
  });

  it('a level the model does not take falls back to its own default, or none', () => {
    expect(effortFor(CODEX.models[0], 'ultra')).toBe('low');
    expect(effortFor({ id: 'opus', label: 'Opus 5.5', isDefault: false, efforts: ['low', 'high'] }, 'max')).toBeNull();
  });

  it('a model with no default of its own leads its thinking menu with Auto', () => {
    expect(effortChoices({ id: 'opus', label: 'Opus', isDefault: false, efforts: ['high', 'xhigh'] }))
      .toEqual([{ id: AUTO_EFFORT, label: 'Auto' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }]);
    expect(effortChoices(CODEX.models[0]).map((c) => c.id)).toEqual(['low', 'medium', 'high']);
    expect(effortChoices(CODEX.models[2])).toEqual([]);
  });
});

describe('the models a menu lists', () => {
  it('only those shown, always the selected one, and all when none is chosen or none of the chosen is offered', () => {
    const ids = (shown: string[] | null, selected: string | null) => visibleModels(CODEX.models, shown, selected).map((m) => m.id);
    expect(ids(null, 'plain')).toEqual(['gpt-6.2-sol', 'gpt-6.2-astra', 'plain']);
    expect(ids(['gpt-6.2-astra'], 'gpt-6.2-astra')).toEqual(['gpt-6.2-astra']);
    expect(ids(['gpt-6.2-astra'], 'plain')).toEqual(['gpt-6.2-astra', 'plain']);
    expect(ids(['gone'], 'plain')).toEqual(['gpt-6.2-sol', 'gpt-6.2-astra', 'plain']);
  });
});
