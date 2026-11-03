// What the tunnel runs over: an ordered, message-oriented byte pipe that can
// close with a WebSocket close code. A relay stream (relay-client.ts) is one;
// the server's side of a relay link is another (apps/server wraps its stream
// ids into this shape); `memoryTransportPair()` joins two ends in memory for
// tests. Messages that arrive before the first `onMessage` handler is
// registered are held, so a caller may set up its handlers a tick late.

export interface ByteTransport {
  send(bytes: Uint8Array): void;
  onMessage(handler: (bytes: Uint8Array) => void): void;
  /** Fires once, when the transport closes from either end. */
  onClose(handler: (code: number, reason: string) => void): void;
  close(code?: number, reason?: string): void;
}

/** A handler property both a browser `WebSocket` and the `ws` package's socket can be assigned to. */
type Handler<E> = { bivarianceHack(event: E): void }['bivarianceHack'];

/**
 * The subset of the browser WebSocket that carries binary frames: what
 * `fromWebSocket` and `connectThroughRelay` need. Browser, React Native and
 * `ws` sockets all fit.
 */
export interface BinaryWebSocketLike {
  readonly readyState: number;
  binaryType: string;
  onopen: Handler<unknown> | null;
  onmessage: Handler<{ data: unknown }> | null;
  onclose: Handler<{ code: number; reason: string }> | null;
  onerror: Handler<unknown> | null;
  send(data: Uint8Array | ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
}

export type BinaryWebSocketFactory = (url: string) => BinaryWebSocketLike;

const CONNECTING = 0;
const OPEN = 1;

/** Fans out messages and the close to handlers, holding messages until the first handler arrives. */
class TransportEvents {
  #messageHandlers: ((bytes: Uint8Array) => void)[] = [];
  #closeHandlers: ((code: number, reason: string) => void)[] = [];
  #held: Uint8Array[] = [];
  #closed: { code: number; reason: string } | null = null;

  get closed(): boolean {
    return this.#closed !== null;
  }

  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.#messageHandlers.push(handler);
    if (this.#messageHandlers.length === 1 && this.#held.length) {
      const held = this.#held;
      this.#held = [];
      for (const bytes of held) handler(bytes);
    }
  }

  onClose(handler: (code: number, reason: string) => void): void {
    if (this.#closed) {
      const { code, reason } = this.#closed;
      queueMicrotask(() => handler(code, reason));
      return;
    }
    this.#closeHandlers.push(handler);
  }

  message(bytes: Uint8Array): void {
    if (this.#closed) return;
    if (!this.#messageHandlers.length) {
      this.#held.push(bytes);
      return;
    }
    for (const handler of this.#messageHandlers) handler(bytes);
  }

  close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = { code, reason };
    const handlers = this.#closeHandlers;
    this.#closeHandlers = [];
    for (const handler of handlers) handler(code, reason);
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * Wraps a WebSocket into a ByteTransport: binary frames both ways, text
 * frames ignored. Sends made while the socket is still connecting are queued
 * until it opens. `binaryType` is set to `arraybuffer`.
 */
export function fromWebSocket(socket: BinaryWebSocketLike): ByteTransport {
  const events = new TransportEvents();
  let queued: Uint8Array[] = [];
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    const pending = queued;
    queued = [];
    for (const bytes of pending) socket.send(bytes);
  };
  socket.onmessage = (event) => {
    const bytes = toBytes(event.data);
    if (bytes) events.message(bytes);
  };
  socket.onerror = () => {};
  socket.onclose = (event) => {
    events.close(event?.code ?? 1006, event?.reason ?? '');
  };
  return {
    send(bytes) {
      if (events.closed) return;
      if (socket.readyState === CONNECTING) queued.push(bytes);
      else if (socket.readyState === OPEN) socket.send(bytes);
    },
    onMessage: (handler) => events.onMessage(handler),
    onClose: (handler) => events.onClose(handler),
    close(code = 1000, reason = '') {
      queued = [];
      try {
        socket.close(code, reason);
      } catch {
        socket.close();
      }
    },
  };
}

/**
 * Two connected in-memory transports. Messages are copied and delivered in
 * order on a later microtask, as a socket would; closing either end closes
 * both with the same code and reason, after the messages already sent.
 */
export function memoryTransportPair(): [ByteTransport, ByteTransport] {
  const a = new TransportEvents();
  const b = new TransportEvents();
  let closing = false;
  const end = (self: TransportEvents, peer: TransportEvents): ByteTransport => ({
    send(bytes) {
      if (closing) return;
      const copy = bytes.slice();
      queueMicrotask(() => peer.message(copy));
    },
    onMessage: (handler) => self.onMessage(handler),
    onClose: (handler) => self.onClose(handler),
    close(code = 1000, reason = '') {
      if (closing) return;
      closing = true;
      queueMicrotask(() => {
        self.close(code, reason);
        peer.close(code, reason);
      });
    },
  });
  return [end(a, b), end(b, a)];
}
