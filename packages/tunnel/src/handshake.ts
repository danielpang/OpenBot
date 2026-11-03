import { CLOSE_PROTOCOL, TunnelHandshakeError } from './errors.js';
import { x25519PublicKey } from './keys.js';
import { HandshakeState, type TransportCiphers } from './noise.js';
import type { ByteTransport } from './transport.js';

// The two messages of RELAY_PROTOCOL.md section 5.1 over a ByteTransport,
// one function per side. Each takes over the transport's message and close
// events through a `TransportRoute`, so that once the handshake is done the
// session can take them over in the same tick and no frame is lost between
// the two.

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export type DeviceStatus = 'known' | 'unknown';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Registers once on a transport and forwards its events to whoever holds the
 * route now. While nobody holds it, messages and the close are kept, so the
 * hand over from the handshake to the session cannot drop a message (which
 * would put the Noise counters out of step).
 */
export class TransportRoute {
  #onMessage: ((bytes: Uint8Array) => void) | null = null;
  #onClose: ((code: number, reason: string) => void) | null = null;
  #held: Uint8Array[] = [];
  #closed: { code: number; reason: string } | null = null;

  constructor(transport: ByteTransport) {
    transport.onMessage((bytes) => {
      if (this.#onMessage) this.#onMessage(bytes);
      else this.#held.push(bytes);
    });
    transport.onClose((code, reason) => {
      if (this.#closed) return;
      this.#closed = { code, reason };
      this.#onClose?.(code, reason);
    });
  }

  /** Hands the events to new handlers, delivering whatever was kept meanwhile. */
  take(
    onMessage: (bytes: Uint8Array) => void,
    onClose: (code: number, reason: string) => void,
  ): void {
    this.#onMessage = onMessage;
    this.#onClose = onClose;
    while (this.#held.length && this.#onMessage === onMessage) onMessage(this.#held.shift()!);
    if (this.#closed && this.#onClose === onClose) onClose(this.#closed.code, this.#closed.reason);
  }

  /** Keeps events until the next `take`. */
  hold(): void {
    this.#onMessage = null;
    this.#onClose = null;
  }
}

function parsePayload(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new TunnelHandshakeError('the handshake payload is not UTF-8 JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TunnelHandshakeError('the handshake payload is not a JSON object');
  }
  if ((value as { v?: unknown }).v !== 1) {
    throw new TunnelHandshakeError(
      `unsupported tunnel version ${JSON.stringify((value as { v?: unknown }).v)}`,
    );
  }
  return value as Record<string, unknown>;
}

/** Waits for the next message on the route, or the close, or the timeout. The route is held afterwards. */
function nextMessage(route: TransportRoute, timeoutMs: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settle();
      reject(new TunnelHandshakeError(`no handshake message within ${timeoutMs} ms`));
    }, timeoutMs);
    const settle = () => {
      settled = true;
      clearTimeout(timer);
      route.hold();
    };
    route.take(
      (bytes) => {
        if (settled) return;
        settle();
        resolve(bytes);
      },
      (code, reason) => {
        if (settled) return;
        settle();
        reject(
          new TunnelHandshakeError(
            `the stream closed during the handshake (${code}${reason ? `, ${reason}` : ''})`,
          ),
        );
      },
    );
  });
}

function failHandshake(transport: ByteTransport, error: unknown): never {
  transport.close(CLOSE_PROTOCOL, 'handshake failed');
  if (error instanceof TunnelHandshakeError) throw error;
  throw new TunnelHandshakeError(`the handshake failed: ${(error as Error).message}`);
}

export interface InitiatorResult {
  ciphers: TransportCiphers;
  device: DeviceStatus;
  handshakeHash: Uint8Array;
}

/** The client's side: message 1 out, message 2 in. */
export async function runInitiatorHandshake(
  transport: ByteTransport,
  route: TransportRoute,
  options: { staticKey: Uint8Array; serverKey: Uint8Array; timeoutMs: number; maxMessages: number },
): Promise<InitiatorResult> {
  try {
    const handshake = new HandshakeState({
      initiator: true,
      staticKey: { privateKey: options.staticKey, publicKey: x25519PublicKey(options.staticKey) },
      remoteStaticKey: options.serverKey,
      maxMessages: options.maxMessages,
    });
    const reply = nextMessage(route, options.timeoutMs);
    transport.send(handshake.writeMessage(encoder.encode(JSON.stringify({ v: 1 }))));
    const payload = parsePayload(handshake.readMessage(await reply));
    if (payload.device !== 'known' && payload.device !== 'unknown') {
      throw new TunnelHandshakeError('the handshake reply has no `device`');
    }
    return {
      ciphers: handshake.split(),
      device: payload.device,
      handshakeHash: handshake.handshakeHash,
    };
  } catch (error) {
    failHandshake(transport, error);
  }
}

export interface ResponderResult<T> {
  ciphers: TransportCiphers;
  clientKey: Uint8Array;
  decision: T;
  /** Sends message 2. Call it once the session holds the route, so the client's first frame finds it. */
  reply(): void;
  handshakeHash: Uint8Array;
}

/**
 * The server's side: message 1 in, then `decide` (the device lookup) with
 * the client's static key, then message 2 ready to send.
 */
export async function runResponderHandshake<T>(
  transport: ByteTransport,
  route: TransportRoute,
  options: {
    staticKey: Uint8Array;
    timeoutMs: number;
    maxMessages: number;
    decide: (clientKey: Uint8Array) => Promise<{ device: DeviceStatus; decision: T }>;
  },
): Promise<ResponderResult<T>> {
  try {
    const handshake = new HandshakeState({
      initiator: false,
      staticKey: { privateKey: options.staticKey, publicKey: x25519PublicKey(options.staticKey) },
      maxMessages: options.maxMessages,
    });
    parsePayload(handshake.readMessage(await nextMessage(route, options.timeoutMs)));
    const clientKey = handshake.remoteStaticKey!;
    // The route stays held during the lookup. The client may send nothing
    // before message 2; if it does anyway, those bytes reach the session and
    // fail to decrypt there, which closes the stream.
    const { device, decision } = await options.decide(clientKey);
    const message = handshake.writeMessage(encoder.encode(JSON.stringify({ v: 1, device })));
    return {
      ciphers: handshake.split(),
      clientKey,
      decision,
      reply: () => transport.send(message),
      handshakeHash: handshake.handshakeHash,
    };
  } catch (error) {
    failHandshake(transport, error);
  }
}
