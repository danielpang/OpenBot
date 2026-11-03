import { TunnelError } from './errors.js';
import { FLAG_END, FrameType, frameTypeName, type Frame } from './frames.js';
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  TransportRoute,
  runInitiatorHandshake,
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
  isNullBodyStatus,
  pumpStream,
  readClose,
  readHeaderMap,
  readStatus,
  wireCloseCode,
  textDecoder,
  textEncoder,
  type Channel,
  type BodyInit,
  type ChannelHandler,
  type HeadersInit,
  type TunnelLimits,
} from './session.js';
import type { ByteTransport } from './transport.js';

// The client side of the tunnel (RELAY_PROTOCOL.md section 5): the device
// that dials a server through the relay. `createTunnelClient` runs the Noise
// handshake as the initiator, pinning the server key from the pairing link,
// and answers an object that speaks HTTP and WebSocket over the stream:
//
// - `fetch` has the signature of the global fetch, so `openapi-fetch` and the
//   generated API client can use it unchanged. Only the path and query of the
//   URL travel; the host is the server at the other end of the stream. Request
//   and response bodies stream in frames under the credit window, and an
//   AbortSignal cancels the request with an `error` frame (`cancelled`).
// - `createSocket` answers a WebSocketLike, the shape `createWsClient` in
//   `@openbots/api-client` takes as its `createSocket`, so the realtime client
//   runs over the tunnel unchanged.
//
// Ids are odd from 1 and never reused. The 64 open ids and the 16 MiB request
// body are enforced here as well as on the server, so a client fails fast
// rather than waiting for the server's refusal.

export interface TunnelClientOptions {
  transport: ByteTransport;
  /** The server's tunnel key (X25519 public key), from the pairing link's `key`. */
  serverKey: Uint8Array;
  /** The device static key (X25519 private key). */
  staticKey: Uint8Array;
  /** Overrides of the protocol's limits, for tests. */
  limits?: Partial<TunnelLimits>;
  handshakeTimeoutMs?: number;
}

export interface TunnelSocketOptions {
  /** Headers for the upgrade, e.g. `authorization`. */
  headers?: HeadersInit;
}

export interface TunnelClient {
  /** What the server said in the handshake; becomes `known` once a pairing on this stream succeeds. */
  readonly device: DeviceStatus;
  readonly closed: boolean;
  /** The Noise handshake hash, the same on both ends: a channel binding if one is ever needed. */
  readonly handshakeHash: Uint8Array;
  fetch: typeof fetch;
  createSocket(url: string | URL, options?: TunnelSocketOptions): TunnelWebSocket;
  /** Round trip time in milliseconds. */
  ping(): Promise<number>;
  close(code?: number, reason?: string): void;
  onClose(handler: (code: number, reason: string) => void): () => void;
}

export async function createTunnelClient(options: TunnelClientOptions): Promise<TunnelClient> {
  const { transport } = options;
  const limits: TunnelLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const route = new TransportRoute(transport);
  const handshake = await runInitiatorHandshake(transport, route, {
    staticKey: options.staticKey,
    serverKey: options.serverKey,
    timeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    maxMessages: limits.maxMessages,
  });
  const session = new TunnelSession({
    role: 'client',
    transport,
    ciphers: handshake.ciphers,
    limits,
  });
  route.take(
    (bytes) => session.receive(bytes),
    (code, reason) => session.transportClosed(code, reason),
  );
  let device = handshake.device;
  const ctx: ClientContext = { session, limits, onPaired: () => (device = 'known') };

  const tunnelFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = await prepareRequest(input, init);
    if (request.signal?.aborted) throw abortReason(request.signal);
    if (request.length !== null && request.length > limits.maxRequestBodyBytes) {
      throw new TunnelError(
        'too_large',
        `a request body of more than ${limits.maxRequestBodyBytes} bytes`,
      );
    }
    const exchange = new HttpExchange(ctx, request);
    exchange.start(session.openLocal(exchange.handler));
    return exchange.promise;
  };

  return {
    get device() {
      return device;
    },
    get closed() {
      return session.closed;
    },
    handshakeHash: handshake.handshakeHash,
    fetch: tunnelFetch as typeof fetch,
    createSocket: (url, socketOptions) => new TunnelWebSocket(ctx, url, socketOptions),
    ping: () => session.ping(),
    close: (code = 1000, reason = '') => session.close(code, reason),
    onClose: (handler) => session.onClose(handler),
  };
}

interface ClientContext {
  session: TunnelSession;
  limits: TunnelLimits;
  onPaired: () => void;
}

