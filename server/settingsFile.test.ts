import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedProfiles, profileId } from '../shared/modelPolicy.ts';
import { EMPTY_SETTINGS, SettingsFile } from './settingsFile.ts';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-settings-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('settings.json', () => {
  it('starts empty, keeps what each patch names, and reads back after a restart', async () => {
    const file = path.join(dir, 'settings.json');
    const s = await SettingsFile.load(file);
    expect(s.get()).toEqual(EMPTY_SETTINGS);
    await s.update({ defaults: { claude: { model: 'opus', effort: 'high' } } });
    await s.update({ shownModels: { codex: ['gpt-6.2-astra'] }, openAtLogin: true });
    const again = await SettingsFile.load(file);
    expect(again.get()).toEqual({
      agentConnection: 'claude-login',
      defaults: { claude: { model: 'opus', effort: 'high' }, codex: { model: null, effort: null } },
      shownModels: { claude: null, codex: ['gpt-6.2-astra'] },
      acpAgents: [],
      limitReset: 'ask',
    });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).not.toHaveProperty('openAtLogin');
  });

  it('keeps "When a limit resets": Ask until Continue automatically is chosen', async () => {
    const file = path.join(dir, 'settings.json');
    const s = await SettingsFile.load(file);
    expect(s.get().limitReset).toBe('ask');
    await s.update({ limitReset: 'continue' });
    expect((await SettingsFile.load(file)).get().limitReset).toBe('continue');
    await s.update({ defaults: { codex: { model: null, effort: null } } });
    expect((await SettingsFile.load(file)).get().limitReset).toBe('continue');
  });

  it('opens legacy settings and persists the connection without the submitted key', async () => {
    const file = path.join(dir, 'settings.json');
    const legacy = { version: 1, defaults: EMPTY_SETTINGS.defaults, shownModels: { claude: ['sonnet'], codex: null } };
    await fs.writeFile(file, JSON.stringify(legacy));
    const settings = await SettingsFile.load(file);
    expect(settings.get()).toMatchObject({ agentConnection: 'claude-login', shownModels: legacy.shownModels });
    await settings.update({ agentConnection: 'codex-api', agentKey: { provider: 'codex', key: 'test-secret' } });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ ...legacy, agentConnection: 'codex-api' });
    expect((await SettingsFile.load(file)).get().agentConnection).toBe('codex-api');
  });

  it('migrates the ticked model pairs to the allowed rows; unticked ones stay out, added ones persist', async () => {
    const file = path.join(dir, 'settings.json');
    // Written by the checkbox list: only the ticked pairs were saved.
    const old = { version: 1, defaults: EMPTY_SETTINGS.defaults, shownModels: EMPTY_SETTINGS.shownModels,
      modelPermissions: { claude: ['claude-opus-5-5|high', 'claude-fable-5-2|high'] } };
    await fs.writeFile(file, JSON.stringify(old));
    const s = await SettingsFile.load(file);
    expect(allowedProfiles('claude', s.get().modelPermissions?.claude).map(profileId)).toEqual(['claude-opus-5-5|high', 'claude-fable-5-2|high']);
    // Never edited: the whole starting set.
    expect(allowedProfiles('codex', s.get().modelPermissions?.codex).map(profileId)).toEqual(['gpt-6.2-astra|high', 'gpt-6.2-sol|high']);
    await s.update({ modelPermissions: { claude: ['claude-opus-5-5|high', 'claude-fable-5-2|high', 'claude-sonnet-5-5|low'] } });
    expect((await SettingsFile.load(file)).get().modelPermissions).toEqual({ claude: ['claude-opus-5-5|high', 'claude-fable-5-2|high', 'claude-sonnet-5-5|low'] });
  });

  it('keeps the ACP agents a patch names; a file with an invalid one is set aside', async () => {
    const file = path.join(dir, 'settings.json');
    const s = await SettingsFile.load(file);
    const gemini = { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--acp'], env: { GEMINI_API_KEY: 'k' }, icon: 'agent' as const };
    await s.update({ acpAgents: [gemini] });
    await s.update({ defaults: { codex: { model: 'gpt', effort: null } } });
    expect((await SettingsFile.load(file)).get().acpAgents).toEqual([gemini]);
    await s.update({ acpAgents: [] });
    expect((await SettingsFile.load(file)).get().acpAgents).toEqual([]);
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...data, acpAgents: [{ ...gemini, id: 'Bad Id' }] }));
    expect((await SettingsFile.load(file)).get().acpAgents).toEqual([]);
  });

  it('a damaged file is moved aside and the settings start empty', async () => {
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, defaults: { claude: 3 } }));
    expect((await SettingsFile.load(file)).get()).toEqual(EMPTY_SETTINGS);
    expect((await fs.readdir(dir)).some((f) => f.startsWith('settings.json.bad-'))).toBe(true);
  });
});
