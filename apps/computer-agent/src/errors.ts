import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

// Errors become RFC 9457 problem documents, the same shape the server uses.

export class AgentError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    /** Stable machine-readable code, e.g. `SCREEN_NOT_RUNNING`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST') =>
  new AgentError(400, code, message);
export const notFound = (message = 'Not found', code = 'NOT_FOUND') =>
  new AgentError(404, code, message);

export const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Content',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
};

export function problemResponse(c: Context, err: unknown): Response {
  if (err instanceof ZodError) {
    return c.json(
      {
        type: 'about:blank',
        title: TITLES[400],
        status: 400,
        code: 'VALIDATION_FAILED',
        detail: 'The request body is not valid',
        issues: err.issues.map((i) => ({
          path: i.path.filter((p) => typeof p !== 'symbol'),
          message: i.message,
        })),
      },
      400,
      { 'content-type': 'application/problem+json' },
    );
  }
  const status: ContentfulStatusCode =
    err instanceof AgentError ? err.status : err instanceof HTTPException ? err.status : 500;
  const code =
    err instanceof AgentError ? err.code : status === 500 ? 'INTERNAL' : 'HTTP_' + status;
  const detail = err instanceof Error ? err.message : String(err);
  return c.json(
    { type: 'about:blank', title: TITLES[status] ?? 'Error', status, code, detail },
    status,
    { 'content-type': 'application/problem+json' },
  );
}
