// High-level AI analysis orchestration.
//
// Flow: LOCAL ANALYSIS (already complete) -> bounded structured context ->
// optional LLM -> structured AI explanation. The local analysis is never
// blocked or replaced by this layer.
import type { AnalysisResult } from '../types.ts';
import { aiCacheKeyFor, getAiCached, setAiCached } from './cache.ts';
import { buildAiContext, type AiContextBudget } from './context.ts';
import { LlmError, messageForKind } from './errors.ts';
import { AI_PROMPT_VERSION, AI_SYSTEM_PROMPT, buildAiUserPrompt, parseAiExplanation } from './prompt.ts';
import { createProvider } from './provider.ts';
import { hasApiKey } from './settings.ts';
import type { AiExplanation, ConnectionTestResult, LlmSettings } from './types.ts';

export interface RunAiOptions {
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  budget?: Partial<AiContextBudget>;
}

/**
 * Run the optional AI explanation for one or more local analysis results.
 * Returns a cached explanation when the exact (evidence, provider, model,
 * config, schema) combination has been seen before; otherwise calls the
 * provider with bounded structured context only.
 */
export async function runAiExplanation(results: AnalysisResult[], settings: LlmSettings, options: RunAiOptions = {}): Promise<AiExplanation> {
  if (!settings.enabled) {
    throw new LlmError('configuration', 'AI analysis is disabled. Enable it in Settings.');
  }
  if (!results.length) {
    throw new LlmError('configuration', 'No analysis results to explain.');
  }
  if (!(await hasApiKey())) {
    throw new LlmError('configuration', 'No API key configured. Add one in AI settings.');
  }
  const provider = createProvider(settings); // validates baseUrl/model
  const context = buildAiContext(results, { maxChars: settings.maxContextChars, ...options.budget });
  const cacheKey = await aiCacheKeyFor(results, settings);
  const cached = getAiCached(cacheKey);
  if (cached) {
    return { ...cached, fromCache: true };
  }
  const messages = [
    { role: 'system' as const, content: AI_SYSTEM_PROMPT },
    { role: 'user' as const, content: buildAiUserPrompt(context.text, results.length) }
  ];
  const raw = await provider.chat(settings, messages, { signal: options.signal, onDelta: options.onDelta });
  const explanation = parseAiExplanation(raw, {
    providerName: settings.provider,
    model: settings.model,
    contextChars: context.chars,
    truncated: context.truncated
  });
  setAiCached(cacheKey, explanation);
  return { ...explanation, fromCache: false };
}

/** Test the configured provider connection with a tiny request. */
export async function testAiConnection(settings: LlmSettings): Promise<ConnectionTestResult> {
  if (!settings.enabled) {
    return { ok: false, message: 'AI analysis is disabled. Enable it before testing.' };
  }
  if (!(await hasApiKey())) {
    return { ok: false, message: 'No API key configured.' };
  }
  try {
    const provider = createProvider(settings);
    return await provider.test(settings);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : messageForKind('unknown') };
  }
}

export { AI_PROMPT_VERSION };

