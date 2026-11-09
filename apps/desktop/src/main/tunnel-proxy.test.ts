import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { base64urlEncode, x25519PublicKey, type ServerSocket } from '@openbots/tunnel';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fakeServer } from './fake-tunnel.js';
import {
  forwardHeaders,
  PROXY_SECRET_HEADER,
  startTunnelProxy,
  type TunnelProxy,
} from './tunnel-proxy.js';

const SECRET = 'the-secret';
const KEY = 'obk_device';

const running: TunnelProxy[] = [];
afterEach(async () => {
  for (const proxy of running.splice(0)) await proxy.close();
});

/** A server whose tunnel echoes requests and opens an echo socket at /ws. */
async function setup(options: { failTunnel?: Error } = {}) {
  const sockets: {
    path: string;
    headers: Record<string, string>;
    received: (string | Uint8Array)[];
  }[] = [];
  const server = fakeServer({
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/refused') return new Response('nope', { status: 401 });
      const body = request.method === 'POST' ? await request.text() : null;
      return Response.json(
        {
          method: request.method,
          path: url.pathname + url.search,
          body,
          headers: Object.fromEntries(request.headers),
        },
        { headers: { 'x-from': 'server' } },
      );
    },
    openSocket: async (path, headers) => {
      if (path.startsWith('/refused')) return new Response('no', { status: 403 });
      const record = { path, headers, received: [] as (string | Uint8Array)[] };
      sockets.push(record);
      let toPage: (data: string | Uint8Array) => void = () => undefined;
      // What the page sends is recorded and echoed back to it.
      return {
        send: (data) => {
          record.received.push(data);
          toPage(data);
        },
        close: () => undefined,
        onMessage: (handler) => (toPage = handler),
        onClose: () => undefined,
      } satisfies ServerSocket;
    },
  });
  const key = new Uint8Array(32).fill(3);
  server.devices.set(base64urlEncode(x25519PublicKey(key)), 'device-1');
  const target = { hostId: 'h', relayUrl: 'wss://r', serverKey: server.serverKey };
  const proxy = await startTunnelProxy({
    tunnel: async () => {
      if (options.failTunnel) throw options.failTunnel;
      return server.tunnels.find((t) => !t.closed) ?? server.open(target, key);
    },
    apiKey: KEY,
    secret: SECRET,
    describeError: (error) => `down: ${(error as Error).message}`,
  });
  running.push(proxy);
  return { proxy, server, sockets };
}

function call(
  proxy: TunnelProxy,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, unknown>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${proxy.origin}${path}`,
      { method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

const allowed = { [PROXY_SECRET_HEADER]: SECRET };

describe('forwardHeaders', () => {
  it('keeps the page’s headers, replaces credentials and drops this hop’s', () => {
    expect(
      forwardHeaders(
        {
          host: '127.0.0.1:1',
          accept: 'application/json',
          cookie: 'a=b',
          authorization: 'Bearer stolen',
          'x-api-key': 'k',
          [PROXY_SECRET_HEADER]: SECRET,
          'sec-websocket-key': 'abc',
          'x-list': ['a', 'b'],
        },
        KEY,
        true,
      ),
    ).toEqual({ accept: 'application/json', 'x-list': 'a, b', authorization: `Bearer ${KEY}` });
  });
});

describe('startTunnelProxy', () => {
  it('carries requests through the tunnel with the device key', async () => {
    const { proxy } = await setup();
    expect(proxy.origin).toBe(`http://127.0.0.1:${proxy.port}`);
    const got = await call(proxy, '/api/v1/me?x=1', {
      headers: { ...allowed, cookie: 'session=1', accept: 'application/json' },
    });
    expect(got.status).toBe(200);
    expect(got.headers['x-from']).toBe('server');
    const echo = JSON.parse(got.text) as { path: string; headers: Record<string, string> };
    expect(echo.path).toBe('/api/v1/me?x=1');
    expect(echo.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(echo.headers.accept).toBe('application/json');
    expect(echo.headers).not.toHaveProperty('cookie');
    expect(echo.headers).not.toHaveProperty(PROXY_SECRET_HEADER);

    const posted = await call(proxy, '/api/v1/chats', {
      method: 'POST',
      headers: { ...allowed, 'content-type': 'application/json' },
      body: '{"text":"hi"}',
    });
    expect(JSON.parse(posted.text)).toMatchObject({ method: 'POST', body: '{"text":"hi"}' });

    const refused = await call(proxy, '/refused', { headers: allowed });
    expect(refused).toMatchObject({ status: 401, text: 'nope' });
  });

  it('refuses callers without the secret, or at another name', async () => {
    const { proxy, server } = await setup();
    const stranger = await call(proxy, '/api/v1/me');
    expect(stranger.status).toBe(403);
    const wrong = await call(proxy, '/api/v1/me', { headers: { [PROXY_SECRET_HEADER]: 'guess' } });
    expect(wrong.status).toBe(403);
    // A page that rebinds its own name to 127.0.0.1 sends that name as the host.
    const rebound = await call(proxy, '/api/v1/me', {
      headers: { ...allowed, host: `evil.example:${proxy.port}` },
    });
    expect(rebound.status).toBe(403);
    expect(server.tunnels).toHaveLength(0);
  });

  it('answers 502 with why when the tunnel is down', async () => {
    const { proxy } = await setup({ failTunnel: new Error('relay gone') });
    const got = await call(proxy, '/', { headers: allowed });
    expect(got.status).toBe(502);
    expect(JSON.parse(got.text)).toMatchObject({
      code: 'TUNNEL_UNAVAILABLE',
      detail: 'down: relay gone',
    });
  });

  it('bridges WebSockets both ways', async () => {
    const { proxy, sockets } = await setup();
    const page = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws?x=1`, { headers: allowed });
    await new Promise((resolve, reject) => {
      page.once('open', resolve);
      page.once('error', reject);
    });
    expect(sockets[0]).toMatchObject({ path: '/ws?x=1' });
    expect(sockets[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    const echoed: { data: string; binary: boolean }[] = [];
    page.on('message', (data: Buffer, binary: boolean) =>
      echoed.push({ data: binary ? data.toString('hex') : data.toString(), binary }),
    );
    page.send('hello');
    page.send(Buffer.from([1, 2, 3]));
    await expect.poll(() => sockets[0]!.received.length).toBe(2);
    expect(sockets[0]!.received[0]).toBe('hello');
    expect(Array.from(sockets[0]!.received[1] as Uint8Array)).toEqual([1, 2, 3]);
    await expect.poll(() => echoed.length).toBe(2);
    expect(echoed).toEqual([
      { data: 'hello', binary: false },
      { data: '010203', binary: true },
    ]);
    page.close();
  });

  it('refuses an upgrade the server refused, or one without the secret', async () => {
    const { proxy } = await setup();
    const status = (url: string, headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const page = new WebSocket(url, { headers });
        page.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        page.once('error', () => resolve(-1));
      });
    expect(await status(`ws://127.0.0.1:${proxy.port}/refused`, allowed)).toBe(403);
    expect(await status(`ws://127.0.0.1:${proxy.port}/ws`, {})).toBe(403);
  });

  it('moves to a free port when its last one is taken', async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const taken = (holder.address() as { port: number }).port;
    const proxy = await startTunnelProxy({
      tunnel: async () => {
        throw new Error('unused');
      },
      apiKey: KEY,
      secret: SECRET,
      port: taken,
    });
    running.push(proxy);
    expect(proxy.port).not.toBe(taken);
    holder.close();
  });
});
