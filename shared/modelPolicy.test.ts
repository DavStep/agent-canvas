import { describe, expect, it } from 'vitest';
import { addAllowed, allowedIds, allowedProfiles, catalogProfiles, chooseProfile, profileId, removeAllowed, restrictOptions } from './modelPolicy.ts';

describe('Canvas model and thinking policy', () => {
  it('defaults to exact versions, never provider aliases', () => {
    expect(chooseProfile('claude', allowedProfiles('claude'), { model: 'opus', effort: 'high' })).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
    expect(chooseProfile('codex', allowedProfiles('codex'), undefined)).toMatchObject({ model: 'gpt-6.2-astra', effort: 'high' });
  });
  it('rejects explicit stale models and wrong effort instead of substituting', () => {
    for (const [model, effort] of [['opus', 'high'], ['claude-opus-5','high'], ['claude-fable-5-2', 'low'], ['claude-fable-5-5','high']]) {
      expect(() => chooseProfile('claude', allowedProfiles('claude'), undefined, { model: model!, effort: effort! })).toThrow('not enabled');
    }
    expect(() => chooseProfile('codex', allowedProfiles('codex'), undefined, { model: 'gpt-6.2-sol', effort: 'medium' })).toThrow('not enabled');
  });
  it('allows both requested Fable 5.2 levels', () => {
    expect(allowedProfiles('claude').map(profileId)).toEqual(expect.arrayContaining(['claude-fable-5-2|medium', 'claude-fable-5-2|high']));
  });
  it('uses a surviving saved pair and shows only its exact effort', () => {
    const profiles = allowedProfiles('claude', ['claude-opus-5-5|medium', 'claude-fable-5-2|medium']);
    const options = restrictOptions('claude', { models: [], model: 'opus', effort: 'high', modes: [], mode: 'auto' }, profiles,
      { model: 'claude-opus-5-5', effort: 'high' });
    expect(options).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', models: [{ efforts: ['medium'] }, { efforts: ['medium'] }] });
    expect(() => chooseProfile('claude', profiles, undefined, { model: 'claude-opus-5-5', effort: 'high' })).toThrow('not enabled');
  });
  it('adds a catalog pair once, at the end, and nothing the catalog lacks', () => {
    const list = allowedIds('claude');
    expect(addAllowed('claude', list, 'claude-fable-5-2|max')).toEqual([...list, 'claude-fable-5-2|max']);
    expect(addAllowed('claude', list, 'claude-opus-5-5|high')).toBeNull();
    expect(addAllowed('claude', list, 'claude-haiku-5-5|max')).toBeNull();
    expect(addAllowed('codex', ['gpt-6.2-astra|high'], 'gpt-6.2-sol|medium')).toEqual(['gpt-6.2-astra|high', 'gpt-6.2-sol|medium']);
    expect(catalogProfiles('claude').map(p => p.model)).toEqual(expect.arrayContaining(['claude-sonnet-5-5', 'claude-haiku-5-5']));
  });
  it('removes a pair, moves the default to the next one, and keeps the last', () => {
    const list = ['a|high', 'b|high', 'c|high'];
    expect(removeAllowed(list, 'b|high', 'a|high')).toEqual({ list: ['a|high', 'c|high'], nextDefault: null });
    expect(removeAllowed(list, 'b|high', 'b|high')).toEqual({ list: ['a|high', 'c|high'], nextDefault: 'c|high' });
    expect(removeAllowed(list, 'c|high', 'c|high')).toEqual({ list: ['a|high', 'b|high'], nextDefault: 'b|high' });
    expect(removeAllowed(['a|high'], 'a|high', 'a|high')).toBeNull();
  });
  it('drops saved pairs the catalog no longer offers, and repeats', () => {
    expect(allowedIds('claude', ['claude-opus-5-5|high', 'claude-opus-5|high', 'claude-opus-5-5|high'])).toEqual(['claude-opus-5-5|high']);
    expect(allowedIds('claude', ['gone|high'])).toEqual(allowedIds('claude'));
  });
  it('menus offer exactly the list: an added pair is in the options and can start', () => {
    const profiles = allowedProfiles('claude', ['claude-opus-5-5|high', 'claude-sonnet-5-5|low']);
    const options = restrictOptions('claude', { models: [], model: null, effort: null, modes: [], mode: 'auto' }, profiles);
    expect(options.models.map(m => [m.id, m.efforts])).toEqual([['claude-opus-5-5', ['high']], ['claude-sonnet-5-5', ['low']]]);
    expect(chooseProfile('claude', profiles, undefined, { model: 'claude-sonnet-5-5', effort: 'low' })).toMatchObject({ model: 'claude-sonnet-5-5' });
    expect(() => chooseProfile('claude', profiles, undefined, { model: 'claude-fable-5-2', effort: 'high' })).toThrow('not enabled');
  });
});
