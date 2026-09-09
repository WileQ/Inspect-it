import { analyzeItem, fingerprintItem } from './analyzers.ts';
import { appendHistory, getCachedResult, setCachedResult } from './history.ts';
import type { InspectionItem, AnalysisResult, AnalysisSession, HistoryEntry, ProgressSnapshot } from './types.ts';

export interface RunInspectionOptions {
  target: InspectionItem;
  signal: AbortSignal;
  onProgress: (progress: ProgressSnapshot) => void;
  onPartial: (result: Partial<AnalysisResult>) => void;
  onState: (session: AnalysisSession) => void;
  /** Allow returning a cached result. URL submissions set this false so retries always re-fetch. */
  allowCache?: boolean;
}

function sessionId(): string {
  return `inspect-${Math.random().toString(36).slice(2, 10)}`;
}

export async function runInspection(options: RunInspectionOptions): Promise<AnalysisResult> {
  const target = options.target;
  const fingerprint = await fingerprintItem(target);
  const cacheKey = `${target.kind}:${fingerprint}`;
  const cached = options.allowCache === false ? undefined : getCachedResult(cacheKey);
  if (cached) {
    const cacheEvidence = [
      { id: 'analysis-cache', label: 'Analysis source', value: 'CACHE_HIT (cached result returned; not re-run)' }
    ];
    if (target.kind === 'url') {
      cacheEvidence.push({ id: 'web-fresh-marker', label: 'Fresh analysis', value: 'no (CACHE_HIT)' });
    }
    const marked = { ...cached, evidence: [...cacheEvidence, ...(cached.evidence || [])] };
    options.onPartial(marked);
    return marked;
  }
  const session: AnalysisSession = {
    id: sessionId(),
    target,
    status: 'running',
    startedAt: Date.now(),
    progress: { completed: 0, total: 4, step: 'Starting analysis' }
  };
  options.onState(session);
  const result = await analyzeItem(target, {
    signal: options.signal,
    onProgress: (progress) => {
      session.progress = progress;
      options.onProgress(progress);
      options.onState({ ...session });
    },
    onPartial: (partial) => {
      options.onPartial(partial);
    }
  });
  // Store the cache under a single stable key (kind + fingerprint) and surface that
  // same key on the result so lookups and history deduplication stay consistent.
  const finalCacheKey = cacheKey;
  const finalResult = { ...result, cacheKey: finalCacheKey, identity: { ...result.identity, fingerprint: result.identity.fingerprint || fingerprint.slice(0, 12) } };
  setCachedResult(finalCacheKey, finalResult);
  const findingIds = [...(finalResult.unusual || []), ...(finalResult.important || [])].map((f) => f.id);
  const ocrUsed = findingIds.includes('pdf-ocr-text-recovered') || (finalResult.evidence || []).some((entry) => entry.id === 'pdf-ocr-words' || entry.id === 'image-ocr' || entry.id === 'pdf-ocr-status');
  const historyEntry: HistoryEntry = {
    id: session.id,
    targetName: finalResult.targetName,
    analyzerName: finalResult.analyzerName,
    cacheKey: finalCacheKey,
    fingerprint,
    summary: finalResult.sourceSummary,
    result: finalResult,
    createdAt: Date.now(),
    status: 'completed',
    durationMs: session.startedAt ? Date.now() - session.startedAt : undefined,
    ocrUsed,
    llmUsed: false
  };
  appendHistory(historyEntry);
  options.onState({
    ...session,
    status: 'completed',
    finishedAt: Date.now(),
    result: finalResult
  });
  return finalResult;
}
