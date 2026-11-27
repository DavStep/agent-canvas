// ~/.agent-canvas/settings.json: the owner's new-session defaults (model and thinking level per
// provider) and the models each provider's menus list. Written atomically (0600); a damaged file
// is moved aside and the defaults start empty. Without a file (demo mode) it lives in memory only.
// "Open at login" is not kept here: macOS keeps the login item itself.
import { acpAgentProblem, type AcpAgentConfig } from '../shared/acp.ts';
import { isAgentConnection } from '../shared/agentConnection.ts';
import type { AppSettings, SessionDefaults, SettingsPatch } from '../shared/bridge.ts';
import type { Provider } from '../shared/chat.ts';
import { loadJson, saveJsonAtomic } from './persist.ts';

/** What the file keeps: ACP agents as configured (main adds what was found on this Mac). */
export type StoredSettings = Omit<AppSettings, 'openAtLogin' | 'agentKeys' | 'acpAgents' | 'acpPresets' | 'availableModelProfiles'> & { acpAgents: AcpAgentConfig[] };
type SettingsData = Omit<StoredSettings, 'agentConnection' | 'acpAgents'> & {
  version: 1; agentConnection?: StoredSettings['agentConnection']; acpAgents?: AcpAgentConfig[];
};

const PROVIDERS: Provider[] = ['claude', 'codex'];
const NONE: SessionDefaults = { model: null, effort: null };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNullableString = (v: unknown): boolean => v === null || typeof v === 'string';
const isDefaults = (v: unknown): boolean => isRecord(v) && isNullableString(v.model) && isNullableString(v.effort);
const isShown = (v: unknown): boolean => v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string'));

function isSettingsData(v: unknown): v is SettingsData {
  return isRecord(v) && v.version === 1 && isRecord(v.defaults) && isRecord(v.shownModels)
    && (v.agentConnection === undefined || isAgentConnection(v.agentConnection))
    && (v.modelPermissions === undefined || (isRecord(v.modelPermissions)
      && Object.entries(v.modelPermissions).every(([p, ids]) => (p === 'claude' || p === 'codex')
        && Array.isArray(ids) && ids.length > 0 && ids.every(id => typeof id === 'string'))))
    && (v.acpAgents === undefined || (Array.isArray(v.acpAgents) && v.acpAgents.every((a) => acpAgentProblem(a) === null)))
    && (v.limitReset === undefined || v.limitReset === 'ask' || v.limitReset === 'continue')
    && PROVIDERS.every((p) => isDefaults((v.defaults as Record<string, unknown>)[p]) && isShown((v.shownModels as Record<string, unknown>)[p]));
}

export const EMPTY_SETTINGS: StoredSettings = { agentConnection: 'claude-login', defaults: { claude: NONE, codex: NONE }, shownModels: { claude: null, codex: null }, acpAgents: [], limitReset: 'ask' };

export class SettingsFile {
  /** Saves run one after another, each writing the latest data. */
  private chain: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string | null, private data: SettingsData) {}

  static async load(file: string | null): Promise<SettingsFile> {
    const empty: SettingsData = { version: 1, ...EMPTY_SETTINGS };
    return new SettingsFile(file, file === null ? empty : await loadJson(file, empty, isSettingsData));
  }

  get(): StoredSettings {
    return { agentConnection: this.data.agentConnection ?? 'claude-login', defaults: this.data.defaults, shownModels: this.data.shownModels, modelPermissions: this.data.modelPermissions, acpAgents: this.data.acpAgents ?? [], limitReset: this.data.limitReset ?? 'ask' };
  }

  /** Only the providers the patch names change; openAtLogin is not this file's. */
  update(patch: SettingsPatch): Promise<void> {
    if (!patch.defaults && !patch.shownModels && !patch.agentConnection && !patch.acpAgents && !patch.modelPermissions && !patch.limitReset) return Promise.resolve();
    this.chain = this.chain.catch(() => {}).then(async () => {
      const next: SettingsData = {
        version: 1,
        agentConnection: patch.agentConnection ?? this.get().agentConnection,
        defaults: { ...this.data.defaults, ...patch.defaults },
        shownModels: { ...this.data.shownModels, ...patch.shownModels },
        ...(patch.modelPermissions || this.data.modelPermissions ? {
          modelPermissions: { ...this.data.modelPermissions, ...patch.modelPermissions },
        } : {}),
        // A file that never had ACP agents keeps its shape until one is added.
        ...(patch.acpAgents !== undefined || this.data.acpAgents !== undefined ? { acpAgents: patch.acpAgents ?? this.get().acpAgents } : {}),
        // Kept only once chosen: a file without it reads Ask.
        ...(patch.limitReset ?? this.data.limitReset ? { limitReset: patch.limitReset ?? this.data.limitReset } : {}),
      };
      if (this.file !== null) await saveJsonAtomic(this.file, next);
      this.data = next;
    });
    return this.chain;
  }
}
