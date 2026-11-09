import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { TunnelClient } from '@openbots/tunnel';
import { WebSocketServer, type RawData, type WebSocket as NodeWebSocket } from 'ws';

// The main window shows a paired server's web app (./paired.ts) at this
// proxy's loopback address: every request and WebSocket the page makes comes
// here and goes on through the encrypted tunnel, with the device's API key
// added, so the web app, its realtime socket, the terminal and the screen
// work as they do on the server itself. Only the app's own windows may use
// it: they send a secret header that the main process adds to the profile's
// session (index.ts), and anything else on this Mac, or a page that rebinds a
// name to 127.0.0.1, is refused before a byte reaches the tunnel. The proxy
// itself knows nothing of relays or keys; `tunnel` hands it the open tunnel.

/** The header the app's windows and main process send; its value is the proxy's secret. */
export const PROXY_SECRET_HEADER = 'x-openbots-tunnel';

export type ProxyTunnel = Pick<TunnelClient, 'fetch' | 'createSocket'>;

export interface TunnelProxyOptions {
  /** The open tunnel, or a rejection with why there is none. */
  tunnel(): Promise<ProxyTunnel>;
  /** The device's API key, sent as `Authorization: Bearer` on every request. */
  apiKey: string;
  /** What the app's windows send in PROXY_SECRET_HEADER. */
  secret: string;
  /** The port to listen on when it is free (the profile's last one), else any. */
  port?: number;
  /** A sentence for why the tunnel did not open, for the 502 the page gets. */
  describeError?(error: unknown): string;
}

export interface TunnelProxy {
  readonly port: number;
  /** `http://127.0.0.1:<port>` */
  readonly origin: string;
  close(): Promise<void>;
}

/** Request headers that are this hop's own, or that the proxy sets itself. */
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'content-length',
  'cookie',
  'authorization',
  'x-api-key',
  'accept-encoding',
  PROXY_SECRET_HEADER,
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'set-cookie',
]);

function sameSecret(sent: string | string[] | undefined, secret: string): boolean {
  if (typeof sent !== 'string') return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The headers that go on through the tunnel: the page's own, the device's key, nothing of this hop's. */
export function forwardHeaders(
  headers: IncomingHttpHeaders,
  apiKey: string,
  socket = false,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue;
    if (socket && name.startsWith('sec-websocket-')) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  out.authorization = `Bearer ${apiKey}`;
  return out;
}

function problemBody(status: number, title: string, code: string, detail: string): string {
  return JSON.stringify({ type: 'about:blank', title, status, code, detail });
}

function sendProblem(res: ServerResponse, status: number, code: string, detail: string) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const title = status === 502 ? 'Bad Gateway' : 'Forbidden';
  res.writeHead(status, {
    'content-type': 'application/problem+json',
    'cache-control': 'no-store',
  });
  res.end(problemBody(status, title, code, detail));
}

