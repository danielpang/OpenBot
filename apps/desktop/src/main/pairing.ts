// The pairing window's plain parts (docs/RELAY_PROTOCOL.md 6): which relay
// the phone goes through, and the code it scans. On This Mac the owner picks
// the project's shared relay or a relay of their own, and the app writes it
// to the stack's `.env` as OPENBOTS_RELAY_URL (stack/manager.ts). The shared
// relay is the build's `openbots.relayUrl` in the packaged package.json, or
// OPENBOTS_SHARED_RELAY_URL in a development run, else DEFAULT_SHARED_RELAY_URL.

/** The relay the project runs for every install without its own (deploy/relay). */
export const DEFAULT_SHARED_RELAY_URL = 'wss://relay.openbots.dev';

/** How long a pairing is good for (RELAY_PROTOCOL.md 6.1). */
export const PAIRING_TTL_MS = 5 * 60_000;

/**
 * A relay address the server takes as OPENBOTS_RELAY_URL: wss://, or ws://
 * on this Mac only, without credentials, a query or a fragment, and without
 * the trailing slash. Null for anything else. The result goes into `.env` on
 * a line of its own, so `URL` normalizing it also keeps out any newline.
 */
export function parseRelayUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local)) return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return null;
  }
  return url.href.replace(/\/+$/, '');
}

/** The shared relay: the packaged app's from its package.json, a development run's from the environment. */
export function sharedRelayUrl(options: {
  packaged: boolean;
  packageJson?: unknown;
  env: NodeJS.ProcessEnv;
}): string {
  const value = options.packaged
    ? (options.packageJson as { openbots?: { relayUrl?: unknown } } | null)?.openbots?.relayUrl
    : options.env.OPENBOTS_SHARED_RELAY_URL;
  return parseRelayUrl(value) ?? DEFAULT_SHARED_RELAY_URL;
}

/** The server's time less the local one, from a response's `Date` header (second precision). */
export function clockSkew(dateHeader: string | null, now = Date.now()): number {
  const server = dateHeader ? Date.parse(dateHeader) : NaN;
  return Number.isFinite(server) ? server - now : 0;
}

/** Whether a `device.paired` device was made by this pairing's time, not an older one's. */
export function pairedByThis(deviceCreatedAt: string, pairing: { expiresAt: string }): boolean {
  const madeAt = new Date(pairing.expiresAt).getTime() - PAIRING_TTL_MS;
  return new Date(deviceCreatedAt).getTime() >= madeAt;
}
