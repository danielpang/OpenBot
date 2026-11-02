// Checks that an address is an OpenBots server before the app saves it, and
// waits for a server that is starting (plan 14.4). Every OpenBots server
// answers GET /healthz with `{ status: 'ok' }` and GET /api/v1/setup with
// `{ setupRequired }`; /readyz says when its database is reachable.

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; redirect?: 'manual' | 'follow' | 'error' },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class ServerCheckError extends Error {
  constructor(
    message: string,
    /** Something answered at the address, but not as an OpenBots server. */
    readonly answered = false,
  ) {
    super(message);
    this.name = 'ServerCheckError';
  }
}

export interface ServerCheck {
  url: string;
  /** No user exists yet: the first one, the owner, is created in /setup. */
  setupRequired: boolean;
}

export const CHECK_TIMEOUT_MS = 10_000;

/** Where a server opens: its setup wizard until it has a user, then sign-in. */
export function entryPath(setupRequired: boolean): '/setup' | '/sign-in' {
  return setupRequired ? '/setup' : '/sign-in';
}

async function getJson(fetch: FetchLike, url: string, timeoutMs: number) {
  const host = new URL(url).host;
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    // No redirects: a server is its own origin, and a captive portal or login
    // page somewhere else is not one.
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  } catch {
    throw new ServerCheckError(
      `Could not reach ${host}. Check the address, and that the server is running.`,
    );
  }
  const body: unknown = response.ok ? await response.json().catch(() => null) : null;
  return { response, body };
}

/** Throws ServerCheckError with a sentence to show when `url` is not an OpenBots server. */
export async function checkServer(
  fetch: FetchLike,
  url: string,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<ServerCheck> {
  const notOpenBots = new ServerCheckError(
    `${new URL(url).host} answered, but it is not an OpenBots server. Check the address.`,
    true,
  );
  const health = await getJson(fetch, new URL('/healthz', url).toString(), timeoutMs);
  if ((health.body as { status?: unknown } | null)?.status !== 'ok') throw notOpenBots;
  const setup = await getJson(fetch, new URL('/api/v1/setup', url).toString(), timeoutMs);
  const setupRequired = (setup.body as { setupRequired?: unknown } | null)?.setupRequired;
  if (typeof setupRequired !== 'boolean') throw notOpenBots;
  return { url, setupRequired };
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Polls /readyz until the server is ready; throws ServerCheckError after `timeoutMs`. */
export async function waitUntilReady(
  fetch: FetchLike,
  url: string,
  options: WaitOptions = {},
): Promise<void> {
  const {
    timeoutMs = 180_000,
    intervalMs = 2_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    const ready = await fetch(new URL('/readyz', url).toString(), {
      signal: AbortSignal.timeout(Math.min(CHECK_TIMEOUT_MS, timeoutMs)),
    })
      .then(async (r) => r.ok && ((await r.json()) as { status?: unknown }).status === 'ready')
      .catch(() => false);
    if (ready) return;
    if (now() >= deadline) {
      throw new ServerCheckError(
        'The OpenBots server started but is not ready yet. Show the logs to see why.',
      );
    }
    await sleep(intervalMs);
  }
}
