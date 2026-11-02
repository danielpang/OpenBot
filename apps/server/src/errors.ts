import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from '@hono/zod-openapi';

// Errors become RFC 9457 problem documents (`application/problem+json`).
// Route code throws a DomainError; the app's error handler renders it.

export class DomainError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    /** Stable machine-readable code, e.g. `INVITE_REQUIRED`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const unauthorized = (message = 'Sign in or send an API key') =>
  new DomainError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Not allowed') => new DomainError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found') => new DomainError(404, 'NOT_FOUND', message);

export const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    code: z.string().optional(),
    issues: z
      .array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }))
      .optional(),
  })
  .openapi('Problem');

export type Problem = z.infer<typeof ProblemSchema>;

export function problem(
  status: number,
  title: string,
  extra: Omit<Problem, 'type' | 'title' | 'status'> = {},
): Problem {
  return { type: 'about:blank', title, status, ...extra };
}

export function zodProblem(error: z.ZodError): Problem {
  return problem(400, 'Invalid request', {
    code: 'VALIDATION_FAILED',
    detail: error.issues.map((i) => i.message).join('; '),
    issues: error.issues.map((i) => ({
      path: i.path.filter((p): p is string | number => typeof p !== 'symbol'),
      message: i.message,
    })),
  });
}
