import type { AiRunState, LlmSettings } from '../shared/llm/index.ts';

export interface AiReportSectionProps {
  settings: LlmSettings;
  keyPresent: boolean;
  run: AiRunState;
  onAskAi: () => void;
  onCancel: () => void;
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
 */
export function AiReportSection(props: AiReportSectionProps): JSX.Element {
  const { settings, keyPresent, run, onAskAi, onCancel } = props;
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
            Some analysis information will be sent to your configured AI provider ({settings.provider || 'unknown'}). Only the bounded structured analysis is sent — never your files by default.
          </p>
          <button type="button" className="primary-button" onClick={onAskAi}>
            Ask AI
          </button>
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
            <span className="ai-model">
              {run.result.model || 'model'} · {run.result.providerName || 'provider'}
            </span>
          </div>
          <p className="ai-summary">{run.result.summary}</p>
          <ListBlock title="IMPORTANT" items={run.result.important} />
          <TextBlock title="WHY IT MATTERS" text={run.result.whyItMatters} />
          <ListBlock title="WHAT LOOKS UNUSUAL" items={run.result.unusual} />
          <ListBlock title="WHAT TO INVESTIGATE" items={run.result.investigate} />
          <ListBlock title="LIMITATIONS" items={run.result.limitations} />
          <TextBlock title="UNCERTAINTY" text={run.result.uncertainty} />
          <p className="ai-disclaimer">
            AI-generated interpretation of the local analysis above. It is not a measured fact and may be wrong; the local findings remain authoritative.
          </p>
        </div>
      ) : null}
    </section>
  );
}
