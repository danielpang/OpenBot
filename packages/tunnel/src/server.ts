import { TunnelError } from './errors.js';
import { FLAG_END, FrameType, frameTypeName, type Frame } from './frames.js';
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  TransportRoute,
  runResponderHandshake,
  type DeviceStatus,
} from './handshake.js';
import {
  BodyQueue,
  DEFAULT_LIMITS,
  MessageAssembler,
  PAIR_PATH,
  ProtocolViolation,
  TunnelSession,
  headerMap,
  pumpStream,
  readClose,
  readHeaderMap,
  wireCloseCode,
  textDecoder,
  textEncoder,
  type Channel,
  type ChannelHandler,
  type TunnelLimits,
} from './session.js';
import type { ByteTransport } from './transport.js';

// The server side of the tunnel (RELAY_PROTOCOL.md sections 5.1 to 5.4).
// `createTunnelServer` answers the client's handshake as the Noise responder,
// asks `lookupDevice` whether the client's static key belongs to a paired
// device, and then serves the stream's frames:
//
// - `http.req` becomes a web Request with a streaming body for
//   `handler.fetch`, and the Response goes back as `http.res` and `http.body`
//   frames under the credit window.
// - `ws.open` goes to `handler.openSocket`; a ServerSocket is answered with
//   `ws.opened` and its messages are piped both ways, and a Response (a
//   refused upgrade) goes back as an HTTP response.
//
// A stream from an unknown device serves pairing only: every request but
// `POST /api/v1/devices/pair` gets 403 `DEVICE_UNKNOWN` without reaching the
// handler. When that pairing answers 200, the session looks the client's key
// up again and, now that it is known, serves anything from then on.
//
// Headers cross in both directions less the names spec 5.4 lists (and less
// `x-openbots-device` from the client, which only the adapter may set), so the
// handler can forward the Request to the server's own port as it is.

/** The origin of the Requests handed to `handler.fetch`. Only the path and query mean anything. */
export const TUNNEL_ORIGIN = 'http://openbots.tunnel';

export type DeviceLookup = { known: true; id: string } | { known: false };

export interface TunnelRequestMeta {
  /** The paired device this stream belongs to, or null while it is unknown (pairing only). */
  deviceId: string | null;
}

/** The server's end of a WebSocket the handler opened, e.g. a `ws` socket to the server's own port. */
export interface ServerSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: string | Uint8Array) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  /** Headers for `ws.opened`, e.g. the negotiated `sec-websocket-protocol`. */
  headers?: Record<string, string>;
}

export interface TunnelHandler {
  fetch(request: Request, meta: TunnelRequestMeta): Promise<Response>;
  /** `path` carries the query. Answer a Response to refuse the upgrade. */
  openSocket(
    path: string,
    headers: Record<string, string>,
    meta: TunnelRequestMeta,
  ): Promise<ServerSocket | Response>;
}

export interface TunnelServerOptions {
  transport: ByteTransport;
  /** The server tunnel key (X25519 private key). */
  staticKey: Uint8Array;
  /** Decides `device` in handshake message 2, and is asked again after a pairing on the stream. */
  lookupDevice(publicKey: Uint8Array): Promise<DeviceLookup>;
  handler: TunnelHandler;
  limits?: Partial<TunnelLimits>;
  handshakeTimeoutMs?: number;
}

export interface TunnelServer {
  /** The device id once known; null while the stream serves pairing only. */
  readonly deviceId: string | null;
  readonly device: DeviceStatus;
  /** The client's static X25519 public key from the handshake. */
  readonly clientKey: Uint8Array;
  readonly closed: boolean;
  readonly handshakeHash: Uint8Array;
  ping(): Promise<number>;
  close(code?: number, reason?: string): void;
  onClose(handler: (code: number, reason: string) => void): () => void;
}