function refuseUpgrade(socket: Duplex, status: number, text: string) {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = Buffer.from(text);
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-type: text/plain\r\ncontent-length: ${body.length}\r\n\r\n${text}`,
  );
}

/** A close code the tunnel's socket takes: 1000, or 3000 to 4999. */
function upstreamCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

/** A close code a WebSocket may send to the page; 1005 and 1006 are only ever reported. */
function pageCode(code: number): number {
  const sendable =
    code === 1000 ||
    (code >= 1001 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999);
  return sendable ? code : 1001;
}

/** A close reason within the protocol's 123 bytes. */
function shortReason(reason: string): string {
  let text = reason;
  while (Buffer.byteLength(text) > 123) text = text.slice(0, -1);
  return text;
}

type TunnelSocket = ReturnType<ProxyTunnel['createSocket']>;

function bridge(page: NodeWebSocket, upstream: TunnelSocket) {
  upstream.onmessage = ({ data }) => {
    if (page.readyState !== page.OPEN) return;
    if (typeof data === 'string') page.send(data);
    else page.send(Buffer.from(data as ArrayBuffer), { binary: true });
  };
  upstream.onclose = (event) => {
    const { code, reason } = event as { code: number; reason: string };
    if (page.readyState === page.OPEN || page.readyState === page.CONNECTING) {
      page.close(pageCode(code), shortReason(reason ?? ''));
    }
  };
  upstream.onerror = () => undefined;
  page.on('message', (data: RawData, isBinary: boolean) => {
    if (upstream.readyState !== upstream.OPEN) return;
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    upstream.send(isBinary ? bytes : bytes.toString('utf8'));
  });
  page.on('close', (code: number, reason: Buffer) => {
    upstream.close(upstreamCode(code), shortReason(reason.toString('utf8')));
  });
  page.on('error', () => upstream.close(1000, ''));
}

/** Starts the proxy on 127.0.0.1, on `port` when it is free. */
export async function startTunnelProxy(options: TunnelProxyOptions): Promise<TunnelProxy> {
  const describe =
    options.describeError ??
    ((error: unknown) => (error instanceof Error ? error.message : String(error)));
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  let port = 0;

  /** Only the app's windows, at this exact address: no stranger, no rebound name. */
  function allowed(req: IncomingMessage): boolean {
    return (
      req.headers.host === `127.0.0.1:${port}` &&
      sameSecret(req.headers[PROXY_SECRET_HEADER], options.secret)
    );
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!allowed(req)) {
      sendProblem(res, 403, 'NOT_THIS_APP', 'Only the OpenBots app may use this address.');
      return;
    }
    let tunnel: ProxyTunnel;
    try {
      tunnel = await options.tunnel();
    } catch (error) {
      sendProblem(res, 502, 'TUNNEL_UNAVAILABLE', describe(error));
      return;
    }
    const method = req.method ?? 'GET';
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const hasBody = method !== 'GET' && method !== 'HEAD';
    let response: Response;
    try {
      response = await tunnel.fetch(req.url ?? '/', {
        method,
        headers: forwardHeaders(req.headers, options.apiKey),
        body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>) : null,
        signal: abort.signal,
      });
    } catch (error) {
      if (!abort.signal.aborted) sendProblem(res, 502, 'TUNNEL_UNAVAILABLE', describe(error));
      return;
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = value;
    });
    res.writeHead(response.status, headers);
    if (!response.body || method === 'HEAD') {
      void response.body?.cancel().catch(() => undefined);
      res.end();
      return;
    }
    const body = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
    body.on('error', () => res.destroy());
    body.pipe(res);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => sendProblem(res, 502, 'TUNNEL_UNAVAILABLE', 'The proxy failed.'));
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    if (!allowed(req)) {
      refuseUpgrade(socket, 403, 'Forbidden');
      return;
    }
    options.tunnel().then(
      (tunnel) => {
        const upstream = tunnel.createSocket(req.url ?? '/', {
          headers: forwardHeaders(req.headers, options.apiKey, true),
        });
        upstream.binaryType = 'arraybuffer';
        let settled = false;
        const onSocketGone = () => {
          if (!settled) {
            settled = true;
            upstream.close();
          }
        };
        socket.once('close', onSocketGone);
        upstream.onopen = () => {
          if (settled) return;
          settled = true;
          socket.off('close', onSocketGone);
          sockets.handleUpgrade(req, socket, head, (page) => bridge(page, upstream));
        };
        upstream.onerror = () => undefined;
        upstream.onclose = () => {
          if (settled) return;
          settled = true;
          const status = upstream.upgradeResponse?.status ?? 502;
          refuseUpgrade(socket, status, status === 502 ? 'Bad Gateway' : 'Refused');
        };
      },
      () => refuseUpgrade(socket, 502, 'Bad Gateway'),
    );
  });

  const listen = (at: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(at, '127.0.0.1');
    });

  try {
    await listen(options.port ?? 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !options.port) throw error;
    // Another app took the last port: any free one, and the profile moves with it.
    await listen(0);
  }
  port = (server.address() as AddressInfo).port;

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of sockets.clients) client.terminate();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
