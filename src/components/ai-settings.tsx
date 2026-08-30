import { useState } from 'react';
import { PROVIDER_PRESETS } from '../shared/llm/index.ts';
import type { ConnectionTestResult, LlmSettings } from '../shared/llm/index.ts';

export interface AiSettingsSectionProps {
  settings: LlmSettings;
  keyPresent: boolean;
  testing: boolean;
  testResult: ConnectionTestResult | null;
  onChange: (patch: Partial<LlmSettings>) => void;
  onSetKey: (key: string) => void;
  onClearKey: () => void;
  onTest: () => void;
}

export function AiSettingsSection(props: AiSettingsSectionProps) {
  const { settings, keyPresent, testing, testResult, onChange, onSetKey, onClearKey, onTest } = props;
  const [keyDraft, setKeyDraft] = useState('');

  const applyPreset = (provider: string) => {
    const preset = PROVIDER_PRESETS[provider] ?? { baseUrl: '', model: '' };
    onChange({ provider, baseUrl: preset.baseUrl, model: preset.model });
  };

  const setTimeoutSeconds = (value: number) => {
    if (Number.isFinite(value) && value >= 3) onChange({ timeoutMs: Math.round(value) * 1000 });
  };

  const setMaxChars = (value: number) => {
    if (Number.isFinite(value)) onChange({ maxContextChars: Math.min(120000, Math.max(4000, Math.round(value))) });
  };

  const setRawContentMaxChars = (value: number) => {
    if (Number.isFinite(value)) onChange({ rawContentMaxChars: Math.min(120000, Math.max(2000, Math.round(value))) });
  };

  return (
    <div className="ai-settings">
      <div className="ai-settings-head">
        <span className="ai-settings-title">AI ANALYSIS</span>
        <span className={`ai-toggle-badge ${settings.enabled ? 'enabled' : ''}`}>{settings.enabled ? 'Enabled' : 'Off'}</span>
      </div>
      <label className="setting-row">
        <span>Enable AI analysis</span>
        <input type="checkbox" checked={settings.enabled} onChange={() => onChange({ enabled: !settings.enabled })} />
      </label>
      {settings.enabled ? (
        <>
          <label className="setting-row">
            <span>Provider</span>
            <select className="setting-select" value={settings.provider} onChange={(event) => applyPreset(event.currentTarget.value)}>
              {Object.keys(PROVIDER_PRESETS).map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="setting-field">
            <span>Base URL</span>
            <input
              type="url"
              value={settings.baseUrl}
              onChange={(event) => onChange({ baseUrl: event.currentTarget.value })}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
            />
          </label>
          <label className="setting-field">
            <span>Model</span>
            <input
              type="text"
              value={settings.model}
              onChange={(event) => onChange({ model: event.currentTarget.value })}
              placeholder="e.g. gpt-4o-mini, llama3.1, local-model"
              spellCheck={false}
            />
          </label>
          <div className="setting-field">
            <span>API key</span>
            <div className="ai-key-row">
              <input
                type="password"
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.currentTarget.value)}
                placeholder={keyPresent ? '••••••••  (saved)' : 'sk-...'}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="ghost-button"
                disabled={!keyDraft.trim()}
                onClick={() => {
                  if (keyDraft.trim()) {
                    onSetKey(keyDraft.trim());
                    setKeyDraft('');
                  }
                }}
              >
                Save
              </button>
              {keyPresent ? (
                <button type="button" className="ghost-button danger" onClick={onClearKey}>
                  Remove
                </button>
              ) : null}
            </div>
            <span className="ai-settings-note">
              Desktop: encrypted with your OS keychain via Electron safeStorage. Browser: stored in this browser's local storage (not encrypted) — use the desktop app for sensitive keys. The key is only ever sent to the base URL above.
            </span>
          </div>
          <div className="setting-field">
            <span>Organization / Project (optional)</span>
            <div className="ai-two-col">
              <input
                type="text"
                value={settings.organization ?? ''}
                onChange={(event) => onChange({ organization: event.currentTarget.value })}
                placeholder="org_..."
                spellCheck={false}
              />
              <input
                type="text"
                value={settings.project ?? ''}
                onChange={(event) => onChange({ project: event.currentTarget.value })}
                placeholder="proj_..."
                spellCheck={false}
              />
            </div>
          </div>
          <div className="ai-settings-grid">
            <label className="setting-row">
              <span>Timeout (s)</span>
              <input
                type="number"
                min={3}
                max={300}
                value={Math.round(settings.timeoutMs / 1000)}
                onChange={(event) => setTimeoutSeconds(Number(event.currentTarget.value))}
              />
            </label>
            <label className="setting-row">
              <span>Max context (chars)</span>
              <input
                type="number"
                min={4000}
                max={120000}
                step={1000}
                value={settings.maxContextChars}
                onChange={(event) => setMaxChars(Number(event.currentTarget.value))}
              />
            </label>
          </div>
          <label className="setting-row">
            <span>Stream responses</span>
            <input type="checkbox" checked={settings.stream} onChange={() => onChange({ stream: !settings.stream })} />
          </label>
          <label className="setting-row">
            <span>Auto-analyze with AI after local analysis</span>
            <input type="checkbox" checked={settings.autoRun} onChange={() => onChange({ autoRun: !settings.autoRun })} />
          </label>
          <div className="ai-raw-gate">
            <div className="ai-settings-head">
              <span className="ai-raw-badge">RAW CONTENT</span>
              <span className={`ai-toggle-badge ${settings.allowRawContent ? 'enabled' : ''}`}>
                {settings.allowRawContent ? 'Allowed' : 'Off'}
              </span>
            </div>
            <label className="setting-row">
              <span>Allow sending raw file content to AI</span>
              <input
                type="checkbox"
                checked={settings.allowRawContent}
                onChange={() => onChange({ allowRawContent: !settings.allowRawContent })}
              />
            </label>
            <p className="ai-privacy-note ai-raw-warning">
              &#9888;&#65039; Sending raw content transmits the <strong>actual text</strong> of your files
              (documents, code, logs, emails, spreadsheet excerpts, PDF text) to the configured provider. This may
              include sensitive or personal data. It is <strong>off by default</strong>, and even when allowed every
              inspection asks for explicit confirmation before anything is sent. Auto-analyze never sends raw content.
            </p>
            <label className="setting-row">
              <span>Raw content budget (chars per request)</span>
              <input
                type="number"
                min={2000}
                max={120000}
                step={1000}
                value={settings.rawContentMaxChars}
                onChange={(event) => setRawContentMaxChars(Number(event.currentTarget.value))}
              />
            </label>
          </div>
          <div className="ai-test-row">
            <button type="button" className="ghost-button" onClick={onTest} disabled={testing}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {testResult ? (
              <span className={testResult.ok ? 'ai-test-ok' : 'ai-test-fail'}>
                {testResult.ok ? `Connected${testResult.latencyMs !== undefined ? ` in ${testResult.latencyMs} ms` : ''}` : testResult.message}
              </span>
            ) : null}
          </div>
          <p className="ai-privacy-note">
            Privacy: AI receives selected analysis results (facts, findings, statistics, evidence) — never your files by default. Raw content is only ever sent when you explicitly enable it above AND confirm on each inspection. Nothing is sent until you click “Ask AI” (or enable auto-analyze, which is summary-only).
          </p>
        </>
      ) : (
        <p className="ai-settings-note">
          AI analysis is off. Local analysis works fully without it and nothing is ever sent to a provider.
        </p>
      )}
    </div>
  );
}
