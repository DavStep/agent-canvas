import { describe, expect, it } from 'vitest';
import { modelLabel, modelName } from './modelLabel.ts';

describe('modelLabel', () => {
  it.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-fable-5-2', 'Fable 5.2'],
    ['claude-sonnet-5-5', 'Sonnet 5.5'],
    ['claude-haiku-5-5', 'Haiku 5.5'],
    ['claude-opus-4-8', 'Opus 4.8'],
    ['claude-sonnet-4-6', 'Sonnet 4.6'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-opus-4-20250514', 'Opus 4'],
    ['claude-3-5-sonnet-20241022', 'Sonnet 3.5'],
    ['anthropic/claude-opus-5-5', 'Opus 5.5'],
    ['us.anthropic.claude-sonnet-4-6-v1:0', 'Sonnet 4.6'],
    ['claude-opus-5-5[1m]', 'Opus 5.5 1M'],
    ['opus', 'Opus'],
    ['sonnet', 'Sonnet'],
    ['fable', 'Fable'],
    ['haiku', 'Haiku'],
    ['default', 'Default'],
    ['sonnet[1m]', 'Sonnet 1M'],
  ])('Claude %s → %s', (id, label) => {
    expect(modelLabel('claude', id)).toBe(label);
  });

  it.each([
    ['gpt-6.2-astra', 'Astra 6.2'],
    ['gpt-6.2-sol', 'Sol 6.2'],
    ['gpt-6.1-terra', 'Terra 6.1'],
    ['gpt-6-luna', 'Luna 6'],
    ['gpt-6.2-astra-mini', 'Astra 6.2 Mini'],
    ['openai/gpt-6.2-sol', 'Sol 6.2'],
    ['gpt-5', 'GPT-5'],
  ])('Codex %s → %s', (id, label) => {
    expect(modelLabel('codex', id)).toBe(label);
  });

  it('appends the thinking level in title case, with one space', () => {
    expect(modelLabel('claude', 'claude-opus-5-5', 'high')).toBe('Opus 5.5 High');
    expect(modelLabel('codex', 'gpt-6.2-astra', 'medium')).toBe('Astra 6.2 Medium');
    expect(modelLabel('claude', 'claude-fable-5-2', 'max')).toBe('Fable 5.2 Max');
    expect(modelLabel('codex', 'gpt-6.2-sol', 'xhigh')).toBe('Sol 6.2 Extra High');
    expect(modelLabel('claude', 'claude-opus-5-5[1m]', 'high')).toBe('Opus 5.5 1M High');
  });

  it('leaves the level out when it is unknown or unset', () => {
    expect(modelLabel('claude', 'claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude', 'claude-opus-5-5', null)).toBe('Opus 5.5');
    expect(modelLabel('claude', 'claude-opus-5-5', '')).toBe('Opus 5.5');
  });

  it('names an alias or an unparsed id from the provider menu', () => {
    const models = [{ id: 'default', label: 'Default (recommended)' }, { id: 'demo-large', label: 'Fable 5.2' }, { id: 'raw', label: 'raw' }];
    expect(modelLabel('claude', 'default', null, { models })).toBe('Default (recommended)');
    expect(modelLabel('codex', 'demo-large', 'high', { models })).toBe('Fable 5.2 High');
    expect(modelLabel('codex', 'raw', null, { models })).toBe('Raw');
    // A full id wins over the menu's shorter name.
    expect(modelLabel('claude', 'claude-opus-5-5', null, { models: [{ id: 'claude-opus-5-5', label: 'Opus' }] })).toBe('Opus 5.5');
  });

  it('puts an ACP agent name ahead of its model, once', () => {
    expect(modelLabel('acp', 'gemini-2-5-pro', null, { agentName: 'Kestrel' })).toBe('Kestrel Gemini 2.5 Pro');
    expect(modelLabel('acp', 'Kestrel Swift', 'high', { agentName: 'Kestrel' })).toBe('Kestrel Swift High');
    expect(modelLabel('acp', null, null, { agentName: 'Kestrel' })).toBe('Kestrel');
    expect(modelLabel('acp', 'Swift 2')).toBe('Swift 2');
  });

  it('prettifies unknown ids and never throws', () => {
    expect(modelLabel('codex', 'demo-mini')).toBe('Demo Mini');
    expect(modelLabel('codex', 'gpt-4o')).toBe('GPT 4o');
    expect(modelLabel('codex', 'o3')).toBe('o3');
    expect(modelLabel('claude', 'some_new-model-7-1')).toBe('Some New Model 7.1');
    expect(modelLabel('claude', 'Fable 5.2')).toBe('Fable 5.2');
    expect(modelLabel('claude', null, 'high')).toBe('');
    expect(modelLabel('claude', undefined)).toBe('');
    expect(modelLabel('claude', '   ')).toBe('');
    expect(modelLabel('claude', '[1m]')).toBe('1M');
    expect(modelName('claude', 'claude-opus-5-5')).toBe('Opus 5.5');
  });
});
