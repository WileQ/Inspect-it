// High-level AI analysis orchestration.
//
// Flow: LOCAL ANALYSIS (already complete) -> bounded structured context ->
// optional LLM -> structured AI explanation. The local analysis is never
// blocked or replaced by this layer.
import type { AnalysisResult } from '../types.ts';
import { aiCacheKeyFor, getAiCached, setAiCached } from './cache.ts';
import { buildAiContext, buildRawContentBlock, type AiContextBudget, type RawContentInput } from './context.ts';
import { LlmError, messageForKind } from './errors.ts';
import { AI_PROMPT_VERSION, AI_RAW_SYSTEM_PROMPT, AI_SYSTEM_PROMPT, buildAiRawUserPrompt, buildAiUserPrompt, parseAiExplanation } from './prompt.ts';
import { createProvider } from './provider.ts';
import { hasApiKey } from './settings.ts';
import type { AiExplanation, ConnectionTestResult, LlmSettings } from './types.ts';

export interface RunAiOptions {
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  budget?: Partial<AiContextBudget>;
  /**
   * Raw/extracted content to include for deep investigation. Only used when
   * settings.allowRawContent is enabled and the UI showed the explicit warning.
   * Auto-run never supplies this.
   */
  rawContent?: RawContentInput[];
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
  const rawContent = options.rawContent?.filter((entry) => entry && entry.targetName);
  if (rawContent?.length && !settings.allowRawContent) {
    throw new LlmError(
      'configuration',
      'Sending raw content is disabled. Enable "Allow sending raw content" in AI settings first - it sends actual file content to the provider.'
    );
  }
  const context = buildAiContext(results, { maxChars: settings.maxContextChars, ...options.budget });
  const rawBlock = rawContent?.length ? buildRawContentBlock(rawContent, settings.rawContentMaxChars) : null;
  // Only enter raw mode when at least one object actually yielded text; a
  // folder of pure binaries degrades to summary-only (the notes are not useful
  // to the model and we never claim raw content that was not sent).
  const useRaw = Boolean(rawBlock && rawBlock.includedObjects > 0);
  const cacheKey = await aiCacheKeyFor(results, settings, rawContent);
  const cached = getAiCached(cacheKey);
  if (cached) {
    return { ...cached, fromCache: true };
  }
  const messages = useRaw && rawBlock
    ? [
        { role: 'system' as const, content: AI_RAW_SYSTEM_PROMPT },
        { role: 'user' as const, content: buildAiRawUserPrompt(context.text, rawBlock.text, results.length) }
      ]
    : [
        { role: 'system' as const, content: AI_SYSTEM_PROMPT },
        { role: 'user' as const, content: buildAiUserPrompt(context.text, results.length) }
      ];
  const raw = await provider.chat(settings, messages, { signal: options.signal, onDelta: options.onDelta });
  const explanation = parseAiExplanation(raw, {
    providerName: settings.provider,
    model: settings.model,
    contextChars: context.chars + (rawBlock?.chars ?? 0),
    truncated: context.truncated || Boolean(rawBlock?.truncated),
    rawContentIncluded: useRaw,
    rawContentChars: useRaw ? rawBlock?.chars : undefined
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

