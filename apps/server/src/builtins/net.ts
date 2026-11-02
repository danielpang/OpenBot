import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { hostAllowed } from '@openbots/agent';
import {
  Agent,
  buildConnector,
  fetch as undiciFetch,
  type RequestInit as UndiciInit,
} from 'undici';

// Outbound requests (plan 17, S-8). A URL from the model may come from an
// injected page (P2), and connector, OAuth, mail and provider URLs come from
// users, so by default nothing reaches loopback, private, link-local or other
// non-public addresses (the database, Redis, cloud metadata). A host the
// Bot's allowlist names exactly is the one way to reach such an address on
// purpose.
//
// The check runs where the connection is made: the dispatcher's `lookup`
// resolves the name once, checks every address and hands the checked ones to
// the socket, so an answer that changes after the check (DNS rebinding) is
// never used. IP literals skip `lookup` and are checked in the connector.
// `guardedFetch` follows redirects by hand, so every hop is also checked
// against the Bot's allowlist; `netFetch` is the same guard as a plain fetch
// for MCP, OAuth and provider requests.

export interface NetOptions {
  /** Lets every address through; tests that serve fakes on 127.0.0.1 set it. */
  allowPrivateNetwork?: boolean;
  /** Hosts allowed to resolve to non-public addresses (exact names from the allowlist). */
  privateHosts?: string[];
  /** The Bot's allowlist (`hostAllowed`), checked on every hop; absent or null allows every host. */
  allowlist?: string[] | null;
  maxRedirects?: number;
  timeoutMs?: number;
  /** Resolves a name to its addresses; tests stand in a rebinding resolver. */
  resolve?: (host: string) => Promise<LookupAddress[]>;
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return !blocked.check(mapped[1]!, 'ipv4');
    return !blocked.check(address, 'ipv6');
  }
  return false;
}

export class BlockedAddressError extends Error {}

const bare = (host: string) =>
  host
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();

const exempt = (host: string, options: NetOptions) =>
  options.allowPrivateNetwork === true || options.privateHosts?.includes(host) === true;

const privateHost = (host: string) =>
  new BlockedAddressError(`${host} is on a private or local network, which OpenBots cannot reach`);

const resolveAll = (host: string) => lookup(host, { all: true });

/**
 * How long a guarded request may take, redirects included, when the caller
 * sets no `timeoutMs`. web_fetch passes its own (OPENBOTS_WEB_FETCH_TIMEOUT_SECONDS,
 * also 30 seconds by default); MCP, OAuth, provider and http_request calls use this.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The addresses of `host`, resolved once. Throws `BlockedAddressError` when
 * there are none, or when any is non-public and the host is not exempt.
 */
export async function checkedAddresses(
  host: string,
  options: NetOptions = {},
): Promise<LookupAddress[]> {
  const name = bare(host);
  const family = isIP(name);
  let addresses: LookupAddress[];
  if (family) {
    addresses = [{ address: name, family }];
  } else {
    try {
      addresses = await (options.resolve ?? resolveAll)(name);
    } catch {
      addresses = [];
    }
    if (!addresses.length) throw new BlockedAddressError(`${name} could not be resolved`);
  }
  if (!exempt(name, options) && addresses.some((a) => !isPublicAddress(a.address))) {
    throw privateHost(name);
  }
  return addresses;
}

/** The checked address to connect to, for clients that take a host (SMTP, IMAP). */
export async function checkedAddress(host: string, options: NetOptions = {}): Promise<string> {
  return (await checkedAddresses(host, options))[0]!.address;
}

/** A socket `lookup` that answers with `checkedAddresses`, so the socket connects to what was checked. */
export function pinnedLookup(options: NetOptions = {}): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    checkedAddresses(hostname, options).then(
      (addresses) => {
        const family = lookupOptions.family;
        const list =
          family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : addresses;
        if (!list.length) {
          const error = Object.assign(new Error(`${hostname} has no IPv${family} address`), {
            code: 'ENOTFOUND',
          });
          callback(error, '');
        } else if (lookupOptions.all) {
          callback(null, list);
        } else {
          callback(null, list[0]!.address, list[0]!.family);
        }
      },
      (error: Error) => callback(error, ''),
    );
  };
}