/** Calls an application's event handler without letting its exception break the stream. */
function dispatch<E>(handler: ((event: E) => void) | null, event: E): void {
  if (!handler) return;
  try {
    handler(event);
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return makeDomError('This operation was aborted', 'AbortError');
}

function makeDomError(message: string, name: string): Error {
  if (typeof DOMException === 'function') return new DOMException(message, name);
  const error = new Error(message);
  error.name = name;
  return error;
}

/** The path and query of a fetch input: a path as given, or the path and query of a URL. */
export function requestPath(url: string): string {
  if (url.startsWith('/') && !url.startsWith('//')) {
    const hash = url.indexOf('#');
    return hash >= 0 ? url.slice(0, hash) : url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(
      `the tunnel cannot fetch ${JSON.stringify(url)}: give a path or an absolute URL`,
    );
  }
  return parsed.pathname + parsed.search;
}

interface PreparedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array | ReadableStream<Uint8Array> | null;
  /** The body's length when known up front. */
  length: number | null;
  signal: AbortSignal | null;
}

function isRequest(input: unknown): input is Request {
  return typeof Request === 'function' && input instanceof Request;
}

async function prepareRequest(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<PreparedRequest> {
  let url: string;
  let method = 'GET';
  let headers: HeadersInit | undefined;
  let body: BodyInit | null | undefined = null;
  let signal: AbortSignal | null = null;
  if (isRequest(input)) {
    url = input.url;
    method = input.method;
    headers = input.headers;
    body = input.body;
    signal = input.signal;
  } else {
    url = String(input);
  }
  if (init.method !== undefined) method = init.method;
  if (init.headers !== undefined) headers = init.headers;
  if (init.body !== undefined) body = init.body;
  if (init.signal !== undefined) signal = init.signal;
  method = method.toUpperCase();
  const headerRecord = headerMap(headers);
  if (body !== null && body !== undefined && (method === 'GET' || method === 'HEAD')) {
    throw new TypeError(`a ${method} request cannot have a body`);
  }
  const prepared = await normalizeBody(body ?? null, headerRecord);
  return { method, path: requestPath(url), headers: headerRecord, ...prepared, signal };
}

/** Turns a fetch body into bytes or a stream, setting `content-type` as fetch would when the caller gave none. */
async function normalizeBody(
  body: BodyInit | null,
  headers: Record<string, string>,
): Promise<{ body: Uint8Array | ReadableStream<Uint8Array> | null; length: number | null }> {
  const contentType = (value: string) => {
    if (value && headers['content-type'] === undefined) headers['content-type'] = value;
  };
  if (body === null) return { body: null, length: null };
  if (typeof body === 'string') {
    contentType('text/plain;charset=UTF-8');
    const bytes = textEncoder.encode(body);
    return { body: bytes, length: bytes.length };
  }
  if (typeof URLSearchParams === 'function' && body instanceof URLSearchParams) {
    contentType('application/x-www-form-urlencoded;charset=UTF-8');
    const bytes = textEncoder.encode(body.toString());
    return { body: bytes, length: bytes.length };
  }
  if (body instanceof ArrayBuffer) return { body: new Uint8Array(body), length: body.byteLength };
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { body: bytes, length: bytes.length };
  }
  if (typeof Blob === 'function' && body instanceof Blob) {
    contentType(body.type);
    const bytes = new Uint8Array(await body.arrayBuffer());
    return { body: bytes, length: bytes.length };
  }
  if (typeof ReadableStream === 'function' && body instanceof ReadableStream) {
    return { body: body as ReadableStream<Uint8Array>, length: null };
  }
  // FormData and anything else a Response knows how to serialise.
  const serialised = new Response(body as BodyInit);
  contentType(serialised.headers.get('content-type') ?? '');
  const bytes = new Uint8Array(await serialised.arrayBuffer());
  return { body: bytes, length: bytes.length };
}

/** A response arriving on an id: `http.res`, then `http.body` frames until END. */
class ResponseReader {
  readonly response: Response;
  readonly status: number;
  ended = false;
  readonly #queue: BodyQueue;
  readonly #onEnded: () => void;

