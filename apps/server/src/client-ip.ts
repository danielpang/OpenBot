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
