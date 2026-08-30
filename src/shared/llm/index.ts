// Public API for the optional LLM interpretation layer.
export { runAiExplanation, testAiConnection } from './analyze.ts';
export { aiCacheKeyFor, clearAiCache, getAiCached, setAiCached } from './cache.ts';
export { buildAiContext, DEFAULT_AI_BUDGET } from './context.ts';
export type { AiContextBudget, BuiltAiContext } from './context.ts';
export { LlmError, errorKindForStatus, messageForKind, toLlmError } from './errors.ts';
export type { LlmErrorKind } from './errors.ts';
export { buildChatPayload, parseChatCompletionResponse, parseSseEvent, normalizeBaseUrl, chatCompletionsUrl } from './payload.ts';
export { AI_PROMPT_VERSION, AI_SCHEMA_VERSION, AI_SYSTEM_PROMPT, buildAiUserPrompt, parseAiExplanation } from './prompt.ts';
export { OpenAICompatibleProvider, createProvider, validateLlmSettings } from './provider.ts';
export type { LlmProvider } from './provider.ts';
export {
  clearApiKey,
  DEFAULT_LLM_SETTINGS,
  getApiKey,
  hasApiKey,
  hasUsableAi,
  loadLlmSettings,
  normalizeLlmSettings,
  PROVIDER_PRESETS,
  saveLlmSettings,
  setApiKey
} from './settings.ts';
export { isDesktopEnvironment, requestLlmChat } from './transport.ts';
export type { LlmChatOptions, LlmChatRequest, LlmChatResult } from './transport.ts';
export type {
  AiExplanation,
  AiIpcEvent,
  AiRunState,
  AiRunStatus,
  ConnectionTestResult,
  DesktopAiBridge,
  LlmMessage,
  LlmRole,
  LlmSettings
} from './types.ts';
