import createFetchClient from 'openapi-fetch';
import type { components, paths } from './schema.js';

export type Problem = components['schemas']['Problem'];
export type Client = ReturnType<typeof createClient>;

/**
 * The typed REST client for `/api/v1`, generated from `openapi.json`. It sends
 * the session cookie, so a browser signed in through `/api/auth` is
 * authenticated. `baseUrl` is the server origin; '' means same origin.
 */
export function createClient(baseUrl: string, fetchImpl?: typeof fetch) {
  return createFetchClient<paths>({ baseUrl, credentials: 'include', fetch: fetchImpl });
}

/** An error response from the API, carrying its problem document. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, problem: Partial<Problem> | undefined) {
    super(problem?.detail ?? problem?.title ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = problem?.code;
  }
}

/** Resolves to the response body, or throws `ApiError` for a non-2xx response. */
export async function unwrap<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await request;
  if (!response.ok) throw new ApiError(response.status, error as Partial<Problem> | undefined);
  return data as T;
}