const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'cookie',
  'origin',
  'connection',
  'upgrade',
  'content-length',
  'transfer-encoding',
  'x-openbots-device',
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'connection',
  'transfer-encoding',
  'content-length',
]);

/** True for a request header spec 5.4 says the adapter sets itself rather than passing through. */
export function isDroppedRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    DROPPED_REQUEST_HEADERS.has(lower) ||
    lower.startsWith('sec-fetch-') ||
    lower.startsWith('x-forwarded-')
  );
}

/** True for a response header spec 5.4 says does not pass back. */
export function isDroppedResponseHeader(name: string): boolean {
  return DROPPED_RESPONSE_HEADERS.has(name.toLowerCase());
}

function stripRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    if (!isDroppedRequestHeader(name)) out[name] = value;
  return out;
}

function deviceUnknownResponse(): Response {
  return new Response(
    JSON.stringify({
      code: 'DEVICE_UNKNOWN',
      message: 'This device is not paired with this server. Only pairing is served on this stream.',
    }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  );
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function readPath(value: unknown, what: string): string {
  const path = typeof value === 'string' ? normalizeTunnelPath(value) : null;
  if (path === null) {
    throw new ProtocolViolation(`${what} needs a \`path\` starting with / on this server`);
  }
  return path;
}

/**
 * A request or socket path as the tunnel accepts it: a path and query on the
 * server itself, and nothing else. Null for a path that could name another
 * host (`//evil.example/ws`) or a scheme, or that carries a backslash,
 * whitespace or a control character a URL parser might reinterpret. What
 * comes back is the parsed path and query, which is all the server's adapter
 * joins to its loopback origin.
 */
export function normalizeTunnelPath(value: string): string | null {
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\s\u0000-\u001f\u007f]/.test(value)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(TUNNEL_ORIGIN + value);
  } catch {
    return null;
  }
  if (url.origin !== TUNNEL_ORIGIN) return null;
  return url.pathname + url.search;
}

function pathname(path: string): string {
  return new URL(TUNNEL_ORIGIN + path).pathname;
}

interface ServerContext {
  session: TunnelSession;
  limits: TunnelLimits;
  handler: TunnelHandler;
  meta(): TunnelRequestMeta;
  readonly known: boolean;
  /** Looks the client's key up again after a pairing; true when it is now known. */
  promote(): Promise<boolean>;
}

export async function createTunnelServer(options: TunnelServerOptions): Promise<TunnelServer> {
  const { transport, handler, lookupDevice } = options;
  const limits: TunnelLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const route = new TransportRoute(transport);
  const handshake = await runResponderHandshake(transport, route, {
    staticKey: options.staticKey,
    timeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    maxMessages: limits.maxMessages,
    decide: async (clientKey) => {
      const decision = await lookupDevice(clientKey);
      return { device: decision.known ? 'known' : 'unknown', decision };
    },
  });
  const { clientKey } = handshake;
  let deviceId: string | null = handshake.decision.known ? handshake.decision.id : null;

  const ctx: ServerContext = {
    session: undefined as unknown as TunnelSession,
    limits,
    handler,
    meta: () => ({ deviceId }),
    get known() {
      return deviceId !== null;
    },
    async promote() {
      if (deviceId !== null) return true;
      const decision = await lookupDevice(clientKey);
      if (decision.known) deviceId = decision.id;
      return decision.known;
    },
  };
  const session = new TunnelSession({
    role: 'server',
    transport,
    ciphers: handshake.ciphers,
    limits,
    accept: (frame, channel) =>
      frame.type === FrameType.HttpReq
        ? new ServerExchange(ctx, channel, frame).handler
        : new ServerSocketChannel(ctx, channel, frame).handler,
  });
  ctx.session = session;
  route.take(
    (bytes) => session.receive(bytes),
    (code, reason) => session.transportClosed(code, reason),
  );
  handshake.reply();

  return {
    get deviceId() {
      return deviceId;
    },
    get device() {
      return deviceId !== null ? 'known' : 'unknown';
    },
    clientKey,
    get closed() {
      return session.closed;
    },
    handshakeHash: handshake.handshakeHash,
    ping: () => session.ping(),
    close: (code = 1000, reason = '') => session.close(code, reason),
    onClose: (onClose) => session.onClose(onClose),
  };
}

