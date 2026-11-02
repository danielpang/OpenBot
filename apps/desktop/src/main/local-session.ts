import type { ServerProfile } from '../ipc.js';
import { serverPath } from './navigation.js';
import { isSessionCookie, type SessionToken } from './tokens.js';

// This Mac has no sign-in (plan 14.4). The stack's `.env` holds
// OPENBOTS_LOCAL_TOKEN (stack/manager.ts); the main process, and only it,
// trades the token for an ordinary session cookie at the server's
// `POST /api/v1/local/session`, before the window loads the web app and again
// whenever the window lands on /sign-in or /sign-up (an expired session).
// The token goes in a header of a request made here, never into a URL, the
// window, the renderer or a log. Plain, so it is tested without Electron;
// ./index.ts wires it to the window's session.

export const LOCAL_SESSION_PATH = '/api/v1/local/session';
export const LOCAL_TOKEN_HEADER = 'x-openbots-local-token';

/** The owner's name when macOS gives none. */
export const DEFAULT_OWNER_NAME = 'Me';

/** At most one fresh session this often, so a server that keeps refusing cannot loop the window. */
export const RENEW_INTERVAL_MS = 10_000;

/** The slice of `fetch` used here. */
export type LocalFetch = (
  url: string,
  init: {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: 'manual';
  },
) => Promise<{ ok: boolean; status: number; headers: { getSetCookie(): string[] } }>;

/** The better-auth session cookie among a response's Set-Cookie headers. */
export function sessionFromSetCookie(setCookies: readonly string[]): SessionToken | null {
  for (const header of setCookies) {
    const pair = header.split(';', 1)[0]!;
    const equals = pair.indexOf('=');
    if (equals < 0) continue;
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (isSessionCookie(name) && value) return { name, value };
  }
  return null;
}

/** /sign-in and /sign-up, which a local owner never needs. */
export function isSignInPath(path: string): boolean {
  return /^\/sign-(in|up)(\/|\?|#|$)/.test(path);
}

/** The window shows This Mac's /sign-in or /sign-up: sign in again instead. */
export function needsLocalSignIn(profile: ServerProfile, pageUrl: string): boolean {
  if (profile.kind !== 'local') return false;
  const path = serverPath(pageUrl, profile.url);
  return path != null && isSignInPath(path);
}

/** The macOS user's full name from `id -F`, or "Me". */
export async function ownerName(run: () => Promise<string>): Promise<string> {
  const name = await run().then(
    (out) => out.trim(),
    () => '',
  );
  return name ? name.slice(0, 100) : DEFAULT_OWNER_NAME;
}

export interface LocalSignInOptions {
  fetch: LocalFetch;
  /** OPENBOTS_LOCAL_TOKEN from the stack's `.env`; null before the stack wrote one. */
  token: () => Promise<string | null>;
  /** The owner's name, sent for the first session (it names the owner it creates). */
  name: () => Promise<string>;
  /** Told why a sign-in did not work; never told the token. */
  log?: (message: string) => void;
  now?: () => number;
  renewIntervalMs?: number;
  timeoutMs?: number;
}

export interface LocalSignIn {
  /**
   * Before a load: the stored session while the server still takes it,
   * otherwise a fresh one. Null when there is no token or the server has no
   * local sign-in (an older release); the window then shows the usual sign-in.
   */
  ensure(serverUrl: string, stored: SessionToken | undefined): Promise<SessionToken | null>;
  /**
   * A fresh session, at most once per renew interval. Within it, the session
   * the last call got is handed out once more (the connection and the window
   * can both find the old one gone at once); after that, or when refused, null.
   */
  renew(serverUrl: string): Promise<SessionToken | null>;
}

export function createLocalSignIn(options: LocalSignInOptions): LocalSignIn {
  const { fetch } = options;
  const now = options.now ?? Date.now;
  const interval = options.renewIntervalMs ?? RENEW_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const log = options.log ?? (() => undefined);
  let lastRenew = Number.NEGATIVE_INFINITY;
  let reusable: SessionToken | null = null;

  async function request(serverUrl: string): Promise<SessionToken | null> {
    const token = await options.token().catch(() => null);
    if (!token) return null;
    let res: Awaited<ReturnType<LocalFetch>>;
    try {
      res = await fetch(new URL(LOCAL_SESSION_PATH, serverUrl).toString(), {
        method: 'POST',
        // No Origin: the server refuses this route to browsers.
        headers: { [LOCAL_TOKEN_HEADER]: token, 'content-type': 'application/json' },
        body: JSON.stringify({ name: await options.name().catch(() => DEFAULT_OWNER_NAME) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
    } catch (error) {
      log(`local sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    // 404: a release from before local sign-in, or a stack started before the token.
    if (res.status === 404) return null;
    if (!res.ok) {
      log(`local sign-in refused with ${res.status}`);
      return null;
    }
    const session = sessionFromSetCookie(res.headers.getSetCookie());
    if (!session) log('local sign-in answered without a session cookie');
    return session;
  }

  async function stillValid(serverUrl: string, stored: SessionToken): Promise<boolean> {
    return fetch(new URL('/api/v1/me', serverUrl).toString(), {
      headers: { cookie: `${stored.name}=${stored.value}` },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    }).then(
      (res) => res.ok,
      () => false,
    );
  }

  return {
    async ensure(serverUrl, stored) {
      if (stored && (await stillValid(serverUrl, stored))) return stored;
      lastRenew = now();
      reusable = null;
      return request(serverUrl);
    },

    async renew(serverUrl) {
      if (now() - lastRenew < interval) {
        const again = reusable;
        reusable = null;
        return again;
      }
      lastRenew = now();
      reusable = await request(serverUrl);
      return reusable;
    },
  };
}
