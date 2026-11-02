import { APICallError } from 'ai';

// Failure classification (plan 5.7). Rate limits and 5xx are retried with
// backoff by the AI SDK itself (`maxRetries`); a context overflow gets one
// rebuild with a smaller history window; everything else fails the run.

const OVERFLOW = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /prompt is too long/i,
  /context window/i,
  /too many (input )?tokens/i,
  /input is too long/i,
  /request too large/i,
];

export function isContextOverflow(error: unknown): boolean {
  const text = [
    error instanceof Error ? error.message : String(error),
    APICallError.isInstance(error) ? (error.responseBody ?? '') : '',
  ].join(' ');
  if (APICallError.isInstance(error) && error.statusCode === 413) return true;
  return OVERFLOW.some((re) => re.test(text));
}

export function isRetryable(error: unknown): boolean {
  return APICallError.isInstance(error) && error.isRetryable;
}

/** One line for the transcript's event row and `runs.error`. */
export function describeError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ? ` (${error.statusCode})` : '';
    return `The model provider returned an error${status}: ${error.message}`.slice(0, 500);
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

export class ContextOverflowError extends Error {
  constructor(override readonly cause: unknown) {
    super('The conversation is too long for this model');
    this.name = 'ContextOverflowError';
  }
}
