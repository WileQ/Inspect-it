// AI result cache.
//
// An AI result is only reusable when BOTH the local evidence and the exact
// provider configuration it was produced with are unchanged:
//   - local analysis fingerprint (result.cacheKey)
//   - provider base URL + model
//   - relevant configuration (context budget, streaming, organization/project)
//   - prompt/schema version
//
// API keys are never cached. This cache stores structured explanations only.
import type { AnalysisResult } from '../types.ts';
import { storageGet, storageSet } from '../storage.ts';
import { digestHex } from '../utils.ts';
import { AI_PROMPT_VERSION, AI_SCHEMA_VERSION } from './prompt.ts';
import type { RawContentInput } from './context.ts';
import type { AiExplanation, LlmSettings } from './types.ts';

export const AI_CACHE_STORAGE_KEY = 'inspect-this.ai-cache';
const AI_CACHE_MAX_ENTRIES = 40;

function readCache(): Record<string, AiExplanation> {
  const raw = storageGet(AI_CACHE_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, AiExplanation>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, AiExplanation>): void {
  try {
    storageSet(AI_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Cache writes are best-effort.
  }
}

/** Compute the stable cache key for a set of local results + provider config. */
export async function aiCacheKeyFor(results: AnalysisResult[], settings: LlmSettings, rawContent?: RawContentInput[]): Promise<string> {
  const fingerprints = results
    .map((result) => result.cacheKey || result.identity.fingerprint || result.identity.name)
    .join('|');
  const rawFingerprint = rawContent?.length
    ? await digestHex(new TextEncoder().encode(rawContent.map((entry) => `${entry.targetName}|${entry.note ?? ''}|${entry.content.slice(0, 4000)}`).join('\n')))
    : '';
  const mode = rawContent?.length ? `raw:${rawFingerprint}` : 'summary-only';
  const payload = [
    'ai',
    `p${AI_PROMPT_VERSION}`,
    `s${AI_SCHEMA_VERSION}`,
    fingerprints,
    settings.baseUrl.trim().toLowerCase(),
    settings.model.trim(),
    settings.maxContextChars,
    settings.stream ? 'stream' : 'plain',
    settings.organization ?? '',
    settings.project ?? '',
    mode
  ].join('|');
  return digestHex(new TextEncoder().encode(payload));
}

export function getAiCached(key: string): AiExplanation | null {
  const cache = readCache();
  return cache[key] ?? null;
}

export function setAiCached(key: string, value: AiExplanation): void {
  const cache = readCache();
  const entries = Object.entries(cache);
  if (!cache[key] && entries.length >= AI_CACHE_MAX_ENTRIES) {
    // Evict the oldest entry to keep the cache bounded.
    const oldest = entries.sort((a, b) => (a[1].generatedAt < b[1].generatedAt ? -1 : 1))[0];
    if (oldest) delete cache[oldest[0]];
  }
  cache[key] = value;
  writeCache(cache);
}

export function clearAiCache(): void {
  writeCache({});
}
