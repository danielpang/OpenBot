import { isHostId } from './keys.js';
import {
  fromWebSocket,
  type BinaryWebSocketFactory,
  type BinaryWebSocketLike,
  type ByteTransport,
} from './transport.js';

// A client's side of the relay (RELAY_PROTOCOL.md sections 3.5 and 4). The
// relay answers `GET /v1/connect/{hostId}` with the text frame
// `{"type":"open","v":1}` when the host is linked, and from then on the socket
// is the stream: binary frames both ways, which `fromWebSocket` turns into the
// ByteTransport the tunnel client runs over. When the host is offline (4404),
// the host has too many streams (4429) or the id is malformed (4400), the
// relay closes the socket instead, and `connectThroughRelay` rejects with a
// RelayConnectError that carries the code. A socket that never opens (DNS,
// refused, TLS) rejects with `unreachable` set and the relay's host named.

export const RELAY_CLOSE_HOST_OFFLINE = 4404;
export const RELAY_CLOSE_TOO_MANY = 4429;
export const RELAY_CLOSE_MALFORMED = 4400;
export const RELAY_CLOSE_HOST_GONE = 4410;

export class RelayConnectError extends Error {
  override name = 'RelayConnectError';
  /** The socket's close code: 4404 host offline, 4429 too many streams, 4400 malformed, or what the socket gave. */
  readonly code: number;
  readonly reason: string;
  /** The socket never opened: the relay could not be reached at all (DNS, refused, TLS). */
  readonly unreachable: boolean;

  constructor(
    code: number,
    reason: string,
    message?: string,
    options: { unreachable?: boolean } = {},
  ) {
    super(message ?? `the relay closed the stream (${code}${reason ? `, ${reason}` : ''})`);
    this.code = code;
    this.reason = reason;
    this.unreachable = options.unreachable ?? false;
  }

  get hostOffline(): boolean {
    return this.code === RELAY_CLOSE_HOST_OFFLINE;
  }
}

export class RelayPresenceError extends Error {
  override name = 'RelayPresenceError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ConnectThroughRelayOptions {
  /** The relay's WebSocket URL from the pairing link, e.g. `wss://relay.openbots.dev`. */
  relayUrl: string;
  hostId: string;
  /** Defaults to the global WebSocket. */
  createSocket?: BinaryWebSocketFactory;
  /** How long to wait for `open`. Defaults to 15 seconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function relayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Opens a stream to a host through the relay and resolves once the relay says `open`. */
export function connectThroughRelay(options: ConnectThroughRelayOptions): Promise<ByteTransport> {
  const { relayUrl, hostId, timeoutMs = 15_000, signal } = options;
  const createSocket =
    options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as BinaryWebSocketLike);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let socket: BinaryWebSocketLike;
    try {
      socket = createSocket(`${trimSlash(relayUrl)}/v1/connect/${encodeURIComponent(hostId)}`);
    } catch (error) {
      reject(error);
      return;
    }
    socket.binaryType = 'arraybuffer';
    let settled = false;
    const settle = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown, closeCode?: number) => {
      if (settled) return;
      settle();
      if (closeCode !== undefined) {
        try {
          socket.close(closeCode);
        } catch {
          socket.close();
        }
      }
      reject(error);
    };
    const onAbort = () => fail(signal!.reason, 1000);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () =>
        fail(
          new RelayConnectError(
            1000,
            'timeout',
            `the relay did not open the stream within ${timeoutMs} ms`,
          ),
          1000,
        ),
      timeoutMs,
    );
    let opened = false;
    let failure = '';
    socket.onopen = () => {
      opened = true;
    };
    socket.onerror = (event) => {
      // React Native puts the platform's description here; browsers say nothing.
      const message = (event as { message?: unknown } | null)?.message;
      if (typeof message === 'string' && message !== '') failure = message;
    };
    socket.onmessage = (event) => {
      if (settled) return;
      if (typeof event.data !== 'string') {
        fail(
          new RelayConnectError(
            RELAY_CLOSE_MALFORMED,
            'binary before open',
            'the relay sent data before `open`',
          ),
          1000,
        );
        return;
      }
      let frame: { type?: unknown; v?: unknown } | null = null;
      try {
        frame = JSON.parse(event.data) as { type?: unknown; v?: unknown };
      } catch {
        // Handled below.
      }
      if (frame?.type !== 'open' || frame.v !== 1) {
        fail(
          new RelayConnectError(
            RELAY_CLOSE_MALFORMED,
            'unexpected frame',
            `the relay sent ${event.data.slice(0, 100)}`,
          ),
          1000,
        );
        return;
      }
      settle();
      // Hand the socket over in this same tick, so the first binary frame finds the transport.
      resolve(fromWebSocket(socket));
    };
    socket.onclose = (event) => {
      const code = event?.code ?? 1006;
      const reason = event?.reason ?? '';
      if (opened) {
        fail(new RelayConnectError(code, reason));
        return;
      }
      const detail = reason || failure || `code ${code}`;
      fail(
        new RelayConnectError(
          code,
          reason,
          `could not reach the relay at ${relayHost(relayUrl)} (${detail})`,
          { unreachable: true },
        ),
      );
    };
  });
}

export interface HostPresenceOptions {
  /** The relay's URL; `ws` and `wss` are read as `http` and `https`. */
  relayUrl: string;
  hostId: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** Whether the host has a link to the relay now (`GET /v1/hosts/{hostId}`, spec 3.5). */
export async function hostPresence(options: HostPresenceOptions): Promise<boolean> {
  const { hostId } = options;
  if (!isHostId(hostId))
    throw new RelayPresenceError(404, `${JSON.stringify(hostId)} is not a host id`);
  const doFetch = options.fetch ?? fetch;
  const base = trimSlash(options.relayUrl).replace(/^ws(s?):\/\//i, 'http$1://');
  const response = await doFetch(`${base}/v1/hosts/${hostId}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new RelayPresenceError(
      response.status,
      `the relay answered ${response.status} for host ${hostId}`,
    );
  }
  const body = (await response.json()) as { linked?: unknown };
  return body.linked === true;
}
