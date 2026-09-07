import type { AppSettings, AnalysisResult, HistoryEntry } from './types.ts';
import { storageGet, storageSet } from './storage.ts';

const HISTORY_KEY = 'inspect-it.history';
const CACHE_KEY = 'inspect-it.cache';
const SETTINGS_KEY = 'inspect-it.settings';

function readJson<T>(key: string, fallback: T): T {
  const raw = storageGet(key);
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  storageSet(key, JSON.stringify(value));
}

export function loadHistory(): HistoryEntry[] {
  return readJson<HistoryEntry[]>(HISTORY_KEY, []);
}

export function saveHistory(entries: HistoryEntry[]): void {
  writeJson(HISTORY_KEY, entries.slice(0, 40));
}

export function appendHistory(entry: HistoryEntry): HistoryEntry[] {
  const next = [entry, ...loadHistory().filter((current) => current.cacheKey !== entry.cacheKey)];
  saveHistory(next);
  return next;
}

export function loadCache(): Record<string, AnalysisResult> {
  return readJson<Record<string, AnalysisResult>>(CACHE_KEY, {});
}

export function saveCache(cache: Record<string, AnalysisResult>): void {
  writeJson(CACHE_KEY, cache);
}

export function getCachedResult(cacheKey: string): AnalysisResult | undefined {
  return loadCache()[cacheKey];
}

export function setCachedResult(cacheKey: string, result: AnalysisResult): void {
  const cache = loadCache();
  cache[cacheKey] = result;
  saveCache(cache);
}

export function loadSettings(): AppSettings {
  return readJson<AppSettings>(SETTINGS_KEY, {});
}

export function saveSettings(settings: AppSettings): void {
  writeJson(SETTINGS_KEY, settings);
}

export interface HistorySummary {
  findingCount: number;
  bySeverity: Record<string, number>;
  ocrUsed: boolean;
  llmUsed: boolean;
}

function detectOcrUsed(result: AnalysisResult): boolean {
  const findingIds = [...(result.unusual || []), ...(result.important || [])].map((f) => f.id);
  if (findingIds.includes('pdf-ocr-text-recovered')) return true;
  return (result.evidence || []).some((entry) => entry.id === 'pdf-ocr-words' || entry.id === 'image-ocr' || entry.id === 'pdf-ocr-text' || entry.id === 'pdf-ocr-status');
}

export function summarizeHistoryEntry(entry: HistoryEntry): HistorySummary {
  const result = entry.result;
  const findings = [...(result.important || []), ...(result.unusual || []), ...(result.recommendations || [])];
  const bySeverity: Record<string, number> = {};
  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
  }
  return {
    findingCount: findings.length,
    bySeverity,
    ocrUsed: entry.ocrUsed ?? detectOcrUsed(result),
    llmUsed: entry.llmUsed ?? false
  };
}

export function removeHistoryEntry(id: string): HistoryEntry[] {
  const next = loadHistory().filter((entry) => entry.id !== id);
  saveHistory(next);
  return next;
}

export function clearHistory(): void {
  saveHistory([]);
}

/** Case-insensitive search across name, analyzer, summary and finding titles. */
export function searchHistory(entries: HistoryEntry[], query: string): HistoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((entry) => {
    const haystack = [
      entry.targetName,
      entry.analyzerName,
      entry.summary,
      ...(entry.result?.unusual || []).map((f) => f.title),
      ...(entry.result?.important || []).map((f) => f.title)
    ].join('\n').toLowerCase();
    return haystack.includes(q);
  });
}

export function sortHistory(entries: HistoryEntry[], mode: 'recent' | 'name' | 'severity'): HistoryEntry[] {
  const copy = [...entries];
  if (mode === 'name') {
    return copy.sort((a, b) => a.targetName.localeCompare(b.targetName));
  }
  if (mode === 'severity') {
    const weight: Record<string, number> = { high: 4, medium: 3, low: 2, info: 1 };
    return copy.sort((a, b) => {
      const sa = summarizeHistoryEntry(a);
      const sb = summarizeHistoryEntry(b);
      const wa = Math.max(0, ...Object.entries(sa.bySeverity).map(([sev, n]) => (weight[sev] ?? 0) * n));
      const wb = Math.max(0, ...Object.entries(sb.bySeverity).map(([sev, n]) => (weight[sev] ?? 0) * n));
      return wb - wa || b.createdAt - a.createdAt;
    });
  }
  return copy.sort((a, b) => b.createdAt - a.createdAt);
}
