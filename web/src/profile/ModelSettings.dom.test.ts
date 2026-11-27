// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { catalogProfiles, profileId } from '../../../shared/modelPolicy.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const availableModelProfiles = { claude: catalogProfiles('claude').map(profileId), codex: catalogProfiles('codex').map(profileId) };
let current: Record<string, unknown>;
let host: HTMLElement;
let root: Root;

/** Settings → Models drawn against a fake bridge whose saves land in `current`. */
async function open(initial: Record<string, unknown>) {
  current = { availableModelProfiles, ...initial };
  const setSettings = vi.fn(async (patch: Record<string, unknown>) => {
    const merge = (k: string) => ({ ...(current[k] as object | undefined), ...(patch[k] as object | undefined) });
    current = { ...current, ...patch, defaults: merge('defaults'), modelPermissions: merge('modelPermissions') };
  });
  Object.assign(window, { canvas: { getSettings: async () => current, setSettings } });
  vi.resetModules();   // the page reads settings once: each test starts unread
  const { ModelSettings } = await import('./ModelSettings.tsx');
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await act(async () => root.render(createElement(ModelSettings)));
  const panel = (name: string) => host.querySelector<HTMLElement>(`[aria-label="${name} model settings"]`)!;
  return { setSettings, claude: panel('Claude'), codex: panel('Codex') };
}
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const rows = (panel: HTMLElement) => [...panel.querySelectorAll('.ms-pair span')].map(s => s.textContent);
const defaultOptions = (panel: HTMLElement) =>
  [...panel.querySelector<HTMLSelectElement>('select[aria-label$="default model and thinking"]')!.options].map(o => o.textContent);
const button = (panel: HTMLElement, name: string) =>
  [...panel.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === name || b.textContent === name)!;
const choose = async (panel: HTMLElement, label: string, value: string) => {
  const select = panel.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
};

it('lists the allowed pairs as rows (migrated: unticked ones are gone) and the default offers exactly them', async () => {
  const { claude, codex } = await open({
    defaults: { claude: { model: 'opus', effort: 'high' }, codex: { model: null, effort: null } },
    modelPermissions: { claude: ['claude-opus-5-5|high', 'claude-fable-5-2|medium'] },
  });
  expect(rows(claude)).toEqual(['Opus 5.5 High', 'Fable 5.2 Medium']);
  expect(defaultOptions(claude)).toEqual(rows(claude));
  expect(claude.querySelector('select')!.value).toBe('claude-opus-5-5|high');
  expect(rows(codex)).toEqual(['Astra 6.2 High', 'Sol 6.2 High']);
  expect(codex.querySelector('select')!.value).toBe('gpt-6.2-astra|high');
  expect(claude.querySelector('input[type="checkbox"]')).toBeNull();
});

it('removes a pair; removing the default moves it to the next pair; the last one stays', async () => {
  const { claude, setSettings } = await open({
    defaults: { claude: { model: 'claude-opus-5-5', effort: 'high' }, codex: { model: null, effort: null } },
    modelPermissions: { claude: ['claude-opus-5-5|high', 'claude-opus-5-5|medium', 'claude-fable-5-2|high'] },
  });
  expect(button(claude, 'Remove Opus 5.5 Medium').title).toBe('Remove');
  await act(async () => button(claude, 'Remove Opus 5.5 Medium').click());
  expect(setSettings).toHaveBeenLastCalledWith({ modelPermissions: { claude: ['claude-opus-5-5|high', 'claude-fable-5-2|high'] } });
  expect(rows(claude)).toEqual(['Opus 5.5 High', 'Fable 5.2 High']);

  await act(async () => button(claude, 'Remove Opus 5.5 High').click());
  expect(setSettings).toHaveBeenLastCalledWith({
    modelPermissions: { claude: ['claude-fable-5-2|high'] },
    defaults: { claude: { model: 'claude-fable-5-2', effort: 'high' } },
  });
  expect(claude.querySelector('select')!.value).toBe('claude-fable-5-2|high');
  const last = button(claude, 'Remove Fable 5.2 High');
  expect(last.disabled).toBe(true);
  expect(last.title).toBe('At least one pair stays');
});

it('adds a pair from the inline picker, offering only the model’s levels not in the list yet', async () => {
  const { claude, codex, setSettings } = await open({
    defaults: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
    modelPermissions: { claude: ['claude-opus-5-5|high'] },
  });
  await act(async () => button(claude, 'Add model').click());
  const levels = () => [...claude.querySelector<HTMLSelectElement>('select[aria-label="Thinking level to add"]')!.options].map(o => o.value);
  expect(levels()).toEqual(['low', 'medium', 'xhigh', 'max']);   // High is in the list already
  await choose(claude, 'Claude model to add', 'claude-haiku-5-5');
  expect(levels()).toEqual(['low', 'medium', 'high']);
  await choose(claude, 'Claude model to add', 'claude-fable-5-2');
  await choose(claude, 'Thinking level to add', 'max');
  await act(async () => button(claude, 'Add').click());
  expect(setSettings).toHaveBeenLastCalledWith({ modelPermissions: { claude: ['claude-opus-5-5|high', 'claude-fable-5-2|max'] } });
  expect(rows(claude)).toEqual(['Opus 5.5 High', 'Fable 5.2 Max']);
  expect(defaultOptions(claude)).toEqual(['Opus 5.5 High', 'Fable 5.2 Max']);
  expect(claude.querySelector('.ms-adder')).toBeNull();

  await act(async () => button(codex, 'Add model').click());
  await choose(codex, 'Codex model to add', 'gpt-6.2-sol');
  await choose(codex, 'Thinking level to add', 'medium');
  await act(async () => button(codex, 'Add').click());
  expect(rows(codex)).toEqual(['Astra 6.2 High', 'Sol 6.2 High', 'Sol 6.2 Medium']);
  // Sol's High and Medium are in the list: the picker cannot offer them again.
  await act(async () => button(codex, 'Add model').click());
  await choose(codex, 'Codex model to add', 'gpt-6.2-sol');
  expect([...codex.querySelector<HTMLSelectElement>('select[aria-label="Thinking level to add"]')!.options].map(o => o.value)).toEqual(['low', 'xhigh']);
});
