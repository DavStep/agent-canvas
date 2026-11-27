// Settings → New sessions: per provider, the model and thinking level a new session opens with,
// and which models the model menus list (the New session dialog's and every chat's). Saved in
// main's settings.json; the menus follow as soon as a change is saved.
import { useEffect, useState } from 'react';
import type { AppSettings, ProviderOptions, SessionDefaults } from '../../../shared/bridge.ts';
import { effortLabel, type ModelOption, type Provider } from '../../../shared/chat.ts';
import { addAllowed, allowedIds, MODEL_CATALOG, profileFromId, profileId, profileLabel, removeAllowed, type Profile } from '../../../shared/modelPolicy.ts';
import { modelName, namedModels } from '../../../shared/modelLabel.ts';
import { AUTO_EFFORT, effortChoices, effortFor } from '../../../shared/settings.ts';
import { newSessionBridge } from '../bridge.ts';
import { Picker, ThinkingIcon } from '../chat/Composer.tsx';
import { errorText } from '../preview/BrowserTab.tsx';
import { saveSettings, useSettings } from '../settings.ts';
import { useClosing } from '../useClosing.ts';

const NAME: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };
/** The default-model menu's id for "the provider's own default" (null saved). */
const OWN = '';

/** The model a session starts on with `defaults`: the saved one, else the provider's own. */
function startModel(models: ModelOption[], defaults: SessionDefaults): ModelOption | undefined {
  return models.find((m) => m.id === defaults.model) ?? models.find((m) => m.isDefault) ?? models[0];
}

/** Which models a menu lists after `id` is ticked or unticked; null: all of them. */
export function toggleShown(models: ModelOption[], shown: string[] | null, id: string, on: boolean): string[] | null {
  const now = new Set(shown ?? models.map((m) => m.id));
  if (on) now.add(id);
  else now.delete(id);
  const next = models.map((m) => m.id).filter((m) => now.has(m));
  return next.length === models.length ? null : next;
}

