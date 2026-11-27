import { describe, expect, it } from 'vitest';
import type { ProviderOptions } from '../../../shared/bridge.ts';
import type { Layout, SessionView } from '../../../shared/types.ts';
import { canStart, choiceOf, CHOOSE_FOLDER, chooseModel, folderChoices, initialForm, startRequest, switchProvider, withOptions, zoneFolder } from './form.ts';

const NOW = 1_795_000_000_000;
const MIN = 60_000;

function session(id: string, cwd: string, folder: string, ago: number, patch: Partial<SessionView> = {}): SessionView {
  return {
    id, provider: 'claude', hostId: null, name: id, cwd, folder, state: 'idle', need: null, activity: null, rawStatus: 'idle',
    stateSince: NOW - ago, startedAt: NOW - ago - MIN, branch: null, model: null, lastPrompt: null, lastAnswer: null, subagents: [],
    owner: 'nobody', ownerNote: null, host: null, ...patch,
  };
}

const zone = (folder: string, hueIndex: number) =>
  ({ id: `folder:${folder}`, name: folder === '' ? 'No folder' : folder, kind: 'folder' as const, folder, x: 0, y: 0, hueIndex });

const LAYOUT: Layout = {
  version: 1,
  zones: [zone('alpha', 0), zone('beta', 1), zone('gamma', 2), zone('', 6),
    { id: 'custom:1', name: 'Mine', kind: 'custom', folder: null, x: 0, y: 0, hueIndex: 3 }],
  assignments: { 'b-1': 'custom:1' },
};

const SESSIONS = [
  session('a-1', '/work/alpha', 'alpha', 50 * MIN),
  session('b-1', '/work/beta', 'beta', 5 * MIN),
  session('g-1', '/work/gamma', 'gamma', 300 * MIN),
  // A worktree of gamma used just now: its folder is gamma's own.
  session('g-2', '/work/gamma/.claude/worktrees/feat-x', 'gamma', 1 * MIN),
  session('s-1', '/Users/me/scratch-workspaces/abc', '', 0),
];

describe('folderChoices', () => {
  it('folders offered = zone folders, most recent first, plus "Choose folder…"', () => {
    const choices = folderChoices(SESSIONS, LAYOUT);
    expect(choices.map((c) => c.label)).toEqual(['gamma', 'beta', 'alpha', CHOOSE_FOLDER]);
    expect(CHOOSE_FOLDER).toBe('Choose folder…');
    // Each folder starts sessions in its own root, never in a worktree; the "No folder" zone offers none.
    expect(choices.slice(0, 3).map((c) => c.path)).toEqual(['/work/gamma', '/work/beta', '/work/alpha']);
    expect(choices.slice(0, 3).map((c) => c.hueIndex)).toEqual([2, 1, 0]);
    expect(choices.at(-1)).toEqual({ kind: 'choose', label: CHOOSE_FOLDER, path: null, hueIndex: null });
  });

  it('a folder picked with "Choose folder…" comes first, once', () => {
    const choices = folderChoices(SESSIONS, LAYOUT, ['/elsewhere/delta', '/work/alpha']);
    expect(choices.map((c) => c.path)).toEqual(['/elsewhere/delta', '/work/alpha', '/work/gamma', '/work/beta', null]);
    expect(choices[0]).toMatchObject({ kind: 'folder', label: 'delta', hueIndex: null });
    // A known folder keeps its zone's name and hue.
    expect(choices[1]).toMatchObject({ label: 'alpha', hueIndex: 0 });
  });

  it('a renamed folder zone keeps its name in the list', () => {
    const renamed: Layout = { ...LAYOUT, zones: LAYOUT.zones.map((z) => (z.id === 'folder:alpha' ? { ...z, name: 'Alpha app' } : z)) };
    expect(folderChoices(SESSIONS, renamed).find((c) => c.path === '/work/alpha')?.label).toBe('Alpha app');
  });
});

