// Pure, testable OpenAI-compatible request/response helpers.
//
// These functions contain no I/O: they build the chat/completions payload and
// parse responses, including Server-Sent-Events used for streaming. They are
// shared by the browser transport, the desktop main-process transport, and the
// test suite (which uses a local mock HTTP server).
import { LlmError, messageForKind } from './errors.ts';
import type { LlmMessage } from './types.ts';

export interface ChatPayloadOptions {
  model: string;
  messages: LlmMessage[];
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
}

/** Build the JSON body for POST /chat/completions. */
export function buildChatPayload(options: ChatPayloadOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    stream: Boolean(options.stream)
  };
  if (typeof options.maxTokens === 'number' && options.maxTokens > 0) {
    payload.max_tokens = options.maxTokens;
  }
  if (typeof options.temperature === 'number') {
    payload.temperature = options.temperature;
  }
  if (options.stop && options.stop.length) {
    payload.stop = options.stop;
  }
  return payload;
}

/** Extract the assistant text from a standard (non-stream) chat completion. */
export function parseChatCompletionResponse(json: unknown): string {
  if (!json || typeof json !== 'object') {
    throw new LlmError('malformed-response', messageForKind('malformed-response'));
  }
  const record = json as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmError('empty-response', messageForKind('empty-response'));
  }
  const first = choices[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== 'object') {
    throw new LlmError('malformed-response', messageForKind('malformed-response'));
  }
  const message = first.message as Record<string, unknown> | undefined;
  const delta = first.delta as Record<string, unknown> | undefined;
  const candidate = message?.content ?? delta?.content ?? first.text;
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new LlmError('empty-response', messageForKind('empty-response'));
  }
  return candidate;
}

export interface SseEvent {
  content?: string;
  done?: boolean;
}

/**
 * Parse a single SSE line (`data: ...`) into a content delta or a done marker.
 * Returns null for non-data lines (comments, event:, heartbeat blanks).
 */
export function parseSseEvent(line: string): SseEvent | null {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed.startsWith('data:')) {
    return null;
  }
  const data = trimmed.slice(5).replace(/^ /, '');
  if (data === '[DONE]') {
    return { done: true };
  }
  if (!data) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || !choices.length) {
    return null;
  }
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const delta = first?.delta as Record<string, unknown> | undefined;
  const content = message?.content ?? delta?.content;
  if (typeof content !== 'string') {
    return null;
  }
  return { content };
}

/** Parse an error JSON body from a provider into a safe message. */
export function parseErrorBody(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed?.error?.message === 'string') {
      return parsed.error.message.slice(0, 300);
    }
  } catch {
    // Ignore: fall back to the raw text below.
  }
  const clean = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').trim();
  return clean ? clean.slice(0, 300) : '';
}

/** Normalize a provider base URL to a safe, http(s) origin + /v1-style prefix. */
export function normalizeBaseUrl(raw: string): string {
  const value = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!value) {
    throw new LlmError('configuration', messageForKind('configuration'));
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LlmError('configuration', 'The provider base URL is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LlmError('configuration', 'The provider base URL must use http or https.');
  }
  return value;
}

/** Build the full chat/completions endpoint URL from a base URL. */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  return `${base}/chat/completions`;
}