/**
 * Sends a Response on an id: `http.res`, then the body as `http.body` frames.
 * Resolves true once END is sent, false when the id or the stream went away.
 */
async function sendResponse(
  session: TunnelSession,
  channel: Channel,
  response: Response,
): Promise<boolean> {
  const body = response.body;
  try {
    const header = {
      status: response.status,
      headers: headerMap(response.headers, isDroppedResponseHeader),
    };
    if (
      !session.sendIfOpen(channel, {
        type: FrameType.HttpRes,
        id: channel.id,
        flags: body ? 0 : FLAG_END,
        header,
      })
    ) {
      body?.cancel().catch(() => {});
      return false;
    }
  } catch (error) {
    body?.cancel().catch(() => {});
    if (channel.open && !session.closed)
      session.sendError(channel, 'internal', (error as Error).message);
    return false;
  }
  if (!body) return true;
  try {
    await pumpStream(body, (chunk) =>
      session.sendData(channel, FrameType.HttpBody, chunk, { end: false }),
    );
    await session.sendData(channel, FrameType.HttpBody, new Uint8Array(0), { end: true });
    return true;
  } catch (error) {
    if (channel.open && !session.closed) {
      session.sendError(
        channel,
        'internal',
        `the response body failed: ${(error as Error).message}`,
      );
    }
    return false;
  }
}

/** One `http.req` on the stream. */
class ServerExchange {
  readonly handler: ChannelHandler;
  readonly #ctx: ServerContext;
  readonly #channel: Channel;
  readonly #abort = new AbortController();
  #body: BodyQueue | null = null;
  #bodyBytes = 0;
  #requestEnded: boolean;
  #responseEnded = false;

