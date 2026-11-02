import {
  createAuthClient,
  createClient,
  createWsClient,
  unwrap,
  type WsClient,
  type WsClientOptions,
} from '@openbots/api-client';
import { queryOptions } from '@tanstack/react-query';

// The one REST client and auth client the app uses. Same origin: the server
// serves the app in production and Vite proxies /api and /ws in development.

const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;

export const api = createClient(origin);
export const auth = createAuthClient(origin);

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: () => unwrap(api.GET('/api/v1/me')),
  staleTime: 60_000,
});

export const capabilitiesQuery = queryOptions({
  queryKey: ['capabilities'],
  queryFn: () => unwrap(api.GET('/api/v1/capabilities')),
  staleTime: Infinity,
});

/** The realtime client on `/ws` of the same origin; the session cookie authenticates it. */
export function createRealtime(options: Omit<WsClientOptions, 'url'> = {}): WsClient {
  return createWsClient({ ...options, url: wsUrl(origin) });
}

export function wsUrl(base: string): string {
  const url = new URL('/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
