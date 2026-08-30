// OpenAI-compatible provider abstraction.
//
// Analyzers never know about providers. The UI talks to this interface, and a
// provider is just a named configuration + chat implementation over the
// OpenAI-compatible chat/completions protocol. Adding a different provider
// family later means adding a new implementation of LlmProvider here without
// touching analyzers or the result schema.
import { LlmError, messageForKind } from './errors.ts';
import { normalizeBaseUrl } from './payload.ts';
import { requestLlmChat, type LlmChatOptions } from './transport.ts';
import type { ConnectionTestResult, LlmMessage, LlmSettings } from './types.ts';

export interface LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly supportsStreaming: boolean;
  chat(settings: LlmSettings, messages: LlmMessage[], options?: LlmChatOptions): Promise<string>;
  test(settings: LlmSettings): Promise<ConnectionTestResult>;
}

/** Validate a provider configuration without making any network call. */
export function validateLlmSettings(settings: LlmSettings): void {
  if (!settings.enabled) {
    throw new LlmError('configuration', 'AI analysis is disabled.');
  }
  if (!settings.model || !String(settings.model).trim()) {
    throw new LlmError('configuration', 'No model is configured. Set a model in AI settings.');
  }
  normalizeBaseUrl(settings.baseUrl); // throws a configuration error when invalid
}

function requestId(): string {
  return `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly id = 'openai-compatible';
  readonly name = 'OpenAI-compatible';
  readonly supportsStreaming = true;

  async chat(settings: LlmSettings, messages: LlmMessage[], options: LlmChatOptions = {}): Promise<string> {
    validateLlmSettings(settings);
    const result = await requestLlmChat(
      {
        requestId: requestId(),
        baseUrl: settings.baseUrl,
        model: settings.model.trim(),
        messages,
        timeoutMs: settings.timeoutMs,
        stream: settings.stream,
        organization: settings.organization,
        project: settings.project,
        maxTokens: options.maxTokens
      },
      options
    );
    return result.content;
  }

  async test(settings: LlmSettings): Promise<ConnectionTestResult> {
    if (!settings.enabled) {
      return { ok: false, message: 'AI analysis is disabled. Enable it before testing.' };
    }
    const started = Date.now();
    try {
      const content = await this.chat(
        { ...settings, stream: false },
        [{ role: 'user', content: 'Reply with exactly: OK' }],
        { maxTokens: 8 }
      );
      return {
        ok: true,
        message: content.trim().slice(0, 120) || 'Connected.',
        latencyMs: Date.now() - started,
        model: settings.model.trim()
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : messageForKind('unknown');
      return { ok: false, message, latencyMs: Date.now() - started };
    }
  }
}

export function createProvider(_settings: LlmSettings): LlmProvider {
  // Only one provider family ships in this milestone; the factory keeps the
  // door open for future families (e.g. Anthropic-compatible) without changing
  // callers.
  return new OpenAICompatibleProvider();
}