  constructor(ctx: ServerContext, channel: Channel, frame: Frame) {
    this.#ctx = ctx;
    this.#channel = channel;
    this.handler = {
      onFrame: (next) => this.#onFrame(next),
      onError: (error) => this.#onError(error),
    };
    const method = frame.header?.method;
    if (typeof method !== 'string' || !TOKEN.test(method))
      throw new ProtocolViolation('http.req needs a `method`');
    const path = readPath(frame.header?.path, 'http.req');
    const headers = readHeaderMap(frame.header?.headers, 'http.req');
    this.#requestEnded = (frame.flags & FLAG_END) !== 0;

    const declared = Number(headers['content-length']);
    if (Number.isFinite(declared) && declared > ctx.limits.maxRequestBodyBytes) {
      this.#tooLarge();
      return;
    }
    const hasBody = method !== 'GET' && method !== 'HEAD';
    if (!this.#requestEnded || frame.body.length) {
      this.#body = new BodyQueue({
        onConsumed: (bytes) => ctx.session.consumed(channel, bytes),
        // The body is complete and read: credit the rest now.
        onEnd: () => ctx.session.flushCredit(channel),
      });
      if (!hasBody) this.#body.discard();
      if (!this.#addBody(frame)) return;
    }
    void this.#run(method, path, headers, hasBody);
  }

  /** Adds a body chunk; false when it took the body past the limit (the id is then refused). */
  #addBody(frame: Frame): boolean {
    this.#bodyBytes += frame.body.length;
    if (this.#bodyBytes > this.#ctx.limits.maxRequestBodyBytes) {
      this.#tooLarge();
      return false;
    }
    this.#body!.push(frame.body);
    if (frame.flags & FLAG_END) {
      this.#requestEnded = true;
      this.#body!.end();
    }
    return true;
  }

  #tooLarge(): void {
    const message = `a request body of more than ${this.#ctx.limits.maxRequestBodyBytes} bytes`;
    this.#ctx.session.sendError(this.#channel, 'too_large', message);
    this.#onError(new TunnelError('too_large', message));
  }

  #onFrame(frame: Frame): void {
    if (frame.type !== FrameType.HttpBody || !this.#body || this.#requestEnded) {
      throw new ProtocolViolation(`${frameTypeName(frame.type)} on request id ${frame.id}`);
    }
    if (this.#addBody(frame)) this.#maybeFinish();
  }

  #onError(error: Error): void {
    this.#abort.abort(error);
    this.#body?.fail(error);
  }

  async #run(
    method: string,
    path: string,
    headers: Record<string, string>,
    hasBody: boolean,
  ): Promise<void> {
    const ctx = this.#ctx;
    const channel = this.#channel;
    const isPairing = method === 'POST' && pathname(path) === PAIR_PATH;
    let response: Response;
    if (!ctx.known && !isPairing) {
      response = deviceUnknownResponse();
    } else {
      try {
        const request = new Request(TUNNEL_ORIGIN + path, {
          method,
          headers: stripRequestHeaders(headers),
          body: hasBody && this.#body ? this.#body.stream : null,
          signal: this.#abort.signal,
          duplex: 'half',
        } as RequestInit);
        response = await ctx.handler.fetch(request, ctx.meta());
        if (isPairing && response.status === 200 && !ctx.known) await ctx.promote();
      } catch (error) {
        if (channel.open)
          ctx.session.sendError(
            channel,
            'internal',
            (error as Error)?.message ?? 'the handler failed',
          );
        this.#onError(error as Error);
        return;
      }
    }
    if (!channel.open) {
      response.body?.cancel().catch(() => {});
      return;
    }
    if (!(await sendResponse(ctx.session, channel, response))) return;
    this.#responseEnded = true;
    // The answer is complete; whatever of the request body is still to come is not wanted.
    if (!this.#requestEnded) this.#body?.discard();
    this.#maybeFinish();
  }

  #maybeFinish(): void {
    if (this.#requestEnded && this.#responseEnded) this.#ctx.session.release(this.#channel);
  }
}

/** One `ws.open` on the stream. */
class ServerSocketChannel {
  readonly handler: ChannelHandler;
  readonly #ctx: ServerContext;
  readonly #channel: Channel;
  #socket: ServerSocket | null = null;
  #state: 'opening' | 'open' | 'refused' | 'closed' = 'opening';
  #sentClose = false;
  #receivedClose = false;
  readonly #assembler: MessageAssembler;

  constructor(ctx: ServerContext, channel: Channel, frame: Frame) {
    this.#ctx = ctx;
    this.#channel = channel;
    this.#assembler = new MessageAssembler(ctx.limits.maxMessageBytes);
    this.handler = {
      onFrame: (next) => this.#onFrame(next),
      onError: () => this.#teardown(),
    };
    const path = readPath(frame.header?.path, 'ws.open');
    const headers = readHeaderMap(frame.header?.headers, 'ws.open');
    void this.#open(path, headers);
  }

