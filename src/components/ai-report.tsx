import { useState } from 'react';
import type { AiRunState, LlmSettings } from '../shared/llm/index.ts';

export interface AiReportSectionProps {
  settings: LlmSettings;
  keyPresent: boolean;
  run: AiRunState;
  onAskAi: () => void;
  onAskAiRaw: () => void;
  onCancel: () => void;
  /** True when at least one inspected object has extractable text content. */
  rawContentAvailable: boolean;
}

function ListBlock(props: { title: string; items: string[] }): JSX.Element | null {
  if (!props.items.length) return null;
  return (
    <div className="ai-block">
      <div className="ai-block-title">{props.title}</div>
      <ul className="ai-list">
        {props.items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function TextBlock(props: { title: string; text: string }): JSX.Element | null {
  if (!props.text) return null;
  return (
    <div className="ai-block">
      <div className="ai-block-title">{props.title}</div>
      <p className="ai-block-text">{props.text}</p>
    </div>
  );
}

/**
 * The optional AI interpretation section. It always sits below the local
 * report and is visually distinct (violet accents + AI badge) so AI-generated
 * text can never be mistaken for a measured local fact.
 *
 * Two modes:
 *   - Summary only: sends the bounded structured analysis (default).
 *   - Raw content: sends actual extracted file text after an explicit,
 *     well-marked confirmation (requires settings.allowRawContent).
 */
export function AiReportSection(props: AiReportSectionProps): JSX.Element {
  const { settings, keyPresent, run, onAskAi, onAskAiRaw, onCancel, rawContentAvailable } = props;
  const [confirmRaw, setConfirmRaw] = useState(false);
  return (
    <section className="report-section ai-section">
      <h2 className="report-section-title ai-title">AI INTERPRETATION</h2>
      {!settings.enabled ? (
        <p className="ai-note">AI analysis is disabled. Enable it in Settings — local analysis is unaffected.</p>
      ) : !keyPresent ? (
        <p className="ai-note">No API key configured. Add one in AI settings.</p>
      ) : run.status === 'idle' ? (
        <div className="ai-idle">
          <p className="ai-note">
            Some analysis information will be sent to your configured AI provider ({settings.provider || 'unknown'}). Summary-only sends the bounded structured analysis (facts, findings, statistics, evidence) — never your files by default.
          </p>
          <div className="ai-actions">
            <button type="button" className="primary-button" onClick={onAskAi}>
              Ask AI (summary only)
            </button>
            {settings.allowRawContent ? (
              <button
                type="button"
                className="raw-button"
                onClick={() => setConfirmRaw(true)}
                disabled={!rawContentAvailable}
                title={rawContentAvailable ? 'Send the actual file content for deep investigation' : 'No extractable text content in the inspected objects'}
              >
                Send raw content
              </button>
            ) : (
              <span className="ai-raw-disabled">Raw content is disabled — enable it in Settings → AI.</span>
            )}
          </div>
          {confirmRaw ? (
            <div className="ai-raw-confirm" role="alert">
              <p className="ai-raw-warning">
                &#9888;&#65039; <strong>Warning:</strong> you are about to send the <strong>actual content</strong> of
                your file(s) to {settings.provider || 'the configured provider'}. This may include sensitive or
                personal text, and it cannot be undone. Only extracted text is sent — never binary files.
              </p>
              <div className="ai-actions">
                <button type="button" className="ghost-button" onClick={() => setConfirmRaw(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => {
                    setConfirmRaw(false);
                    onAskAiRaw();
                  }}
                >
                  I understand — send content
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : run.status === 'running' ? (
        <div className="ai-running">
          <div className="ai-running-line">
            <span className="status-chip ai-chip">AI</span>
            <span className="ai-running-text">AI is analyzing the local report...</span>
            <button type="button" className="ghost-button danger" onClick={onCancel}>
              Cancel
            </button>
          </div>
          <div className="ai-thinking" aria-label="Working">
            <span className="ai-dot" />
            <span className="ai-dot" />
            <span className="ai-dot" />
          </div>
        </div>
      ) : run.status === 'error' ? (
        <div className="ai-error">
          <p className="ai-note">{run.error || 'The AI request failed.'}</p>
          <button type="button" className="ghost-button" onClick={onAskAi}>
            Try again
          </button>
        </div>
      ) : run.result ? (
        <div className="ai-result">
          <div className="ai-meta-line">
            <span className="badge ai-badge">AI INTERPRETATION</span>
            {run.result.fromCache ? <span className="badge">cached</span> : null}
            {!run.result.structured ? <span className="badge">free text</span> : null}
            {run.result.rawContentIncluded ? <span className="badge ai-badge">raw content</span> : null}
            <span className="ai-model">
              {run.result.model || 'model'} · {run.result.providerName || 'provider'}
            </span>
          </div>
          <p className="ai-summary">{run.result.summary}</p>
          <ListBlock title="IMPORTANT" items={run.result.important} />
          <TextBlock title="WHY IT MATTERS" text={run.result.whyItMatters} />
          <ListBlock title="WHAT LOOKS UNUSUAL" items={run.result.unusual} />
          {run.result.rawContentIncluded ? <ListBlock title="CONTENT FINDINGS" items={run.result.contentFindings ?? []} /> : null}
          <ListBlock title="WHAT TO INVESTIGATE" items={run.result.investigate} />
          {run.result.rawContentIncluded ? <ListBlock title="QUESTIONS TO INVESTIGATE" items={run.result.questions ?? []} /> : null}
          <ListBlock title="LIMITATIONS" items={run.result.limitations} />
          <TextBlock title="UNCERTAINTY" text={run.result.uncertainty} />
          <p className="ai-disclaimer">
            {run.result.rawContentIncluded
              ? 'AI-generated interpretation of the local analysis AND the actual file content you chose to send. It is not a measured fact and may be wrong; the local findings remain authoritative.'
              : 'AI-generated interpretation of the local analysis above. It is not a measured fact and may be wrong; the local findings remain authoritative.'}
          </p>
        </div>
      ) : null}
    </section>
  );
}
