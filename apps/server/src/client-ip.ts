import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import type { AppEnv } from './context.js';

// The caller's address (plan 17 controls 5 and 6; S-5, S-6). `X-Forwarded-For`
// is only read when the peer is one of TRUSTED_PROXIES, and then from the
// right: each trusted hop is skipped and the first untrusted one is the
// client, since a hop to its left can say anything. With no trusted proxies
// the header is ignored and the peer is the client.

/** Set by `createApp` on requests it hands to better-auth; any inbound copy is replaced. */
export const CLIENT_IP_HEADER = 'x-openbots-client-ip';

/** `::ffff:1.2.3.4` as `1.2.3.4`, so one client has one key and one allowlist match. */
export function normalizeIp(address: string): string {
  return address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
}

/** Whether `range` is an address or a CIDR range (`10.0.0.0/8`, `fd00::/8`). */
export function isCidr(range: string): boolean {
  const [net, bits, extra] = range.split('/');
  const family = isIP(net ?? '');
  if (!family || extra !== undefined) return false;
  if (bits === undefined) return true;
  const prefix = Number(bits);
  return /^\d+$/.test(bits) && prefix <= (family === 4 ? 32 : 128);
}

const lists = new WeakMap<readonly string[], BlockList>();

function blockList(ranges: readonly string[]): BlockList {
  let list = lists.get(ranges);
  if (!list) {
    list = new BlockList();
    for (const range of ranges) {
      const [net, bits] = range.split('/') as [string, string?];
      const type = isIP(net) === 4 ? 'ipv4' : 'ipv6';
      list.addSubnet(net, Number(bits ?? (type === 'ipv4' ? 32 : 128)), type);
    }
    lists.set(ranges, list);
  }
  return list;
}

/** Whether `address` is inside one of `ranges` (CIDR, checked by `loadConfig`). */
export function inRanges(address: string, ranges: readonly string[]): boolean {
  const ip = normalizeIp(address);
  const family = isIP(ip);
  if (!family || !ranges.length) return false;
  return blockList(ranges).check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * The client's address from the peer and `X-Forwarded-For` as described
 * above; null when it cannot be known (no peer, or a malformed hop).
 */
export function resolveClientIp(
  peer: string | undefined,
  forwardedFor: string | undefined,
  trustedProxies: readonly string[],
): string | null {
  if (!peer || !isIP(normalizeIp(peer))) return null;
  let client = normalizeIp(peer);
  if (!forwardedFor || !inRanges(client, trustedProxies)) return client;
  const hops = forwardedFor.split(',').map((hop) => hop.trim());
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = normalizeIp(hops[i]!);
    if (!isIP(hop)) return null;
    client = hop;
    if (!inRanges(hop, trustedProxies)) break;
  }
  return client;
}

function peerAddress(c: Context<AppEnv>): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // Not served by @hono/node-server, e.g. `app.request` in a test.
    return undefined;
  }
}

/** The caller's address for the request, per TRUSTED_PROXIES. */
export function clientIp(c: Context<AppEnv>): string | null {
  return resolveClientIp(
    peerAddress(c),
    c.req.header('x-forwarded-for'),
    c.var.deps.config.trustedProxies,
  );
}

/**
 * Set by the relay adapter (src/relay) on each request it forwards from a
 * tunnel to this server's own port on loopback: the device's id, or
 * `stream:<id>` for a stream whose device is not paired yet
 * (RELAY_PROTOCOL.md 5.4). Believed only from loopback.
 */
export const DEVICE_HEADER = 'x-openbots-device';

/**
 * Set by the relay adapter beside DEVICE_HEADER: the tunnel's device static
 * key from the Noise handshake, base64url. `POST /devices/pair` checks the
 * body's `publicKey` against it (PAIRING_KEY_MISMATCH). Believed only from loopback.
 */
export const DEVICE_KEY_HEADER = 'x-openbots-device-key';

const LOOPBACK = ['127.0.0.0/8', '::1'];

/**
 * A loopback peer alone does not prove a request came from the relay
 * adapter: a reverse proxy or another program on the same host connects from
 * loopback too. The adapter runs in this process and sends this secret,
 * made fresh at every start and never written anywhere, so the device headers
 * are believed only beside it. A request through the tunnel cannot carry it:
 * the adapter drops a client-sent copy before it adds its own.
 */
export const ADAPTER_SECRET_HEADER = 'x-openbots-adapter';

/**
 * The headers the relay adapter adds for the server's own use. Nothing that
 * stores or shows a request's headers (the webhook delivery log, a Bot's view
 * of a delivery) may keep them: the secret above must never leave this process.
 */
export const INTERNAL_HEADERS: ReadonlySet<string> = new Set([
  'x-openbots-adapter',
  'x-openbots-device',
  'x-openbots-device-key',
]);
const ADAPTER_SECRET = randomBytes(32).toString('base64url');

/** The header the relay adapter adds to every loopback request and socket. */
export function adapterHeaders(): Record<string, string> {
  return { [ADAPTER_SECRET_HEADER]: ADAPTER_SECRET };
}

function fromAdapter(c: Context<AppEnv>): boolean {
  const sent = c.req.header(ADAPTER_SECRET_HEADER);
  if (!sent) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(sent), digest(ADAPTER_SECRET));
}

/** Whether the peer of the connection itself (never X-Forwarded-For) is loopback. */
export function fromLoopback(c: Context<AppEnv>): boolean {
  const peer = peerAddress(c);
  return peer !== undefined && inRanges(peer, LOOPBACK);
}

/** A header the relay adapter sets, when the request came from loopback; else undefined. */
export function tunnelHeader(c: Context<AppEnv>, name: string): string | undefined {
  if (!fromLoopback(c) || !fromAdapter(c)) return undefined;
  const value = c.req.header(name)?.trim();
  return value ? value : undefined;
}

/**
 * The key the server's own rate limits count a request under: the client's
 * address, or `device:<id>` for a tunneled request (DEVICE_HEADER from
 * loopback), so every phone behind the relay adapter gets its own bucket.
 * From any other peer the header is ignored. Null when neither is known.
 */
export function rateLimitKey(c: Context<AppEnv>): string | null {
  const device = tunnelHeader(c, DEVICE_HEADER);
  if (device) return `device:${device.slice(0, 128)}`;
  return clientIp(c);
}