  async #open(path: string, headers: Record<string, string>): Promise<void> {
    const ctx = this.#ctx;
    const channel = this.#channel;
    let result: ServerSocket | Response;
    if (!ctx.known) {
      result = deviceUnknownResponse();
    } else {
      try {
        result = await ctx.handler.openSocket(path, stripRequestHeaders(headers), ctx.meta());
      } catch (error) {
        if (channel.open)
          ctx.session.sendError(
            channel,
            'internal',
            (error as Error)?.message ?? 'the handler failed',
          );
        this.#state = 'closed';
        return;
      }
    }
    if (result instanceof Response) {
      this.#state = 'refused';
      if (await sendResponse(ctx.session, channel, result)) ctx.session.release(channel);
      return;
    }
    const socket = result;
    if (!channel.open || this.#state === 'closed') {
      socket.close(1000, 'the client went away');
      return;
    }
    this.#socket = socket;
    try {
      ctx.session.send({
        type: FrameType.WsOpened,
        id: channel.id,
        header: { headers: socket.headers ?? {} },
      });
    } catch {
      socket.close(1001, 'the tunnel closed');
      return;
    }
    this.#state = 'open';
    socket.onMessage((data) => this.#forward(data));
    socket.onClose((code, reason) => this.#socketClosed(code, reason));
  }

  /** A message from the server's socket, out to the client in order. */
  #forward(data: string | Uint8Array): void {
    const channel = this.#channel;
    if (!channel.open || this.#sentClose) return;
    const text = typeof data === 'string';
    const bytes = typeof data === 'string' ? textEncoder.encode(data) : data;
    channel.sendChain = channel.sendChain
      .then(() => this.#ctx.session.sendData(channel, FrameType.WsMsg, bytes, { end: true, text }))
      .catch(() => {});
  }

  #socketClosed(code: number, reason: string): void {
    const channel = this.#channel;
    if (this.#sentClose || !channel.open) return;
    this.#sentClose = true;
    const header = { code: wireCloseCode(code), reason: truncateReason(reason) };
    channel.sendChain = channel.sendChain.then(() => {
      try {
        this.#ctx.session.sendIfOpen(channel, { type: FrameType.WsClose, id: channel.id, header });
      } catch {
        // The stream closed meanwhile.
      }
      if (this.#receivedClose) this.#ctx.session.release(channel);
    });
  }

  #onFrame(frame: Frame): void {
    const ctx = this.#ctx;
    const channel = this.#channel;
    if (this.#state !== 'open' || this.#receivedClose) {
      throw new ProtocolViolation(
        `${frameTypeName(frame.type)} on socket id ${frame.id}, which is not open`,
      );
    }
    switch (frame.type) {
      case FrameType.WsMsg: {
        let message: { text: boolean; data: Uint8Array } | null;
        try {
          message = this.#assembler.push(frame);
        } catch (error) {
          if (!(error instanceof TunnelError)) throw error;
          ctx.session.sendError(channel, error.code, error.message);
          this.#socket?.close(1009, 'message too big');
          this.#state = 'closed';
          return;
        }
        if (!message) return;
        if (!this.#sentClose)
          this.#socket!.send(message.text ? textDecoder.decode(message.data) : message.data);
        ctx.session.consumed(channel, message.data.length);
        return;
      }
      case FrameType.WsClose: {
        const { code, reason } = readClose(frame.header);
        this.#receivedClose = true;
        if (this.#sentClose) {
          // Our close went first; this is the client's answer.
          ctx.session.release(channel);
          return;
        }
        this.#sentClose = true;
        this.#socket!.close(wireCloseCode(code), reason);
        const echo = { code: wireCloseCode(code), reason: '' };
        channel.sendChain = channel.sendChain.then(() => {
          try {
            ctx.session.sendIfOpen(channel, {
              type: FrameType.WsClose,
              id: channel.id,
              header: echo,
            });
          } catch {
            // The stream closed meanwhile.
          }
          ctx.session.release(channel);
        });
        return;
      }
      default:
        throw new ProtocolViolation(`${frameTypeName(frame.type)} on socket id ${frame.id}`);
    }
  }

  /** The client cancelled the id, or the stream went away. */
  #teardown(): void {
    const wasOpen = this.#state === 'open';
    this.#state = 'closed';
    if (wasOpen && !this.#sentClose) {
      this.#sentClose = true;
      this.#socket?.close(1001, 'the tunnel closed');
    }
  }
}

function truncateReason(reason: string): string {
  const bytes = textEncoder.encode(reason);
  if (bytes.length <= 123) return reason;
  return new TextDecoder().decode(bytes.subarray(0, 123)).replace(/�$/, '');
}