const CLAUDE: ProviderOptions = {
  models: [
    { id: 'default', label: 'Default (recommended)', isDefault: true, efforts: ['low', 'high', 'max'] },
    { id: 'opus', label: 'Opus', isDefault: false, efforts: ['low', 'high', 'max'] },
    { id: 'haiku-old', label: 'Haiku 4.5', isDefault: false },
  ],
  model: 'default',
  effort: null,
  modes: [{ id: 'default', label: 'Ask' }, { id: 'plan', label: 'Plan' }],
  mode: 'default',
};
const CODEX: ProviderOptions = {
  models: [
    { id: 'gpt-a', label: 'GPT A', isDefault: false, efforts: ['low', 'medium', 'high'], defaultEffort: 'low' },
    { id: 'gpt-b', label: 'GPT B', isDefault: true, efforts: ['low', 'medium'], defaultEffort: 'medium' },
  ],
  model: 'gpt-b',
  effort: 'medium',
  modes: [{ id: 'read-only', label: 'Read only' }, { id: 'auto', label: 'Auto' }, { id: 'full-access', label: 'Full access' }],
  mode: 'auto',
};

describe('the new session form', () => {
  it("provider switch resets model and mode to that provider's default", () => {
    let form = withOptions(initialForm('claude', '/work/alpha'), 'claude', CLAUDE);
    expect(form).toMatchObject({ provider: 'claude', model: 'default', mode: 'default' });
    form = { ...form, model: 'opus', mode: 'plan', text: 'Fix the build' };
    form = switchProvider(form, 'codex', CODEX);
    expect(form).toMatchObject({ provider: 'codex', model: 'gpt-b', mode: 'auto', cwd: '/work/alpha', text: 'Fix the build' });
    form = { ...form, model: 'gpt-a', mode: 'full-access' };
    expect(switchProvider(form, 'claude', CLAUDE)).toMatchObject({ provider: 'claude', model: 'default', mode: 'default' });
  });

  it("a provider whose options have not arrived yet gets its defaults when they do, and never another provider's", () => {
    let form = switchProvider({ ...initialForm('claude', '/work/alpha'), model: 'opus' }, 'codex', null);
    expect(form).toMatchObject({ provider: 'codex', model: null, mode: null });
    // Late Claude options are not the current provider's: ignored.
    expect(withOptions(form, 'claude', CLAUDE)).toBe(form);
    form = withOptions(form, 'codex', CODEX);
    expect(form).toMatchObject({ model: 'gpt-b', mode: 'auto' });
    // A choice already made stays.
    expect(withOptions({ ...form, model: 'gpt-a' }, 'codex', CODEX).model).toBe('gpt-a');
  });

  it('Start disabled until a message is typed', () => {
    const form = initialForm('claude', '/work/alpha');
    expect(canStart(form, false)).toBe(false);
    expect(canStart({ ...form, text: '   \n' }, false)).toBe(false);
    expect(canStart({ ...form, text: 'Fix the build' }, false)).toBe(true);
    // Nor with no folder, nor while a start is on its way.
    expect(canStart({ ...form, text: 'Fix the build', cwd: null }, false)).toBe(false);
    expect(canStart({ ...form, text: 'Fix the build' }, true)).toBe(false);
    // An image alone is a first message too.
    const image = { mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' };
    expect(canStart(form, false, [image])).toBe(true);
    expect(startRequest({ ...form, text: '' }, null, [image]).images).toEqual([image]);
    // So is a file alone; it goes by path, in the text, the way the provider's app sends it.
    const file = { name: 'report.pdf', path: '/Users/me/report.pdf' };
    expect(canStart(form, false, [], [file])).toBe(true);
    expect(startRequest({ ...form, text: 'Read it' }, null, [], [file]).text).toBe('@"/Users/me/report.pdf"\n\nRead it');
    expect(startRequest({ ...form, provider: 'codex', text: 'Read it' }, null, [], [file]).text).toContain('## report.pdf: /Users/me/report.pdf');
  });

  it("the request: the provider's default model goes as null (the engine picks it); another model by its id", () => {
    const form = { ...withOptions(initialForm('claude', '/work/alpha'), 'claude', CLAUDE), text: 'Fix the build' };
    expect(startRequest(form, CLAUDE)).toEqual({ provider: 'claude', cwd: '/work/alpha', model: null, effort: null, mode: 'default', text: 'Fix the build', images: [] });
    expect(startRequest({ ...form, model: 'opus', mode: 'plan' }, CLAUDE)).toMatchObject({ model: 'opus', mode: 'plan' });
    expect(startRequest({ ...form, model: null, mode: null }, null)).toMatchObject({ model: null, mode: null });
  });
});

describe('zoneFolder', () => {
  it("a folder zone's \"+\" starts in its latest session's folder root; custom and \"No folder\" zones have none", () => {
    const zones = Object.fromEntries(LAYOUT.zones.map((z) => [z.id, z]));
    expect(zoneFolder(zones['folder:gamma']!, SESSIONS)).toBe('/work/gamma');
    expect(zoneFolder(zones['folder:alpha']!, SESSIONS)).toBe('/work/alpha');
    expect(zoneFolder(zones['folder:']!, SESSIONS)).toBeNull();
    expect(zoneFolder(zones['custom:1']!, SESSIONS)).toBeNull();
    expect(zoneFolder(zone('unseen', 4), SESSIONS)).toBeNull();
  });

  it('a folder zone made for a folder starts there until a session has run in it', () => {
    expect(zoneFolder({ ...zone('unseen', 4), path: '/Users/me/unseen' }, SESSIONS)).toBe('/Users/me/unseen');
    expect(zoneFolder({ ...LAYOUT.zones.find((z) => z.id === 'folder:gamma')!, path: '/elsewhere/gamma' }, SESSIONS)).toBe('/work/gamma');
  });
});

describe('the thinking level', () => {
  it('opens at the options\' level, stays across models that take it, and falls back to the model\'s own', () => {
    let form = withOptions(initialForm('codex', '/work/alpha'), 'codex', CODEX);
    expect(form).toMatchObject({ model: 'gpt-b', effort: 'medium' });
    form = chooseModel(form, CODEX, 'gpt-a');
    expect(form).toMatchObject({ model: 'gpt-a', effort: 'medium' });
    form = chooseModel({ ...form, effort: 'high' }, CODEX, 'gpt-b');
    expect(form.effort).toBe('medium');
    // Claude names no default: Auto (null) stays Auto, and a model with no levels has none.
    const claude = withOptions(initialForm('claude', '/work/alpha'), 'claude', CLAUDE);
    expect(chooseModel(claude, CLAUDE, 'opus').effort).toBeNull();
    expect(chooseModel({ ...claude, effort: 'max' }, CLAUDE, 'opus').effort).toBe('max');
    expect(chooseModel({ ...claude, effort: 'max' }, CLAUDE, 'haiku-old').effort).toBeNull();
  });

  it("goes with the request; a saved default model goes by id even when it is the options' choice", () => {
    const form = { ...withOptions(initialForm('claude', '/work/alpha'), 'claude', { ...CLAUDE, model: 'opus', effort: 'high' }), text: 'Hi' };
    expect(startRequest(form, { ...CLAUDE, model: 'opus' })).toMatchObject({ model: 'opus', effort: 'high' });
  });
});

describe('an ACP agent as the provider', () => {
  const OFFER = { models: [], model: null, effort: null, modes: [], mode: '' };
  it('is chosen by acp:<id>, starts with no mode when the agent offers none, and names its agent', () => {
    let form = switchProvider(initialForm('claude', '/work/alpha'), 'acp:gemini', null);
    expect(form).toMatchObject({ provider: 'acp', agent: 'gemini', model: null, mode: null });
    expect(choiceOf(form)).toBe('acp:gemini');
    expect(withOptions(form, 'acp:other', OFFER)).toBe(form);
    form = withOptions(form, 'acp:gemini', OFFER);
    expect(form.mode).toBeNull();
    const req = startRequest({ ...form, text: 'Hi' }, OFFER, [], [{ name: 'a.md', path: '/work/alpha/a.md' }]);
    expect(req).toMatchObject({ provider: 'acp', agent: 'gemini', mode: null, text: '@"/work/alpha/a.md"\n\nHi' });
    expect(startRequest({ ...form, provider: 'claude', agent: null, text: 'Hi' }, null)).not.toHaveProperty('agent');
  });
});
