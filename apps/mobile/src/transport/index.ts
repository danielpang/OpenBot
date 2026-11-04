import type { WebSocketLike } from '@openbots/api-client';
import {
  base64urlDecode,
  connectThroughRelay,
  createTunnelClient,
  type BinaryWebSocketFactory,
  type BinaryWebSocketLike,
} from '@openbots/tunnel';
import type { HostSecrets, SavedHost } from '../hosts/types';

export interface MobileTransport {
  kind: 'direct' | 'relay';
  baseUrl: string;
  fetch: typeof fetch;
  createSocket(url: string): WebSocketLike;
  createBinarySocket(url: string): BinaryWebSocketLike;
  close(): void;
}

export interface TransportOptions {
  fetch?: typeof fetch;
  createSocket?: (
    url: string,
    headers?: Record<string, string>,
  ) => WebSocketLike | BinaryWebSocketLike;
  createRelaySocket?: BinaryWebSocketFactory;
  signal?: AbortSignal;
  directTimeoutMs?: number;
  /** HTTP is restricted to local addresses and requires an explicit UI warning. */
  allowInsecureLocal?: boolean;
  /** Pairing has no API key yet; it probes the public health endpoint. */
  pairing?: boolean;
}

function isPrivateHost(hostname: string): boolean {
  const name = hostname.toLowerCase();
  if (name === 'localhost' || name === '[::1]' || name.endsWith('.local')) return true;
  const parts = name.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  return (
    parts[0] === 127 ||
    parts[0] === 10 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
  );
}

export function normalizeServerUrl(value: string, allowInsecureLocal = false): string {
  const url = new URL(value.trim());
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('Enter a server origin without a path, credentials, or query');
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && allowInsecureLocal && isPrivateHost(url.hostname))
  ) {
    throw new Error('Use HTTPS. Local HTTP requires the insecure local network option.');
  }
  return url.origin;
}

/** Native WebSocket supports upgrade headers, unlike the browser implementation. */
function nativeSocket(url: string, headers?: Record<string, string>): WebSocketLike {
  const Socket = WebSocket as unknown as new (
    url: string,
    protocols?: string[],
    options?: { headers?: Record<string, string> },
  ) => WebSocketLike;
  return new Socket(url, [], { headers });
}

function authenticatedFetch(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): typeof fetch {
  return (async (input, init) => {
    const original = input instanceof Request ? input : null;
    const url = new URL(original?.url ?? String(input), baseUrl);
    if (url.origin !== new URL(baseUrl).origin)
      throw new Error('Refusing to send host credentials to another server');
    const headers = new Headers(init?.headers ?? original?.headers);
    if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
    return fetchImpl(original ? new Request(url, original) : url.toString(), {
      ...init,
      headers,
      redirect: 'error',
    });
  }) as typeof fetch;
}

export function createDirectTransport(
  baseUrl: string,
  apiKey: string,
  options: TransportOptions = {},
): MobileTransport {
  const origin = normalizeServerUrl(baseUrl, options.allowInsecureLocal);
  const sockets = new Set<WebSocketLike>();
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const createSocket = (input: string): WebSocketLike => {
    const url = new URL(input, origin);
    if (url.origin !== origin && url.origin !== origin.replace(/^http/, 'ws'))
      throw new Error('Unexpected socket origin');
    url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
    const socket = (options.createSocket ?? nativeSocket)(url.toString(), headers);
    sockets.add(socket as WebSocketLike);
    return socket as WebSocketLike;
  };
  return {
    kind: 'direct',
    baseUrl: origin,
    fetch: authenticatedFetch(origin, apiKey, options.fetch ?? fetch),
    createSocket,
    createBinarySocket(input) {
      const socket = createSocket(input) as BinaryWebSocketLike;
      socket.binaryType = 'arraybuffer';
      return socket;
    },
    close() {
      for (const socket of sockets) socket.close(1000, 'app inactive');
      sockets.clear();
    },
  };
}

export async function createTunnelTransport(
  host: SavedHost,
  secrets: HostSecrets,
  options: TransportOptions = {},
): Promise<MobileTransport> {
  if (!host.relayUrl || !host.serverPublicKey || !secrets.devicePrivateKey)
    throw new Error('Relay credentials are missing');
  const serverKey = base64urlDecode(host.serverPublicKey);
  const staticKey = base64urlDecode(secrets.devicePrivateKey);
  const stream = await connectThroughRelay({
    relayUrl: host.relayUrl,
    hostId: host.id,
    signal: options.signal,
    createSocket: options.createRelaySocket ?? ((url) => nativeSocket(url) as BinaryWebSocketLike),
  });
  const onAbort = () => stream.close(1000, 'app inactive');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) {
    onAbort();
    throw options.signal.reason;
  }
  let tunnel;
  try {
    tunnel = await createTunnelClient({ transport: stream, serverKey, staticKey });
    if (options.signal?.aborted) {
      tunnel.close();
      throw options.signal.reason;
    }
  } catch (error) {
    stream.close();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
  // A fake origin only supplies Request/URL parsing; no DNS request is made.
  const baseUrl = 'https://openbots.tunnel';
  return {
    kind: 'relay',
    baseUrl,
    fetch: authenticatedFetch(baseUrl, secrets.apiKey, tunnel.fetch),
    createSocket: (url) =>
      tunnel.createSocket(url, {
        headers: secrets.apiKey ? { authorization: `Bearer ${secrets.apiKey}` } : {},
      }),
    createBinarySocket: (url) =>
      tunnel.createSocket(url, {
        headers: secrets.apiKey ? { authorization: `Bearer ${secrets.apiKey}` } : {},
      }),
    close: () => tunnel.close(1000, 'app inactive'),
  };
}

/** Select a reachable direct path, then open the pinned encrypted relay. Mutations are never retried. */
export async function connectHost(
  host: SavedHost,
  secrets: HostSecrets,
  options: TransportOptions = {},
): Promise<MobileTransport> {
  const failures: unknown[] = [];
  for (const address of host.directUrls) {
    if (options.signal?.aborted) throw options.signal.reason;
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), options.directTimeoutMs ?? 2500);
    let transport: MobileTransport | undefined;
    try {
      transport = createDirectTransport(address, secrets.apiKey, options);
      const response = await transport.fetch(options.pairing ? '/healthz' : '/api/v1/me', {
        signal: controller.signal,
      });
      if (response.ok) return transport;
      throw new Error(`Server answered ${response.status}`);
    } catch (error) {
      transport?.close();
      failures.push(error);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  if (options.signal?.aborted) throw options.signal.reason;
  if (host.relayUrl) return createTunnelTransport(host, secrets, options);
  throw new AggregateError(
    failures,
    'Cannot reach this server. Check its address and your connection.',
  );
}
