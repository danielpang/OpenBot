import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

// One shared token guards every endpoint. HTTP sends `Authorization: Bearer`;
// a WebSocket upgrade may send the header or, where a client cannot set
// headers, a `token` query parameter.

const digest = (value: string) => createHash('sha256').update(value).digest();

export function tokenMatches(expected: string, given: string | undefined | null): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(expected), digest(given));
}

export function bearer(header: string | undefined | null): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match?.[1];
}

export function upgradeAuthorized(
  expected: string,
  headers: IncomingHttpHeaders,
  url: URL,
): boolean {
  return tokenMatches(expected, bearer(headers.authorization) ?? url.searchParams.get('token'));
}
