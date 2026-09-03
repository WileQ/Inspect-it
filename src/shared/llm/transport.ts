// Transport layer for OpenAI-compatible chat requests.
//
// Two backends share the same interface:
//  - Desktop (Electron): the request is made by the MAIN process, which holds
//    the API key (encrypted via safeStorage) and streams deltas back over IPC.
//    The renderer never touches the key, and there are no CORS restrictions.
//  - Browser: a direct fetch from the renderer using the key from local
//    storage. CORS applies (the provider must permit it), which is expected.
import { LlmError, errorKindForStatus, messageForKind, toLlmError } from './errors.ts';
import {
  buildChatPayload,
  chatCompletionsUrl,
  parseChatCompletionResponse,
  parseErrorBody,
  parseSseEvent
} from './payload.ts';
import { getApiKey } from './settings.ts';
import type { DesktopAiBridge, LlmMessage } from './types.ts';

export interface LlmChatRequest {
  requestId: string;
  baseUrl: string;
  model: string;
  messages: LlmMessage[];
  timeoutMs: number;
  stream: boolean;
  organization?: string;
  project?: string;
  maxTokens?: number;
}

export interface LlmChatResult {
  content: string;
  requestId: string;
}

export interface LlmChatOptions {
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  /** Optional token cap forwarded to the provider (used by connection tests). */
  maxTokens?: number;
}

export function isDesktopEnvironment(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { inspectItDesktop?: unknown }).inspectItDesktop);
}

/* ------------------------------------------------------------------ */
/* Desktop path: IPC to the main process                               */
/* ------------------------------------------------------------------ */

async function desktopChat(request: LlmChatRequest, options: LlmChatOptions): Promise<LlmChatResult> {
  const bridge = (window as unknown as { inspectItDesktop?: { ai?: DesktopAiBridge } }).inspectItDesktop?.ai;
  if (!bridge) {
    throw new LlmError('configuration', 'Desktop AI bridge is unavailable.');
  }
  // Subscribe BEFORE invoking chat so fast responses cannot be missed.
  return new Promise<LlmChatResult>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      void bridge.abort(request.requestId);
    };
    const unsubscribe = bridge.onEvent((event) => {
      if (event.requestId !== request.requestId) return;
      if (event.type === 'delta') {
        options.onDelta?.(event.text ?? '');
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      if (event.type === 'done') {
        resolve({ content: event.content ?? '', requestId: request.requestId });
        return;
      }
      const kind = event.error?.kind ?? 'unknown';
      reject(new LlmError(kind as LlmError['kind'], event.error?.message ?? messageForKind(kind as LlmError['kind'])));
    });
    const cleanup = () => {
      unsubscribe();
      options.signal?.removeEventListener('abort', onAbort);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    void bridge
      .chat({
        requestId: request.requestId,
        baseUrl: request.baseUrl,
        model: request.model,
        messages: request.messages,
        timeoutMs: request.timeoutMs,
        stream: request.stream,
        organization: request.organization,
        project: request.project,
        maxTokens: request.maxTokens
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(toLlmError(error));
      });
  });
}

/* ------------------------------------------------------------------ */
/* Browser path: direct fetch + SSE reader                             */
/* ------------------------------------------------------------------ */

async function readSseContent(
  body: ReadableStream<Uint8Array>,
  onDelta: ((delta: string) => void) | undefined
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        const event = parseSseEvent(line);
        if (event?.done) {
          return content.trim();
        }
        if (event?.content) {
          content += event.content;
          onDelta?.(event.content);
        }
      }
    }
    if (buffer) {
      const event = parseSseEvent(buffer);
      if (event?.content) {
        content += event.content;
        onDelta?.(event.content);
      }
    }
    return content.trim();
  } finally {
    reader.releaseLock?.();
  }
}

async function browserChat(request: LlmChatRequest, options: LlmChatOptions): Promise<LlmChatResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const apiKey = await getApiKey();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (request.organization) headers['OpenAI-Organization'] = request.organization;
    if (request.project) headers['OpenAI-Project'] = request.project;
    const response = await fetch(chatCompletionsUrl(request.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(
        buildChatPayload({
          model: request.model,
          messages: request.messages,
          stream: request.stream,
          maxTokens: request.maxTokens
        })
      ),
      signal: controller.signal
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const detail = parseErrorBody(bodyText);
      const kind = errorKindForStatus(response.status);
      throw new LlmError(kind, detail ? `${messageForKind(kind)} ${detail}`.trim() : messageForKind(kind), { status: response.status });
    }
    if (request.stream && response.body) {
      const content = await readSseContent(response.body, options.onDelta);
      if (!content) {
        throw new LlmError('empty-response', messageForKind('empty-response'));
      }
      return { content, requestId: request.requestId };
    }
    const json = await response.json().catch(() => null);
    const content = parseChatCompletionResponse(json);
    return { content, requestId: request.requestId };
  } catch (error) {
    if (timedOut) {
      throw new LlmError('timeout', messageForKind('timeout'), { cause: error });
    }
    if (options.signal?.aborted || controller.signal.aborted) {
      throw new LlmError('cancelled', messageForKind('cancelled'), { cause: error });
    }
    throw toLlmError(error);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function requestLlmChat(request: LlmChatRequest, options: LlmChatOptions = {}): Promise<LlmChatResult> {
  if (isDesktopEnvironment()) {
    return desktopChat(request, options);
  }
  return browserChat(request, options);
}

