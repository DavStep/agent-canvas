// Settings → ACP agents: coding agents that speak the Agent Client Protocol (docs/acp.md). Each is
// a program on this Mac that Agent canvas starts; adding one installs nothing. Presets fill in
// Gemini CLI and the Claude Code and Codex adapters; a custom agent takes any command. Whether
// each command is on this Mac is read with the settings and shown beside it.
import { useState } from 'react';
import {
  ACP_ICONS, ACP_PRESETS, acpAgentConfig, acpAgentProblem, agentIdFor, argsLine, isNativeAdapter, parseArgs, parseEnvLines, showsInNewSession,
  type AcpAgentConfig, type AcpAgentView, type AcpIcon,
} from '../../../shared/acp.ts';
import { Picker } from '../chat/Composer.tsx';
import { errorText } from '../preview/BrowserTab.tsx';
import { saveSettings, useSettings } from '../settings.ts';

const commandLine = (a: AcpAgentConfig): string => [a.command, argsLine(a.args)].filter((s) => s !== '').join(' ');

interface Draft { name: string; command: string; args: string; env: string; icon: AcpIcon }
const EMPTY: Draft = { name: '', command: '', args: '', env: '', icon: 'agent' };

function Status({ agent }: { agent: AcpAgentView }) {
  if (agent.path !== null) return <span className="acp-status is-found" title={agent.path}><i aria-hidden="true" />Installed</span>;
  return (
    <span className="acp-status is-missing">
      <i aria-hidden="true" />Not installed{agent.install ? <> · <code>{agent.install}</code></> : ` · \`${agent.command}\` is not on this Mac's PATH`}
    </span>
  );
}

export function AcpSettings() {
  const settings = useSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!settings) return null;
  const agents = settings.acpAgents;
  const taken = agents.map((a) => a.id);
  const presets = settings.acpPresets.filter((p) => !agents.some((a) => a.id === p.id || a.command === p.command));

  const save = async (next: AcpAgentConfig[]): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      await saveSettings({ acpAgents: next.map(acpAgentConfig) });
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const addCustom = async () => {
    if (!draft) return;
    let agent: AcpAgentConfig;
    try {
      agent = { id: agentIdFor(draft.name, taken), name: draft.name.trim(), command: draft.command.trim(), args: parseArgs(draft.args), env: parseEnvLines(draft.env), icon: draft.icon };
    } catch (err) { setError(errorText(err)); return; }
    const problem = acpAgentProblem(agent);
    if (problem) { setError(problem); return; }
    if (await save([...agents, agent])) setDraft(null);
  };

  return (
    <section className="pf-setting acp" aria-label="ACP agents">
      <div>
        <h3 className="pf-setting-name">ACP agents</h3>
        <p className="pf-quiet">Add agents such as Gemini to New session. You can also enable the Claude and Codex ACP adapters here for testing.</p>
      </div>
      {agents.length > 0 && (
        <ul className="acp-list" aria-label="Configured ACP agents">
          {agents.map((a) => (
            <li key={a.id} className="acp-row">
              <div className="acp-what">
                <span className="acp-name">{a.name}</span>
                <code className="acp-cmd" title={commandLine(a)}>{commandLine(a)}</code>
                <Status agent={a} />
                {/* Every agent has it: off by default for the Claude and Codex adapters (the native
                    engines come first), on for the rest. Hidden agents keep their sessions. */}
                <label className="acp-visibility" title={isNativeAdapter(a) ? 'Claude and Codex already run natively. Show this adapter to test it side by side.' : undefined}>
                  <input type="checkbox" checked={showsInNewSession(a)} disabled={saving}
                    aria-label={`Show ${a.name} in New session`}
                    onChange={(e) => { void save(agents.map((agent) => agent.id === a.id ? { ...agent, showInNewSession: e.target.checked } : agent)); }} />
                  Show in New session
                </label>
              </div>
              <button type="button" className="t-btn ghost" disabled={saving} aria-label={`Remove ${a.name}`}
                onClick={() => { void save(agents.filter((x) => x.id !== a.id)); }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {(presets.length > 0 || draft === null) && (
        <div className="acp-add" role="group" aria-label="Add an ACP agent">
          {presets.map((p) => (
            <button key={p.id} type="button" className="t-btn outline" disabled={saving}
              title={`${ACP_PRESETS.find((x) => x.id === p.id)?.note ?? ''}${p.path === null && p.install ? ` Not installed yet: ${p.install}` : ''}`.trim()}
              onClick={() => { void save([...agents, { ...acpAgentConfig(p), id: agentIdFor(p.id, taken) }]); }}>
              Add {p.name}{p.path === null && <span className="acp-add-note">Not installed</span>}
            </button>
          ))}
          {draft === null && <button type="button" className="t-btn ghost" disabled={saving} onClick={() => { setError(null); setDraft(EMPTY); }}>Custom agent…</button>}
        </div>
      )}
      {draft !== null && (
        <form className="acp-form" aria-label="Custom ACP agent" onSubmit={(e) => { e.preventDefault(); void addCustom(); }}>
          <label><span className="ms-label">Name</span>
            <input value={draft.name} placeholder="My agent" spellCheck={false} disabled={saving} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <label><span className="ms-label">Command</span>
            <input value={draft.command} placeholder="my-agent or /path/to/agent" spellCheck={false} autoCapitalize="off" disabled={saving}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })} /></label>
          <label><span className="ms-label">Arguments</span>
            <input value={draft.args} placeholder="--acp" spellCheck={false} autoCapitalize="off" disabled={saving} onChange={(e) => setDraft({ ...draft, args: e.target.value })} /></label>
          <label><span className="ms-label">Environment</span>
            <textarea rows={2} value={draft.env} placeholder="NAME=value, one per line" spellCheck={false} disabled={saving}
              onChange={(e) => setDraft({ ...draft, env: e.target.value })} /></label>
          <div className="acp-form-bar">
            <span className="ms-label">Character</span>
            <Picker label="Character" value={draft.icon} options={ACP_ICONS} disabled={saving}
              onChange={(icon) => setDraft({ ...draft, icon: icon as AcpIcon })} />
            <span className="acp-spacer" />
            <button type="button" className="t-btn ghost" disabled={saving} onClick={() => { setDraft(null); setError(null); }}>Cancel</button>
            <button type="submit" className="t-btn outline" disabled={saving || draft.name.trim() === '' || draft.command.trim() === ''}>
              {saving ? 'Saving…' : 'Add agent'}
            </button>
          </div>
        </form>
      )}
      {error && <p className="pf-error" role="alert">{error}</p>}
    </section>
  );
}
