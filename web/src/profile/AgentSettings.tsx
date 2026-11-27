import { useState } from 'react';
import { AGENT_CONNECTIONS, isAgentConnection, type AgentConnection } from '../../../shared/agentConnection.ts';
import { Picker } from '../chat/Composer.tsx';
import { errorText } from '../preview/BrowserTab.tsx';
import { saveSettings, useSettings } from '../settings.ts';

const connections = Object.entries(AGENT_CONNECTIONS).map(([id, label]) => ({ id, label }));

export function AgentSettings() {
  const settings = useSettings();
  const [choice, setChoice] = useState<AgentConnection | null>(null);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!settings) return null;
  const connection = choice ?? settings.agentConnection;
  const provider = connection === 'codex-api' ? 'codex' : 'claude';
  const usesKey = connection !== 'claude-login';
  const savedKey = settings.agentKeys[provider];
  const keyLabel = provider === 'codex' ? 'OpenAI API key' : 'Anthropic API key';
  const changed = connection !== settings.agentConnection || key.trim() !== '';
  return (
    <form className="pf-setting agent-settings" aria-label="Canvas agent settings" onSubmit={async e => {
      e.preventDefault();
      setSaving(true);
      setError(null);
      try {
        await saveSettings({ agentConnection: connection, ...(usesKey && key.trim() ? { agentKey: { provider, key: key.trim() } } : {}) });
        setKey('');
        setChoice(null);
      } catch (err) { setError(errorText(err)); }
      finally { setSaving(false); }
    }}>
      <div className="agent-settings-row">
        <div>
          <h3 className="pf-setting-name">Canvas agent</h3>
          <p className="pf-quiet">Connection for new canvas agent conversations.</p>
        </div>
        <Picker label="Canvas agent connection" value={connection} options={connections} disabled={saving} push
          onChange={id => { if (isAgentConnection(id)) { setChoice(id); setKey(''); setError(null); } }} />
      </div>
      {usesKey && <label className="agent-settings-key">
        <span className="ms-label">{keyLabel}</span>
        <input type="password" aria-label={keyLabel} value={key} autoComplete="off" spellCheck={false} disabled={saving}
          placeholder={savedKey ? 'Key saved · enter a replacement' : 'Paste API key'} onChange={e => setKey(e.target.value)} />
        <span className="pf-quiet">Stored in macOS Keychain. Usage is billed to your {provider === 'codex' ? 'OpenAI' : 'Anthropic'} API account.</span>
      </label>}
      {(usesKey || changed) && <button type="submit" className="t-btn outline" disabled={saving || !changed || (usesKey && !savedKey && !key.trim())}>
        {saving ? 'Saving…' : 'Save connection'}
      </button>}
      {error && <p className="pf-error" role="alert">{error}</p>}
    </form>
  );
}