  /** Takes the `http.res` frame, which may already carry END (the hooks then fire before this returns). */
  constructor(
    ctx: ClientContext,
    channel: Channel,
    frame: Frame,
    hooks: { onEnded: () => void; onCancel: () => void },
  ) {
    const status = readStatus(frame.header?.status);
    if (status < 200)
      throw new ProtocolViolation(`http.res status ${status} cannot be answered as a Response`);
    this.status = status;
    const headers = readHeaderMap(frame.header?.headers, 'http.res');
    this.#queue = new BodyQueue({
      onConsumed: (bytes) => ctx.session.consumed(channel, bytes),
      onCancel: () => hooks.onCancel(),
    });
    const nullBody = isNullBodyStatus(status);
    if (nullBody) this.#queue.discard();
    this.response = new Response(nullBody ? null : this.#queue.stream, { status, headers });
    this.#onEnded = hooks.onEnded;
    this.push(frame);
  }

  push(frame: Frame): void {
    if (this.ended)
      throw new ProtocolViolation(`${frameTypeName(frame.type)} after the response ended`);
    this.#queue.push(frame.body);
    if (frame.flags & FLAG_END) {
      this.ended = true;
      this.#queue.end();
      this.#onEnded();
    }
  }

  fail(error: Error): void {
    this.#queue.fail(error);
  }
}

/** One `fetch` on the tunnel. */
class HttpExchange {
  readonly promise: Promise<Response>;
  readonly handler: ChannelHandler;
  readonly #ctx: ClientContext;
  readonly #request: PreparedRequest;
  #channel: Channel | null = null;
  #resolve!: (response: Response) => void;
  #reject!: (error: unknown) => void;
  #settled = false;
  #reader: ResponseReader | null = null;
  #requestEnded = false;
  #failed = false;
  #removeAbortListener: () => void = () => {};

  constructor(ctx: ClientContext, request: PreparedRequest) {
    this.#ctx = ctx;
    this.#request = request;
    this.promise = new Promise<Response>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.handler = {
      onFrame: (frame) => this.#onFrame(frame),
      onError: (error) => this.#fail(error),
    };
  }

  start(channel: Channel): void {
    this.#channel = channel;
    const { session } = this.#ctx;
    const { method, path, headers, body, signal } = this.#request;
    try {
      session.send({
        type: FrameType.HttpReq,
        id: channel.id,
        flags: body === null ? FLAG_END : 0,
        header: { method, path, headers },
      });
    } catch (error) {
      session.release(channel);
      this.#fail(error as Error);
      return;
    }
    if (signal) {
      const onAbort = () => {
        const reason = abortReason(signal);
        if (channel.open) session.sendError(channel, 'cancelled', 'the request was aborted');
        this.#fail(reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.#removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }
    if (body === null) this.#requestEnded = true;
    else void this.#upload(channel, body);
  }

  async #upload(channel: Channel, body: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    const { session, limits } = this.#ctx;
    try {
      if (body instanceof Uint8Array) {
        await session.sendData(channel, FrameType.HttpBody, body, { end: true });
      } else {
        let total = 0;
        await pumpStream(body, async (chunk) => {
          total += chunk.length;
          if (total > limits.maxRequestBodyBytes) {
            throw new TunnelError(
              'too_large',
              `a request body of more than ${limits.maxRequestBodyBytes} bytes`,
            );
          }
          await session.sendData(channel, FrameType.HttpBody, chunk, { end: false });
        });
        await session.sendData(channel, FrameType.HttpBody, new Uint8Array(0), { end: true });
      }
      this.#requestEnded = true;
      this.#maybeFinish();
    } catch (error) {
      if (!channel.open) return;
      if (error instanceof TunnelError && error.code === 'too_large') {
        session.sendError(channel, 'too_large', error.message);
      } else {
        session.sendError(channel, 'cancelled', 'the request body failed');
      }
      this.#fail(error);
    }
  }

  #onFrame(frame: Frame): void {
    const channel = this.#channel!;
    if (frame.type === FrameType.HttpRes) {
      if (this.#reader) throw new ProtocolViolation(`a second http.res on id ${frame.id}`);
      this.#reader = new ResponseReader(this.#ctx, channel, frame, {
        onEnded: () => this.#maybeFinish(),
        onCancel: () => {
          if (channel.open && !this.#reader?.ended) {
            this.#ctx.session.sendError(channel, 'cancelled', 'the response body was cancelled');
          }
        },
      });
      this.#settled = true;
      const { method, path } = this.#request;
      if (method === 'POST' && path.split('?')[0] === PAIR_PATH && this.#reader.status === 200)
        this.#ctx.onPaired();
      this.#resolve(this.#reader.response);
      // An http.res with END fired onEnded before #reader was set, so look again.
      this.#maybeFinish();
      return;
    }
    if (frame.type === FrameType.HttpBody && this.#reader) {
      this.#reader.push(frame);
      return;
    }
    throw new ProtocolViolation(`${frameTypeName(frame.type)} on request id ${frame.id}`);
  }

