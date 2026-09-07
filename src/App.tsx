import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { AiReportSection } from './components/ai-report.tsx';
import { AiSettingsSection } from './components/ai-settings.tsx';
import { itemsFromDropEvent, itemsFromFileList } from './shared/files.ts';
import { loadHistory, loadSettings, saveSettings } from './shared/history.ts';
import { runInspection } from './shared/inspection.ts';
import {
  aiCacheKeyFor,
  clearApiKey,
  extractRawContentForAi,
  getAiCached,
  hasApiKey,
  loadLlmSettings,
  runAiExplanation,
  saveLlmSettings,
  setApiKey,
  testAiConnection
} from './shared/llm/index.ts';
import type { AiRunState, ConnectionTestResult, LlmSettings } from './shared/llm/index.ts';
import { APP_DESCRIPTION, APP_LICENSE, APP_NAME, APP_REPOSITORY_URL, APP_VERSION } from './shared/app-meta.ts';
import type { AnalysisResult, AnalysisSession, Finding, HistoryEntry, InspectionItem } from './shared/types.ts';
import { formatBytes } from './shared/utils.ts';

type Mode = 'bubble' | 'panel';

type RunState = {
  controller?: AbortController;
};

const emptyProgress = { completed: 0, total: 1, step: 'Idle' };

function evidenceById(result: AnalysisResult): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of result.evidence) {
    map.set(item.id, `${item.label}: ${item.value}`);
  }
  for (const section of result.sections) {
    for (const item of section.items) {
      if (!map.has(item.id)) {
        map.set(item.id, `${item.label}: ${item.value}`);
      }
    }
  }
  return map;
}

function humanizeId(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

const EXTRACTABLE_TEXT_PATTERN =
  /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ini|toml|yaml|yml|xml|html?|eml|ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|cpp|cxx|c|h|hpp|php|rb|sh|bat|ps1|sql|css|scss|less|properties|env|gradle|pdf)$/i;

function itemHasExtractableText(item: InspectionItem): boolean {
  if (item.kind === 'file') {
    return EXTRACTABLE_TEXT_PATTERN.test(item.name) || /^(dockerfile|makefile|gemfile|procfile)$/i.test(item.name);
  }
  if (item.kind === 'folder') {
    return item.children.some(itemHasExtractableText);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Icons (inline SVG - render on every system)                        */
/* ------------------------------------------------------------------ */

type IconProps = {
  size?: number;
  className?: string;
};

function SparkIcon({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor">
      <path d="M12 1.5 L14 10 L22.5 12 L14 14 L12 22.5 L10 14 L1.5 12 L10 10 Z" />
    </svg>
  );
}

function CloseIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M6 6 L18 18 M18 6 L6 18" />
    </svg>
  );
}

function ChevronIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9 L12 15 L18 9" />
    </svg>
  );
}

function SlidersIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 7 h9 M19 7 h1" fill="none" />
      <path d="M4 12 h4 M14 12 h6" fill="none" />
      <path d="M4 17 h11 M19 17 h1" fill="none" />
      <circle cx="15.5" cy="7" r="2.1" />
      <circle cx="11.5" cy="12" r="2.1" />
      <circle cx="17.5" cy="17" r="2.1" />
    </svg>
  );
}

function CollapseIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 v9" />
      <path d="M8.5 7.5 l3.5 3.5 l3.5 -3.5" />
      <circle cx="12" cy="17.5" r="3.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Small atoms                                                        */
/* ------------------------------------------------------------------ */

function severityClass(severity: string): string {
  return severity || 'info';
}