/** An undici dispatcher whose connections only reach checked addresses. */
export function guardedAgent(options: NetOptions = {}): Agent {
  const connect = buildConnector({ lookup: pinnedLookup(options) });
  return new Agent({
    connect: (connectOptions, callback) => {
      // IP literals never reach `lookup`.
      const host = bare(connectOptions.hostname);
      if (isIP(host) && !exempt(host, options) && !isPublicAddress(host)) {
        callback(privateHost(host), null);
        return;
      }
      connect(connectOptions, callback);
    },
  });
}

/** The guard's refusal rather than undici's "fetch failed" around it. */
function unwrap(error: unknown): unknown {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof BlockedAddressError ? cause : error;
}

function checkProtocol(url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedAddressError(`Only http and https URLs can be fetched, not ${url.protocol}`);
  }
}

const fetchers = new WeakMap<NetOptions, typeof fetch>();
const defaults: NetOptions = {};

/**
 * `fetch` behind the guard, for MCP Streamable HTTP, OAuth discovery and
 * token requests, and provider endpoints. Redirects are followed by fetch
 * itself; every connection a hop opens goes through the same check. One
 * dispatcher per options object.
 */
export function netFetch(options: NetOptions = defaults): typeof fetch {
  let guarded = fetchers.get(options);
  if (!guarded) {
    const dispatcher = guardedAgent(options);
    guarded = async (input, init) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : input);
      checkProtocol(url);
      try {
        const res = await undiciFetch(url, {
          ...(request
            ? {
                method: request.method,
                headers: request.headers,
                signal: request.signal,
                ...(request.body ? { body: request.body, duplex: 'half' as const } : {}),
              }
            : {}),
          ...(init as object),
          dispatcher,
        } as UndiciInit);
        return res as unknown as Response;
      } catch (error) {
        throw unwrap(error);
      }
    };
    fetchers.set(options, guarded);
  }
  return guarded;
}

export interface FetchedResponse {
  url: string;
  status: number;
  headers: Headers;
  body: Buffer;
  truncated: boolean;
}

/**
 * `fetch` with the address check on every connection, the allowlist on every
 * hop and the body capped at `maxBytes`.
 */
export async function guardedFetch(
  input: string,
  init: RequestInit,
  maxBytes: number,
  options: NetOptions = {},
): Promise<FetchedResponse> {
  let url = new URL(input);
  let request = init;
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const dispatcher = guardedAgent(options);
  try {
    for (let hop = 0; ; hop++) {
      checkProtocol(url);
      if (options.allowlist !== undefined && !hostAllowed(url.hostname, options.allowlist)) {
        throw new BlockedAddressError(
          `${bare(url.hostname)} is not in this Bot's domain allowlist. The owner can add it ` +
            "in the Bot's tool settings.",
        );
      }
      const res = (await undiciFetch(url, {
        ...(request as object),
        redirect: 'manual',
        signal,
        dispatcher,
      })) as unknown as Response;
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        if (hop >= (options.maxRedirects ?? 5)) throw new Error('Too many redirects');
        const next = new URL(location, url);
        const method = (request.method ?? 'GET').toUpperCase();
        // 303, and 301 or 302 after a POST, continue as GET without a body, as browsers do.
        if (
          res.status === 303 ||
          ((res.status === 301 || res.status === 302) && method === 'POST')
        ) {
          const { body: _body, ...rest } = request;
          request = { ...rest, method: method === 'HEAD' ? 'HEAD' : 'GET' };
        }
        // Credentials never follow a redirect to another origin.
        if (next.origin !== url.origin && request.headers) {
          const headers = new Headers(request.headers);
          headers.delete('authorization');
          headers.delete('cookie');
          request = { ...request, headers };
        }
        url = next;
        continue;
      }
      const { body, truncated } = await readCapped(res, maxBytes);
      return { url: url.toString(), status: res.status, headers: res.headers, body, truncated };
    }
  } catch (error) {
    throw unwrap(error);
  } finally {
    void dispatcher.destroy();
  }
}

async function readCapped(res: Response, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - size;
      if (value.byteLength > room) {
        chunks.push(Buffer.from(value.subarray(0, room)));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
  }
  return { body: Buffer.concat(chunks), truncated };
}
