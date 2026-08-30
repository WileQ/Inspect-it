// Types for the optional LLM interpretation layer.
//
// The LLM layer is strictly optional: it consumes the structured output of the
// local analysis engine and never replaces it. Everything here is shared
// between the desktop (Electron) and browser builds.

export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

/** Non-secret provider configuration. The API key is stored separately. */
export interface LlmSettings {
  /** Master switch. Defaults to OFF. */
  enabled: boolean;
  /** Automatically ask the AI after each local analysis (explicit in settings). */
  autoRun: boolean;
  /** Display name of the provider (OpenAI, Ollama, LM Studio, Custom, ...). */
  provider: string;
  /** Provider base URL, e.g. https://api.openai.com/v1 or http://127.0.0.1:11434/v1 */
  baseUrl: string;
  /** Model name as expected by the provider. */
  model: string;
  organization?: string;
  project?: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
  /** Whether to stream the response when the provider supports it. */
  stream: boolean;
  /** Upper bound (characters) for the bounded LLM context. */
  maxContextChars: number;
  /**
   * MASTER GATE for sending raw/extracted content to the provider. OFF by
   * default. Even when enabled, every raw-content request still requires an
   * explicit per-inspection confirmation in the UI; auto-run never sends raw
   * content.
   */
  allowRawContent: boolean;
  /** Per-object cap (characters) for raw/extracted content sent to the AI. */
  rawContentMaxChars: number;
}

/** Structured AI explanation produced by the optional LLM layer. */
export interface AiExplanation {
  /** Plain-English "what this appears to be". */
  summary: string;
  /** The most important things to know (max ~5). */
  important: string[];
  /** Why it matters in context. */
  whyItMatters: string;
  /** What looks unusual, grounded in supplied evidence (max ~5). */
  unusual: string[];
  /** Concrete next steps to investigate (max ~5). */
  investigate: string[];
  /** Limitations of this interpretation. */
  limitations: string[];
  /** What is uncertain or missing. */
  uncertainty: string;
  /** Observations grounded in raw content (only present when raw content was sent). */
  contentFindings?: string[];
  /** Questions worth investigating (only present when raw content was sent). */
  questions?: string[];
  /** True when the request included raw/extracted content, not just the summary. */
  rawContentIncluded?: boolean;
  /** Number of raw-content characters included in the request. */
  rawContentChars?: number;
  providerName: string;
  model: string;
  generatedAt: string;
  /** True when the response parsed as the structured schema, false for free text. */
  structured: boolean;
  fromCache?: boolean;
  contextChars?: number;
  truncated?: boolean;
}

export type AiRunStatus = 'idle' | 'running' | 'done' | 'error';

export interface AiRunState {
  status: AiRunStatus;
  result?: AiExplanation;
  error?: string;
  streamText?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  model?: string;
}

/** Events streamed from the Electron main process for a desktop AI chat. */
export interface AiIpcEvent {
  requestId: string;
  type: 'delta' | 'done' | 'error';
  text?: string;
  content?: string;
  error?: { kind: string; message: string };
}

/** Bridge exposed by electron/preload.cjs (only present on desktop). */
export interface DesktopAiBridge {
  chat(payload: {
    requestId: string;
    baseUrl: string;
    model: string;
    messages: LlmMessage[];
    timeoutMs: number;
    stream: boolean;
    organization?: string;
    project?: string;
    maxTokens?: number;
  }): Promise<{ requestId: string }>;
  abort(requestId: string): Promise<boolean>;
  onEvent(handler: (event: AiIpcEvent) => void): () => void;
  getKey(): Promise<string | null>;
  setKey(key: string): Promise<boolean>;
  clearKey(): Promise<boolean>;
  hasKey(): Promise<boolean>;
}