  #maybeFinish(): void {
    if (!this.#requestEnded || !this.#reader?.ended) return;
    this.#removeAbortListener();
    this.#ctx.session.release(this.#channel!);
  }

  #fail(error: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#removeAbortListener();
    if (!this.#settled) {
      this.#settled = true;
      this.#reject(error);
    } else {
      this.#reader?.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export interface TunnelCloseEvent {
  type: 'close';
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface TunnelErrorEvent {
  type: 'error';
  /** What failed, when something did. */
  error?: Error;
  /** The server's answer when it refused the upgrade (also on `upgradeResponse`). */
  response?: Response;
}

/**
 * A WebSocket carried by the tunnel. It has the browser WebSocket's
 * properties that `WebSocketLike` in `@openbots/api-client` names, and sends
 * text and binary messages. A refused upgrade fires `error` with the server's
 * Response, then `close` with 1006; the Response stays on `upgradeResponse`.
 */
export class TunnelWebSocket {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;

  readonly url: string;
  readonly protocol = '';
  readonly extensions = '';
  /** How binary messages are delivered. */
  binaryType: 'arraybuffer' | 'blob' = 'arraybuffer';
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** The headers of the server's `ws.opened`. */
  responseHeaders: Record<string, string> = {};
  /** The server's answer when it refused the upgrade. */
  upgradeResponse: Response | null = null;

  #readyState = CONNECTING;
  #bufferedAmount = 0;
  readonly #ctx: ClientContext;
  #channel: Channel | null = null;
  #sentClose = false;
  #reader: ResponseReader | null = null;
  readonly #assembler: MessageAssembler;

  constructor(ctx: ClientContext, url: string | URL, options: TunnelSocketOptions = {}) {
    this.#ctx = ctx;
    this.url = String(url);
    this.#assembler = new MessageAssembler(ctx.limits.maxMessageBytes);
    const handler: ChannelHandler = {
      onFrame: (frame) => this.#onFrame(frame),
      onError: (error) => this.#onError(error),
    };
    try {
      const path = requestPath(this.url);
      const channel = ctx.session.openLocal(handler);
      this.#channel = channel;
      ctx.session.send({
        type: FrameType.WsOpen,
        id: channel.id,
        header: { path, headers: headerMap(options.headers) },
      });
    } catch (error) {
      if (this.#channel) ctx.session.release(this.#channel);
      queueMicrotask(() => this.#onError(error as Error));
    }
  }

  get readyState(): number {
    return this.#readyState;
  }

  /** Bytes of messages queued and not yet sent, as the window allows. */
  get bufferedAmount(): number {
    return this.#bufferedAmount;
  }

  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    if (this.#readyState === CONNECTING)
      throw makeDomError('the WebSocket is still connecting', 'InvalidStateError');
    if (this.#readyState !== OPEN || this.#sentClose) return;
    const channel = this.#channel!;
    const { session } = this.#ctx;
    const text = typeof data === 'string';
    const size = text
      ? data.length
      : data instanceof ArrayBuffer
        ? data.byteLength
        : 'size' in data
          ? data.size
          : data.byteLength;
    this.#bufferedAmount += size;
    channel.sendChain = channel.sendChain
      .then(async () => {
        let bytes: Uint8Array;
        if (typeof data === 'string') bytes = textEncoder.encode(data);
        else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
        else if (ArrayBuffer.isView(data))
          bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        else bytes = new Uint8Array(await data.arrayBuffer());
        await session.sendData(channel, FrameType.WsMsg, bytes, { end: true, text });
      })
      .catch(() => {})
      .finally(() => {
        this.#bufferedAmount -= size;
      });
  }

  close(code?: number, reason?: string): void {
    if (
      code !== undefined &&
      code !== 1000 &&
      (code < 3000 || code > 4999 || !Number.isInteger(code))
    ) {
      throw makeDomError(`close code ${code} is not 1000 or 3000 to 4999`, 'InvalidAccessError');
    }
    if (reason !== undefined && textEncoder.encode(reason).length > 123) {
      throw makeDomError('a close reason is at most 123 bytes', 'SyntaxError');
    }
    if (this.#readyState === CLOSING || this.#readyState === CLOSED) return;
    const channel = this.#channel;
    const { session } = this.#ctx;
    if (this.#readyState === CONNECTING) {
      // Not open yet, so there is no socket to close: cancel the open instead.
      if (channel?.open)
        session.sendError(channel, 'cancelled', 'the socket was closed before it opened');
      this.#finish({ type: 'close', code: 1006, reason: '', wasClean: false });
      return;
    }
    this.#readyState = CLOSING;
    this.#sentClose = true;
    const header = { code: code ?? 1000, reason: reason ?? '' };
    channel!.sendChain = channel!.sendChain.then(() => {
      try {
        session.sendIfOpen(channel!, { type: FrameType.WsClose, id: channel!.id, header });
      } catch {
        // The stream closed; #onError reports it.
      }
    });
  }

  #onFrame(frame: Frame): void {
    const channel = this.#channel!;
    const { session } = this.#ctx;
    switch (frame.type) {
      case FrameType.WsOpened: {
        if (this.#readyState !== CONNECTING || this.#reader)
          throw new ProtocolViolation(`ws.opened on id ${frame.id}, which is not opening`);
        this.responseHeaders = readHeaderMap(frame.header?.headers, 'ws.opened');
        this.#readyState = OPEN;
        dispatch(this.onopen, { type: 'open' });
        return;
      }
      case FrameType.HttpRes: {
        if (this.#readyState !== CONNECTING || this.#reader)
          throw new ProtocolViolation(`http.res on socket id ${frame.id}`);
        this.#reader = new ResponseReader(this.#ctx, channel, frame, {
          onEnded: () => session.release(channel),
          onCancel: () => {
            if (channel.open)
              session.sendError(channel, 'cancelled', 'the response body was cancelled');
          },
        });
        this.upgradeResponse = this.#reader.response;
        this.#readyState = CLOSED;
        dispatch(this.onerror, {
          type: 'error',
          error: new Error(`the server refused the WebSocket upgrade (${this.#reader.status})`),
          response: this.#reader.response,
        } satisfies TunnelErrorEvent);
        dispatch(this.onclose, {
          type: 'close',
          code: 1006,
          reason: `upgrade refused (${this.#reader.status})`,
          wasClean: false,
        } satisfies TunnelCloseEvent);
        return;
      }
      case FrameType.HttpBody: {
        if (!this.#reader) throw new ProtocolViolation(`http.body on socket id ${frame.id}`);
        this.#reader.push(frame);
        return;
      }
      case FrameType.WsMsg: {
        if (this.#readyState !== OPEN && this.#readyState !== CLOSING) {
          throw new ProtocolViolation(`ws.msg on socket id ${frame.id}, which is not open`);
        }
        let message: { text: boolean; data: Uint8Array } | null;
        try {
          message = this.#assembler.push(frame);
        } catch (error) {
          if (!(error instanceof TunnelError)) throw error;
          session.sendError(channel, error.code, error.message);
          this.#finish({ type: 'close', code: 1009, reason: 'message too big', wasClean: false });
          return;
        }
        if (!message) return;
        if (this.#readyState === OPEN)
          dispatch(this.onmessage, { type: 'message', data: this.#messageData(message) });
        session.consumed(channel, message.data.length);
        return;
      }
      case FrameType.WsClose: {
        if (this.#readyState === CONNECTING)
          throw new ProtocolViolation(`ws.close on socket id ${frame.id}, which never opened`);
        const { code, reason } = readClose(frame.header);
        if (!this.#sentClose) {
          this.#sentClose = true;
          this.#readyState = CLOSING;
          const echo = { code: wireCloseCode(code), reason: '' };
          channel.sendChain = channel.sendChain.then(() => {
            try {
              session.sendIfOpen(channel, {
                type: FrameType.WsClose,
                id: channel.id,
                header: echo,
              });
            } catch {
              // The stream closed meanwhile.
            }
            session.release(channel);
          });
        } else {
          session.release(channel);
        }
        this.#finish({ type: 'close', code, reason, wasClean: true });
        return;
      }
      default:
        throw new ProtocolViolation(`${frameTypeName(frame.type)} on socket id ${frame.id}`);
    }
  }

  #messageData(message: { text: boolean; data: Uint8Array }): unknown {
    if (message.text) return textDecoder.decode(message.data);
    const { data } = message;
    const buffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
    if (this.binaryType === 'blob' && typeof Blob === 'function') return new Blob([buffer]);
    return buffer;
  }

  #onError(error: Error): void {
    if (this.#reader) {
      this.#reader.fail(error);
      return;
    }
    if (this.#readyState === CLOSED) return;
    dispatch(this.onerror, { type: 'error', error } satisfies TunnelErrorEvent);
    const code = error instanceof TunnelError && error.code === 'too_large' ? 1009 : 1006;
    this.#finish({ type: 'close', code, reason: error.message, wasClean: false });
  }

  #finish(event: TunnelCloseEvent): void {
    if (this.#readyState === CLOSED) return;
    this.#readyState = CLOSED;
    dispatch(this.onclose, event);
  }
}
