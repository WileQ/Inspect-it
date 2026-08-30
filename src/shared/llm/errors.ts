// Categorized errors for the optional LLM layer.
//
// Every failure the user can hit is mapped to a stable `kind` so the UI can
// show a useful, actionable message. Error messages never contain API keys or
// raw request bodies.

export type LlmErrorKind =
  | 'configuration'
  | 'invalid-key'
  | 'invalid-base-url'
  | 'unsupported-model'
  | 'timeout'
  | 'rate-limit'
  | 'connection'
  | 'provider-unavailable'
  | 'malformed-response'
  | 'empty-response'
  | 'oversized-request'
  | 'cancelled'
  | 'unknown';

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | undefined;

  constructor(kind: LlmErrorKind, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = options?.status;
  }
}

/** Map an HTTP status from an OpenAI-compatible endpoint to a stable kind. */
export function errorKindForStatus(status: number): LlmErrorKind {
  if (status === 401 || status === 403) return 'invalid-key';
  if (status === 404) return 'invalid-base-url';
  if (status === 408) return 'timeout';
  if (status === 413) return 'oversized-request';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'provider-unavailable';
  return 'unknown';
}

/** Human-readable, safe (no secrets) message for each kind. */
export function messageForKind(kind: LlmErrorKind, detail?: string): string {
  const base: Record<LlmErrorKind, string> = {
    configuration: 'AI analysis is not configured correctly.',
    'invalid-key': 'The API key was rejected by the provider.',
    'invalid-base-url': 'The provider endpoint could not be found. Check the base URL and model.',
    'unsupported-model': 'The provider does not support the selected model.',
    timeout: 'The AI request timed out.',
    'rate-limit': 'The provider rate limit was reached. Wait and try again.',
    connection: 'Could not reach the AI provider. Check your connection and base URL.',
    'provider-unavailable': 'The AI provider returned a server error. Try again later.',
    'malformed-response': 'The provider returned a response that could not be read.',
    'empty-response': 'The provider returned an empty response.',
    'oversized-request': 'The request was too large for the provider.',
    cancelled: 'The AI request was cancelled.',
    unknown: 'The AI request failed.'
  };
  const text = base[kind] ?? base.unknown;
  return detail && kind !== 'unknown' ? `${text} ${detail}` : text;
}

/** Coerce any thrown value into a categorized LlmError (never throws). */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) {
    return error;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new LlmError('cancelled', messageForKind('cancelled'), { cause: error });
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError' || /abort/i.test(error.message)) {
      return new LlmError('cancelled', messageForKind('cancelled'), { cause: error });
    }
    if (/fetch|network|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(error.message)) {
      return new LlmError('connection', messageForKind('connection'), { cause: error });
    }
    return new LlmError('unknown', messageForKind('unknown'), { cause: error });
  }
  return new LlmError('unknown', messageForKind('unknown'), { cause: error });
}
