import { vi } from 'vitest';
import type { FetchLike } from './server-check.js';

// Test helpers: a fetch that answers from a table, for the server checks and
// the launcher. Not bundled; only tests import it.

export type Answer = { status: number; body?: unknown } | 'down';

/** A fetch that answers each URL from a table, and refuses the rest like a closed port. */
export function fakeFetch(routes: Record<string, Answer | Answer[]>) {
  const seen = new Map<string, number>();
  const fetch = vi.fn<FetchLike>(async (url) => {
    const entry = routes[url];
    const n = seen.get(url) ?? 0;
    seen.set(url, n + 1);
    const answer = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry;
    if (answer == null || answer === 'down') throw new TypeError('fetch failed');
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => {
        if (answer.body === undefined) throw new SyntaxError('not json');
        return answer.body;
      },
    };
  });
  return fetch;
}

/** The routes of an OpenBots server at `url`. */
export function openBotsServer(url: string, setupRequired = false) {
  return {
    [`${url}/healthz`]: { status: 200, body: { status: 'ok' } },
    [`${url}/api/v1/setup`]: { status: 200, body: { setupRequired } },
    [`${url}/readyz`]: { status: 200, body: { status: 'ready', checks: { database: 'ok' } } },
  };
}