function ProviderDefaults({ provider, settings, onError }: { provider: Provider; settings: AppSettings; onError(e: string | null): void }) {
  const [options, setOptions] = useState<ProviderOptions | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    newSessionBridge.options(provider).then(setOptions, (err: unknown) => setFailed(errorText(err)));
  }, [provider]);

  const defaults = settings.defaults[provider];
  const shown = settings.shownModels[provider];
  const models = namedModels(provider, options?.models ?? []);
  const model = startModel(models, defaults);
  const thinking = effortChoices(model);
  const save = (patch: Parameters<typeof saveSettings>[0]) => {
    setSaving(true);
    onError(null);
    saveSettings(patch).then(() => setSaving(false), (err: unknown) => { setSaving(false); onError(errorText(err)); });
  };
  const setDefaults = (d: SessionDefaults) => save({ defaults: { [provider]: d } });
  const ownLabel = `${NAME[provider]}'s default${models.find((m) => m.isDefault) ? ` (${models.find((m) => m.isDefault)!.label})` : ''}`;

  return (
    <section className={`pf-panel ms-panel is-${provider}`} aria-label={`${NAME[provider]} new sessions`}>
      <header className="pf-panel-head">
        <i className="pf-mark" aria-hidden="true" />
        <h3>{NAME[provider]}</h3>
      </header>
      {options === null ? (
        <p className="pf-quiet">{failed !== null ? `Models not read: ${failed}` : 'Reading the models…'}</p>
      ) : (<>
        <div className="ms-row">
          <span className="ms-label">Default model</span>
          <Picker label={`${NAME[provider]} default model`} value={defaults.model !== null && models.some((m) => m.id === defaults.model) ? defaults.model : OWN}
            options={[{ id: OWN, label: ownLabel }, ...models]} disabled={saving} push
            onChange={(id) => {
              const next = id === OWN ? null : id;
              setDefaults({ model: next, effort: effortFor(startModel(models, { model: next, effort: null }), defaults.effort) });
            }} />
        </div>
        {thinking.length > 0 && (
          <div className="ms-row">
            <span className="ms-label">Thinking</span>
            <Picker label={`${NAME[provider]} default thinking`} icon={<ThinkingIcon />} push disabled={saving}
              value={effortFor(model, defaults.effort) ?? (thinking.some((t) => t.id === AUTO_EFFORT) ? AUTO_EFFORT : model?.defaultEffort ?? AUTO_EFFORT)}
              options={thinking}
              onChange={(e) => setDefaults({ model: defaults.model, effort: e === AUTO_EFFORT ? null : e })} />
          </div>
        )}
        <fieldset className="ms-models">
          <legend className="ms-label">
            In the model menu
            {shown !== null && <button type="button" className="ms-all" disabled={saving} onClick={() => save({ shownModels: { [provider]: null } })}>Show all</button>}
          </legend>
          <ul>
            {models.map((m) => {
              const on = shown === null || shown.includes(m.id);
              const last = on && (shown === null ? models.length === 1 : shown.filter((id) => models.some((x) => x.id === id)).length === 1);
              return (
                <li key={m.id}>
                  <label className={last ? 'is-locked' : undefined} title={last ? 'At least one model stays in the menu' : m.id}>
                    <input type="checkbox" checked={on} disabled={saving || last}
                      onChange={(e) => save({ shownModels: { [provider]: toggleShown(models, shown, m.id, e.target.checked) } })} />
                    <span>{m.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      </>)}
    </section>
  );
}

/** Settings → Models, one provider: the allowed model and thinking pairs as rows the owner adds to
    and removes from, and the default chosen among them. Saved at once; the menus and the
    orchestrators read the same list. */
function AllowedModels({ provider, settings, onError }: { provider: Provider; settings: AppSettings; onError(e: string | null): void }) {
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const offered = settings.availableModelProfiles?.[provider] ?? [];
  const list = allowedIds(provider, settings.modelPermissions?.[provider]).filter(id => offered.includes(id));
  const rows = list.map(id => profileFromId(provider, id)!);
  const defaults = settings.defaults[provider];
  const picked = rows.find(p => p.model === defaults.model && p.effort === defaults.effort) ?? rows[0];
  const save = async (patch: Parameters<typeof saveSettings>[0]): Promise<boolean> => {
    setSaving(true);
    onError(null);
    try { await saveSettings(patch); return true; }
    catch (err) { onError(errorText(err)); return false; }
    finally { setSaving(false); }
  };
  const setDefault = (p: Profile) => save({ defaults: { [provider]: { model: p.model, effort: p.effort } } });
  const remove = (id: string) => {
    const next = removeAllowed(list, id, picked ? profileId(picked) : null);
    if (!next) { onError(`Keep at least one ${NAME[provider]} pair.`); return; }
    const fallback = next.nextDefault !== null ? profileFromId(provider, next.nextDefault) : undefined;
    void save({ modelPermissions: { [provider]: next.list },
      ...(fallback ? { defaults: { [provider]: { model: fallback.model, effort: fallback.effort } } } : {}) });
  };
  const add = async (id: string) => {
    const next = addAllowed(provider, list, id);
    if (!next) { onError('That model and thinking level is already in the list.'); return; }
    if (await save({ modelPermissions: { [provider]: next } })) { setAdded(id); setAdding(false); }
  };
  const full = offered.every(id => list.includes(id));
  return (
    <section className={`pf-panel ms-panel is-${provider}`} aria-label={`${NAME[provider]} model settings`}>
      <header className="pf-panel-head"><i className="pf-mark" aria-hidden="true" /><h3>{NAME[provider]}</h3></header>
      {picked && <div className="ms-row">
        <span className="ms-label">Default</span>
        <Picker label={`${NAME[provider]} default model and thinking`} value={profileId(picked)} disabled={saving} push
          options={rows.map(p => ({ id: profileId(p), label: profileLabel(p) }))}
          onChange={id => { const p = profileFromId(provider, id); if (p) void setDefault(p); }} />
      </div>}
      <div className="ms-models" role="group" aria-label={`${NAME[provider]} can use`}>
        <span className="ms-label ms-legend">Can use</span>
        <ul className="ms-pairs">
          {rows.map(p => {
            const id = profileId(p);
            return <PairRow key={id} label={profileLabel(p)} fresh={id === added} last={rows.length === 1}
              disabled={saving} onRemove={() => remove(id)} />;
          })}
        </ul>
        {adding
          ? <AddPair provider={provider} list={list} offered={offered} disabled={saving} onAdd={id => void add(id)} onCancel={() => setAdding(false)} />
          : !full && <button type="button" className="ms-add" disabled={saving} onClick={() => { onError(null); setAdding(true); }}>
              <PlusIcon />Add model
            </button>}
      </div>
    </section>
  );
}

const PlusIcon = () => (
  <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
);
const RemoveIcon = () => (
  <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
);

/** One allowed pair: its name and a quiet ×. The last one left cannot go. */
function PairRow({ label, fresh, last, disabled, onRemove }: { label: string; fresh: boolean; last: boolean; disabled: boolean; onRemove(): void }) {
  const { closing, close } = useClosing(onRemove);
  return (
    <li className={`ms-pair${fresh ? ' is-new' : ''}${closing ? ' is-closing' : ''}`}>
      <span>{label}</span>
      <button type="button" className="ms-remove" aria-label={`Remove ${label}`}
        title={last ? 'At least one pair stays' : 'Remove'} disabled={disabled || last || closing} onClick={close}>
        <RemoveIcon />
      </button>
    </li>
  );
}

/** The inline picker under the list: a model, then only the thinking levels it takes that are not
    in the list yet. */
function AddPair({ provider, list, offered, disabled, onAdd, onCancel }: {
  provider: Provider; list: string[]; offered: string[]; disabled: boolean; onAdd(id: string): void; onCancel(): void;
}) {
  const free = (model: string) => (MODEL_CATALOG[provider].find(m => m.model === model)?.efforts ?? [])
    .filter(e => { const id = profileId({ model, effort: e }); return offered.includes(id) && !list.includes(id); });
  const models = MODEL_CATALOG[provider].filter(m => free(m.model).length > 0);
  const [model, setModel] = useState(models[0]?.model ?? '');
  const efforts = free(model);
  const [effort, setEffort] = useState(efforts.includes('high') ? 'high' : efforts[0] ?? '');
  const chosen = efforts.includes(effort) ? effort : efforts[0] ?? '';
  const pick = (m: string) => { setModel(m); const e = free(m); setEffort(e.includes(effort) ? effort : e.includes('high') ? 'high' : e[0] ?? ''); };
  return (
    <div className="ms-adder" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onCancel(); } }}>
      <Picker label={`${NAME[provider]} model to add`} value={model} disabled={disabled}
        options={models.map(m => ({ id: m.model, label: modelName(provider, m.model, { models: [{ id: m.model, label: m.label }] }) }))}
        onChange={pick} />
      <Picker label="Thinking level to add" icon={<ThinkingIcon />} value={chosen} disabled={disabled || efforts.length === 0}
        options={efforts.map(e => ({ id: e, label: effortLabel(e) }))} onChange={setEffort} />
      <span className="ms-adder-acts">
        <button type="button" className="t-btn ghost" disabled={disabled} onClick={onCancel}>Cancel</button>
        <button type="button" className="t-btn outline" disabled={disabled || !model || !chosen}
          onClick={() => onAdd(profileId({ model, effort: chosen }))}>Add</button>
      </span>
    </div>
  );
}

export function ModelSettings() {
  const settings = useSettings();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="pf-setting ms">
      <div>
        <span className="pf-setting-name">{settings?.availableModelProfiles ? "Models" : "New sessions"}</span>
        <span className="pf-quiet">{error ?? (settings?.availableModelProfiles ? 'Allowed model and thinking pairs for menus and orchestrators. Defaults apply to new chats.' : 'The model and thinking level a new session starts with, and the models the menus list.')}</span>
      </div>
      {settings !== null && (
        <div className="pf-panels ms-panels">
          {(['claude', 'codex'] as const).map(provider => settings.availableModelProfiles
            ? <AllowedModels key={provider} provider={provider} settings={settings} onError={setError} />
            : <ProviderDefaults key={provider} provider={provider} settings={settings} onError={setError} />)}
        </div>
      )}
    </div>
  );
}
