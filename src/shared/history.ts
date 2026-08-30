import type { AppSettings, AnalysisResult, HistoryEntry } from './types.ts';
import { storageGet, storageSet } from './storage.ts';

const HISTORY_KEY = 'inspect-this.history';
const CACHE_KEY = 'inspect-this.cache';
const SETTINGS_KEY = 'inspect-this.settings';

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