function FindingRow(props: { finding: Finding; evidence: Map<string, string>; showEvidence: boolean }): JSX.Element {
  const { finding, evidence, showEvidence } = props;
  const chips = showEvidence ? finding.evidence : finding.evidence.slice(0, 2);
  return (
    <div className={`finding-row severity-${severityClass(finding.severity)}`}>
      <div className="finding-row-title">
        <strong>{finding.title}</strong>
        {finding.methodology ? <span className={`methodology methodology-${finding.methodology}`}>{finding.methodology.toUpperCase()}</span> : null}
        <span className="sev-label">{finding.severity}</span>
      </div>
      <div className="finding-row-summary">{finding.summary}</div>
      {chips.length ? (
        <div className="finding-where">
          <span className="where-label">Where to look</span>
          <div className="finding-evidence">
            {chips.map((id) => (
              <span className="evidence-chip" key={id}>{evidence.get(id) || humanizeId(id)}</span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                */
/* ------------------------------------------------------------------ */

export default function App() {
  const desktop = Boolean(window.inspectItDesktop);
  const [mode, setMode] = useState<Mode>(desktop ? 'bubble' : 'panel');
  const [session, setSession] = useState<AnalysisSession | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [dropActive, setDropActive] = useState(false);
  const [status, setStatus] = useState<'local' | 'cached' | 'running' | 'cancelled' | 'failed'>('local');
  const [progress, setProgress] = useState(emptyProgress);
  const [settings, setSettings] = useState(loadSettings());
  const [urlInput, setUrlInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const runRef = useRef<RunState>({});
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
  const resizeRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const [aiSettings, setAiSettings] = useState<LlmSettings>(() => loadLlmSettings());
  const [aiKeyPresent, setAiKeyPresent] = useState(false);
  const [aiRun, setAiRun] = useState<AiRunState>({ status: 'idle' });
  const [aiTest, setAiTest] = useState<{ testing: boolean; result: ConnectionTestResult | null }>({ testing: false, result: null });
  const aiRunRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!desktop || !window.inspectItDesktop) {
      return;
    }
    let disposed = false;
    window.inspectItDesktop.getWindowState().then((state) => {
      if (disposed) {
        return;
      }
      setMode(state.expanded ? 'panel' : 'bubble');
      setSettings((current) => ({
        ...current,
        bubbleX: state.bubbleState.x,
        bubbleY: state.bubbleState.y,
        bubbleWidth: state.bubbleState.width,
        bubbleHeight: state.bubbleState.height,
        panelMode: state.expanded
      }));
    });
    const unsubscribe = window.inspectItDesktop.onModeChange((nextMode) => {
      setMode(nextMode);
      setSettings((current) => ({ ...current, panelMode: nextMode === 'panel' }));
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [desktop]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // Restore the launch-at-login preference from the OS (desktop only).
  useEffect(() => {
    if (!desktop) {
      return;
    }
    let disposed = false;
    void window.inspectItDesktop
      ?.getAutoLaunch()
      .then((enabled) => {
        if (!disposed) {
          setSettings((current) => ({ ...current, launchAtLogin: Boolean(enabled) }));
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [desktop]);

  useEffect(() => {
    saveLlmSettings(aiSettings);
  }, [aiSettings]);

  useEffect(() => {
    let disposed = false;
    void hasApiKey().then((present) => {
      if (!disposed) setAiKeyPresent(present);
    });
    return () => {
      disposed = true;
    };
  }, []);

  // Reset the AI section when a new local result appears, then surface a cached
  // AI explanation (same local evidence + same provider/model/config) without
  // making a network call.
  useEffect(() => {
    if (!result) {
      setAiRun({ status: 'idle' });
      return;
    }
    let disposed = false;
    if (aiRunRef.current) {
      // An AI request is already in flight for this result; do not reset it.
      return () => {
        disposed = true;
      };
    }
    setAiRun({ status: 'idle' });
    if (!aiSettings.enabled) {
      return () => {
        disposed = true;
      };
    }
    void (async () => {
      const key = await aiCacheKeyFor([result], aiSettings);
      const cached = getAiCached(key);
      if (cached && !disposed) {
        setAiRun({ status: 'done', result: { ...cached, fromCache: true } });
      }
    })();
    return () => {
      disposed = true;
    };
  }, [result, aiSettings.enabled, aiSettings.baseUrl, aiSettings.model, aiSettings.maxContextChars, aiSettings.stream, aiSettings.organization, aiSettings.project]);

  const activeEvidence = useMemo(() => (result ? evidenceById(result) : new Map<string, string>()), [result]);
  const rawContentAvailable = useMemo(() => (session?.target ? itemHasExtractableText(session.target) : false), [session?.target]);

  const isRunning = session?.status === 'running';
  const showHistory = Boolean(settings.showHistory);
  const showDetails = detailsOpen || Boolean(settings.detailedReport);

  const openFiles = async (files: FileList) => {
    const items = await itemsFromFileList(files);
    if (items.length) {
      await startInspection(items);
    }
  };

  const inspectUrl = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return;
    }
    const target: InspectionItem = {
      kind: 'url',
      name: url.hostname,
      path: url.href,
      url: url.href
    };
    setUrlInput(url.href);
    await startInspection([target]);
  };

  const openDroppedOnBubble = async (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropActive(false);
    const items = await itemsFromDropEvent(event.nativeEvent);
    if (!items.length) {
      return;
    }
    if (desktop && mode === 'bubble') {
      await window.inspectItDesktop?.setExpanded(true);
      setMode('panel');
    }
    await startInspection(items);
  };

  const openDroppedOnPanel = async (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropActive(false);
    const items = await itemsFromDropEvent(event.nativeEvent);
    if (items.length) {
      await startInspection(items);
    }
  };

  const startInspection = async (items: InspectionItem[]) => {
    if (!items.length) {
      return;
    }
    const target = items.length === 1 ? items[0] : {
      kind: 'folder',
      name: `Selection (${items.length})`,
      path: `selection://${items.length}`,
      children: items
    } satisfies InspectionItem;

    runRef.current.controller?.abort();
    aiRunRef.current?.abort();
    setAiRun({ status: 'idle' });
    const controller = new AbortController();
    runRef.current = { controller };
    setResult(null);
    setStatus('running');
    setProgress({ completed: 0, total: 1, step: 'Preparing inspection' });
    setSession({
      id: `session-${Date.now()}`,
      target,
      status: 'running',
      startedAt: Date.now(),
      progress: { completed: 0, total: 1, step: 'Preparing inspection' }
    });
    if (desktop && mode === 'bubble') {
      await window.inspectItDesktop?.setExpanded(true);
      setMode('panel');
    }
    try {
      const analyzed = await runInspection({
        target,
        signal: controller.signal,
        onProgress: (next) => {
          setProgress(next);
          setSession((current) => (current ? { ...current, progress: next } : current));
        },
        onPartial: (partial) => {
          setResult((current) => (current ? { ...current, ...partial } as AnalysisResult : (partial as AnalysisResult)));
        },
        onState: (next) => {
          setSession(next);
        }
      });
      setResult(analyzed);
      setHistory(loadHistory());
      setStatus('local');
      setSession((current) => (current ? {
        ...current,
        status: 'completed',
        finishedAt: Date.now(),
        result: analyzed
      } : current));
      if (aiSettings.autoRun && aiSettings.enabled && aiKeyPresent) {
        void askAi();
      }
    } catch (error) {
      if (runRef.current.controller !== controller) {
        // A newer inspection superseded this one; ignore the stale outcome.
        return;
      }
      const message = error instanceof Error ? error.message : 'Analysis failed';
      if ((error as DOMException)?.name === 'AbortError' || message.toLowerCase().includes('cancel')) {
        setStatus('cancelled');
        setProgress((current) => ({ ...current, step: 'Cancelled' }));
        setSession((current) => (current ? { ...current, status: 'cancelled', finishedAt: Date.now() } : current));
      } else {
        setStatus('failed');
        setSession((current) => (current ? { ...current, status: 'failed', error: message, finishedAt: Date.now() } : current));
      }
    } finally {
      if (runRef.current.controller === controller) {
        runRef.current = {};
      }
    }
  };

  const cancelInspection = () => {
    runRef.current.controller?.abort();
    setStatus('cancelled');
    setProgress((current) => ({ ...current, step: 'Cancelled' }));
    setSession((current) => (current ? { ...current, status: 'cancelled', finishedAt: Date.now() } : current));
  };

  const askAi = async (raw = false) => {
    if (!result) {
      return;
    }
    if (!aiSettings.enabled) {
      setAiRun({ status: 'error', error: 'AI analysis is disabled. Enable it in Settings.' });
      return;
    }
    if (!aiKeyPresent) {
      setAiRun({ status: 'error', error: 'No API key configured. Add one in Settings -> AI.' });
      return;
    }
    if (raw && !aiSettings.allowRawContent) {
      setAiRun({ status: 'error', error: 'Sending raw content is disabled. Enable "Allow sending raw file content to AI" in Settings -> AI first.' });
      return;
    }
    if (raw && !session?.target) {
      setAiRun({ status: 'error', error: 'No inspected object is available to send.' });
      return;
    }
    aiRunRef.current?.abort();
    const controller = new AbortController();
    aiRunRef.current = controller;
    setAiRun({ status: 'running', streamText: '' });
    try {
      let rawContent: Awaited<ReturnType<typeof extractRawContentForAi>> | undefined;
      if (raw && session?.target) {
        rawContent = await extractRawContentForAi([session.target], controller.signal);
      }
      const explanation = await runAiExplanation([result], aiSettings, {
        signal: controller.signal,
        ...(rawContent?.length ? { rawContent } : {})
      });
      setAiRun({ status: 'done', result: explanation });
    } catch (error) {
      if (controller.signal.aborted) {
        setAiRun({ status: 'idle' });
        return;
      }
      setAiRun({ status: 'error', error: error instanceof Error ? error.message : 'The AI request failed.' });
    } finally {
      if (aiRunRef.current === controller) {
        aiRunRef.current = null;
      }
    }
  };

  const cancelAi = () => {
    aiRunRef.current?.abort();
    setAiRun({ status: 'idle' });
  };

  const updateAiSettings = (patch: Partial<LlmSettings>) => {
    setAiSettings((current) => ({ ...current, ...patch }));
  };

  const handleSetAiKey = async (key: string) => {
    await setApiKey(key);
    setAiKeyPresent(Boolean(key));
  };

  const handleClearAiKey = async () => {
    await clearApiKey();
    setAiKeyPresent(false);
  };

  const handleTestAi = async () => {
    setAiTest({ testing: true, result: null });
    const outcome = await testAiConnection(aiSettings);
    setAiTest({ testing: false, result: outcome });
  };

  const reopenHistory = (entry: HistoryEntry) => {
    runRef.current.controller?.abort();
    setResult(entry.result);
    setStatus('cached');
    setProgress({ completed: 1, total: 1, step: 'Loaded from history' });
    setSession({
      id: entry.id,
      target: entry.result.objectKind === 'folder'
        ? {
            kind: 'folder',
            name: entry.result.targetName,
            path: entry.result.identity.location,
            children: []
          }
        : entry.result.objectKind === 'url'
          ? {
              kind: 'url',
              name: entry.result.targetName,
              path: entry.result.identity.location,
              url: entry.result.identity.location
            }
        : {
            kind: 'file',
            name: entry.result.targetName,
            path: entry.result.identity.location,
            size: entry.result.identity.size,
            lastModified: Date.now(),
            mimeType: entry.result.identity.mimeType,
            file: new File([], entry.result.targetName)
          },
      result: entry.result,
      status: 'completed',
      startedAt: entry.createdAt,
      finishedAt: entry.createdAt,
      progress: { completed: 1, total: 1, step: 'Loaded from history' }
    });
    if (desktop) {
      setMode('panel');
      window.inspectItDesktop?.setExpanded(true);
    }
  };

  const bubbleClick = async () => {
    if (desktop) {
      const next = mode === 'panel' ? 'bubble' : 'panel';
      await window.inspectItDesktop?.setExpanded(next === 'panel');
      setMode(next);
      return;
    }
    setMode('panel');
  };

  const closePanel = async () => {
    if (desktop) {
      setMode('bubble');
      await window.inspectItDesktop?.setExpanded(false);
      return;
    }
    setMode('bubble');
  };

  // Escape closes the settings popover first, then collapses the popup.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (settingsOpen) {
        setSettingsOpen(false);
        return;
      }
      if (mode === 'panel') {
        void closePanel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [settingsOpen, mode, closePanel]);

  const toggleSetting = (key: 'showHistory' | 'detailedReport') => {
    setSettings((current) => ({ ...current, [key]: !Boolean(current[key]) }));
  };

  const toggleLaunchAtLogin = () => {
    const next = !Boolean(settings.launchAtLogin);
    setSettings((current) => ({ ...current, launchAtLogin: next }));
    if (desktop) {
      void window.inspectItDesktop?.setAutoLaunch(next);
    }
  };

  /* Bubble dragging - handled by the main process so it works reliably. */
  const onBubblePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!desktop) {
      return;
    }
    dragRef.current = { startX: event.screenX, startY: event.screenY, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    void window.inspectItDesktop?.beginDrag();
  };

  const onBubblePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !desktop) {
      return;
    }
    const dx = event.screenX - drag.startX;
    const dy = event.screenY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      drag.moved = true;
    }
    if (drag.moved) {
      void window.inspectItDesktop?.dragBy(dx, dy);
    }
  };

  const onBubblePointerUp = async (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    void window.inspectItDesktop?.endDrag();
    if (drag && !drag.moved) {
      await bubbleClick();
    }
  };

  /* Panel resizing - drag the corner handle to adjust the open panel size. */
  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!desktop) {
      return;
    }
    resizeRef.current = { lastX: event.screenX, lastY: event.screenY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag || !desktop) {
      return;
    }
    const dx = event.screenX - drag.lastX;
    const dy = event.screenY - drag.lastY;
    if (dx === 0 && dy === 0) {
      return;
    }
    drag.lastX = event.screenX;
    drag.lastY = event.screenY;
    void window.inspectItDesktop?.panelResizeBy(dx, dy);
  };

  const onResizePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    resizeRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const renderReport = () => {
    if (!result) {
      return null;
    }
    const identity = result.identity;
    const findings = [...result.important, ...result.unusual];
    const firstSection = result.sections[0];
    const keyFacts = firstSection ? firstSection.items.slice(0, 6) : [];
    const remainingSections = result.sections.slice(1);
    const extraCount =
      remainingSections.reduce((acc, section) => acc + section.items.length, 0) +
      result.recommendations.length +
      (result.limitations?.length ?? 0) +
      (firstSection && keyFacts.length < firstSection.items.length ? firstSection.items.length - keyFacts.length : 0) +
      4;

    return (
      <div className="report">
        <div className="report-name">{identity.name}</div>
        <div className="report-meta">
          <span>{identity.type}</span>
          {identity.format && identity.format !== identity.type ? <span className="dot">/</span> : null}
          {identity.format && identity.format !== identity.type ? <span>{identity.format}</span> : null}
          <span className="dot">/</span>
          <span>{formatBytes(identity.size)}</span>
          <span className="dot">/</span>
          <span>{result.analyzerName}</span>
        </div>
        <div className="report-note">{result.sourceSummary}</div>

        {findings.length ? (
          <section className="report-section">
            <h2 className="report-section-title">Findings</h2>
            <div className="finding-list">
              {findings.map((finding) => (
                <FindingRow key={finding.id} finding={finding} evidence={activeEvidence} showEvidence={showDetails} />
              ))}
            </div>
          </section>
        ) : (
          <section className="report-section">
            <h2 className="report-section-title">Findings</h2>
            <p className="report-note">Nothing obviously unusual detected.</p>
          </section>
        )}

        {keyFacts.length ? (
          <section className="report-section">
            <h2 className="report-section-title">{firstSection.title || 'Facts'}</h2>
            <dl className="fact-list">
              {keyFacts.map((item) => (
                <div className="fact-row" key={item.id}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {!settings.detailedReport ? (
          <button type="button" className="more-button" onClick={() => setDetailsOpen(!detailsOpen)} aria-expanded={detailsOpen}>
            {showDetails ? 'Show less' : `More details (${extraCount})`}
            <ChevronIcon size={12} className={`chevron ${showDetails ? 'open' : ''}`} />
          </button>
        ) : null}

        {showDetails ? (
          <div className="report-extra">
            {firstSection && keyFacts.length < firstSection.items.length ? (
              <section className="report-section">
                <h2 className="report-section-title">{firstSection.title}</h2>
                <dl className="fact-list">
                  {firstSection.items.slice(keyFacts.length).map((item) => (
                    <div className="fact-row" key={item.id}>
                      <dt>{item.label}</dt>
                      <dd>{item.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null}

            {remainingSections.map((section) =>
              section.collapsed ? (
                <details className="report-section" key={section.id}>
                  <summary className="report-section-title report-section-summary">{section.title}</summary>
                  <dl className="fact-list">
                    {section.items.map((item) => (
                      <div className="fact-row" key={item.id}>
                        <dt>{item.label}</dt>
                        <dd>{item.value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ) : (
                <section className="report-section" key={section.id}>
                  <h2 className="report-section-title">{section.title}</h2>
                  <dl className="fact-list">
                    {section.items.map((item) => (
                      <div className="fact-row" key={item.id}>
                        <dt>{item.label}</dt>
                        <dd>{item.value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )
            )}

            {result.recommendations.length ? (
              <section className="report-section">
                <h2 className="report-section-title">Recommendations</h2>
                <div className="finding-list">
                  {result.recommendations.map((finding) => (
                    <FindingRow key={finding.id} finding={finding} evidence={activeEvidence} showEvidence={false} />
                  ))}
                </div>
              </section>
            ) : null}

            {result.limitations?.length ? (
              <section className="report-section">
                <h2 className="report-section-title">Limitations</h2>
                <p className="report-note">{result.limitations.join(' - ')}</p>
              </section>
            ) : null}

            {result.visualizations?.length ? (
              <section className="report-section">
                <h2 className="report-section-title">Visuals</h2>
                {result.visualizations.map((viz) => {
                  const max = Math.max(...viz.values, 1);
                  return (
                    <div className="viz" key={viz.id}>
                      <div className="viz-title">{viz.title}</div>
                      <div className="viz-bars">
                        {viz.labels.map((label, index) => (
                          <div className="viz-row" key={index}>
                            <span className="viz-label" title={label}>{label}</span>
                            <div className="viz-track">
                              <div className="viz-bar" style={{ width: `${Math.max(2, Math.round((viz.values[index] / max) * 100))}%` }} />
                            </div>
                            <span className="viz-value">{viz.values[index]}{viz.unit ? ` ${viz.unit}` : ''}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </section>
            ) : null}

            {result.relationships?.length ? (
              <section className="report-section">
                <h2 className="report-section-title">Relationships</h2>
                <div className="relationship-list">
                  {result.relationships.map((relationship) => (
                    <div className="relationship-item" key={relationship.id}>
                      <strong>{relationship.label}</strong>
                      <span>{relationship.detail}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="report-section">
              <h2 className="report-section-title">Identity</h2>
              <dl className="fact-list">
                <div className="fact-row"><dt>Location</dt><dd>{identity.location}</dd></div>
                <div className="fact-row"><dt>Modified</dt><dd>{identity.modified || 'Unknown'}</dd></div>
                <div className="fact-row"><dt>MIME</dt><dd>{identity.mimeType}</dd></div>
                <div className="fact-row"><dt>Fingerprint</dt><dd>{identity.fingerprint}</dd></div>
              </dl>
            </section>
          </div>
        ) : null}

        <AiReportSection
          settings={aiSettings}
          keyPresent={aiKeyPresent}
          run={aiRun}
          onAskAi={() => void askAi(false)}
          onAskAiRaw={() => void askAi(true)}
          onCancel={cancelAi}
          rawContentAvailable={rawContentAvailable}
        />
      </div>
    );
  };

  const actionBar = (
    <div className="action-bar">
      <button type="button" className="ghost-button" onClick={() => fileInputRef.current?.click()}>
        Open file
      </button>
      <button type="button" className="ghost-button" onClick={() => folderInputRef.current?.click()}>
        Open folder
      </button>
      <form
        className="url-form"
        onSubmit={(event) => {
          event.preventDefault();
          void inspectUrl(urlInput);
        }}
      >
        <input
          type="url"
          className="url-input"
          value={urlInput}
          onChange={(event) => setUrlInput(event.currentTarget.value)}
          placeholder="Website URL"
          aria-label="Website URL"
        />
        <button type="submit" className="ghost-button">Inspect</button>
      </form>
      {isRunning ? (
        <button type="button" className="ghost-button danger" onClick={cancelInspection}>
          Cancel
        </button>
      ) : null}
    </div>
  );

  if (mode === 'bubble') {
    return (
      <div
        className={`bubble-shell ${dropActive ? 'drop-active' : ''}`}
        onPointerDown={onBubblePointerDown}
        onPointerMove={onBubblePointerMove}
        onPointerUp={onBubblePointerUp}
        onDragOver={(event) => {
          event.preventDefault();
          setDropActive(true);
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={openDroppedOnBubble}
        title="Inspect It - drop anything or click"
      >
        <div className="bubble-core">
          <SparkIcon size={26} className="bubble-spark" />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`panel-shell ${dropActive ? 'drop-active' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={openDroppedOnPanel}
    >
      <header className="panel-header">
        <div className="title-group">
          <SparkIcon size={15} className="title-spark" />
          <div className="app-name">Inspect It</div>
          <span className={`privacy-pill ${aiSettings.enabled && aiKeyPresent ? 'ai' : ''}`}>
            {aiSettings.enabled && aiKeyPresent ? 'AI READY' : 'LOCAL ONLY'}
          </span>
        </div>
        <div className="header-actions">
          <button type="button" className="icon-button" onClick={() => setSettingsOpen(!settingsOpen)} title="Settings" aria-label="Settings" aria-expanded={settingsOpen}>
            <SlidersIcon size={14} />
          </button>
          {desktop ? (
            <>
              <button type="button" className="icon-button" onClick={bubbleClick} title="Collapse to bubble" aria-label="Collapse to bubble">
                <CollapseIcon size={14} />
              </button>
              <button type="button" className="icon-button" onClick={closePanel} title="Close (bubble stays available)" aria-label="Close panel">
                <CloseIcon size={14} />
              </button>
            </>
          ) : null}
        </div>
      </header>

      {settingsOpen ? (
        <div className="settings-popover">
          <div className="settings-group">
            <div className="settings-group-title">General</div>
            <label className="setting-row">
              <span>Show history</span>
              <input type="checkbox" checked={showHistory} onChange={() => toggleSetting('showHistory')} />
            </label>
            <label className="setting-row">
              <span>Detailed report</span>
              <input type="checkbox" checked={Boolean(settings.detailedReport)} onChange={() => toggleSetting('detailedReport')} />
            </label>
            {desktop ? (
              <label className="setting-row">
                <span>Start Inspect It when I log in</span>
                <input type="checkbox" checked={Boolean(settings.launchAtLogin)} onChange={toggleLaunchAtLogin} />
              </label>
            ) : null}
          </div>
          <div className="settings-divider" />
          <div className="settings-group">
            <AiSettingsSection
              settings={aiSettings}
              keyPresent={aiKeyPresent}
              testing={aiTest.testing}
              testResult={aiTest.result}
              onChange={updateAiSettings}
              onSetKey={(key) => void handleSetAiKey(key)}
              onClearKey={() => void handleClearAiKey()}
              onTest={() => void handleTestAi()}
            />
          </div>
          <div className="settings-divider" />
          <div className="settings-group">
            <div className="settings-group-title">About</div>
            <div className="about-block">
              <div className="about-name">{APP_NAME} <span className="about-version">v{APP_VERSION}</span></div>
              <p className="about-desc">{APP_DESCRIPTION}</p>
              <p className="about-meta">License: {APP_LICENSE}</p>
              {APP_REPOSITORY_URL ? (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => window.open(APP_REPOSITORY_URL, '_blank', 'noopener')}
                >
                  GitHub
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <main className="panel-body">
        {result || isRunning ? (
          <>
            {actionBar}
            {isRunning ? (
              <section className="status-bar">
                <div className="status-line">
                  <span className="status-chip">{status === 'running' ? 'Analyzing' : status.toUpperCase()}</span>
                  <span className="status-step">{progress.step}</span>
                </div>
                <div className="progress-track" aria-hidden="true">
                  <div className="progress-fill" style={{ width: `${Math.max(4, Math.min(100, (progress.completed / Math.max(progress.total, 1)) * 100))}%` }} />
                </div>
              </section>
            ) : null}
            <div className="main-column">
              {renderReport()}
              {showHistory && history.length ? (
                <section className="report-section history-section">
                  <h2 className="report-section-title">History</h2>
                  <div className="history-list">
                    {history.slice(0, 5).map((entry) => (
                      <button type="button" key={entry.id} className="history-item" onClick={() => reopenHistory(entry)}>
                        <span className="history-name">{entry.targetName}</span>
                        <span className="history-meta">{entry.analyzerName} - {entry.summary}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          </>
        ) : (
          <>
            {!settings.onboardingSeen ? (
              <section className="onboarding-card">
                <div className="onboarding-title">Drop anything onto the bubble.</div>
                <p className="onboarding-note">Inspect It analyzes it locally - your files are never modified.</p>
                <p className="onboarding-note">AI is optional. Nothing is uploaded unless you ask.</p>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setSettings((current) => ({ ...current, onboardingSeen: true }))}
                >
                  Got it
                </button>
              </section>
            ) : null}
            <section className="dropzone">
            <div className="dropzone-mark"><SparkIcon size={24} /></div>
            <div className="dropzone-title">Drop anything</div>
            <div className="dropzone-sub">Files, folders, archives, databases - analyzed locally on this device.</div>
            <div className="dropzone-actions">
              <button type="button" className="primary-button" onClick={() => fileInputRef.current?.click()}>
                Open file
              </button>
              <button type="button" className="secondary-button" onClick={() => folderInputRef.current?.click()}>
                Open folder
              </button>
            </div>
            <form
              className="url-line"
              onSubmit={(event) => {
                event.preventDefault();
                void inspectUrl(urlInput);
              }}
            >
              <input
                type="url"
                className="url-input"
                value={urlInput}
                onChange={(event) => setUrlInput(event.currentTarget.value)}
                placeholder="Paste a website link"
                aria-label="Website URL"
              />
              <button type="submit" className="ghost-button">Inspect</button>
            </form>
            <div className="dropzone-privacy">LOCAL ONLY - nothing is uploaded</div>
          </section>
          </>
        )}
      </main>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden-input"
        onChange={(event) => {
          if (event.currentTarget.files) {
            void openFiles(event.currentTarget.files);
          }
          event.currentTarget.value = '';
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden-input"
        {...({ webkitdirectory: 'true' } as any)}
        onChange={(event) => {
          if (event.currentTarget.files) {
            void openFiles(event.currentTarget.files);
          }
          event.currentTarget.value = '';
        }}
      />
      {desktop ? (
        <div
          className="resize-handle"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          title="Drag to resize"
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
