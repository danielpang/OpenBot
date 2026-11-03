import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTunnelClient, type TunnelClient, type TunnelWebSocket } from './client.js';
import { TunnelClosedError, TunnelError, TunnelHandshakeError } from './errors.js';
import {
  FLAG_END,
  FrameType,
  MAX_PLAINTEXT_BYTES,
  decodeFrame,
  encodeFrame,
  type FrameInit,
} from './frames.js';
import { generateDeviceKey, x25519PublicKey } from './keys.js';
import { HandshakeState, type TransportCiphers } from './noise.js';
import {
  createTunnelServer,
  type DeviceLookup,
  type ServerSocket,
  type TunnelHandler,
  type TunnelRequestMeta,
  type TunnelServer,
} from './server.js';
import type { TunnelLimits } from './session.js';
import { memoryTransportPair, type ByteTransport } from './transport.js';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const MiB = 1024 * 1024;

/** A transport that records the size of every message it sends. */
function recording(transport: ByteTransport): ByteTransport & { sizes: number[] } {
  const sizes: number[] = [];
  return {
    sizes,
    send(bytes) {
      sizes.push(bytes.length);
      transport.send(bytes);
    },
    onMessage: (handler) => transport.onMessage(handler),
    onClose: (handler) => transport.onClose(handler),
    close: (code, reason) => transport.close(code, reason),
  };
}

interface Setup {
  client: TunnelClient;
  server: TunnelServer;
  devices: Map<string, string>;
  deviceKey: { publicKey: Uint8Array; privateKey: Uint8Array };
  clientTransport: ByteTransport & { sizes: number[] };
}

const open: Setup[] = [];
afterEach(() => {
  for (const setup of open.splice(0)) setup.client.close();
});

async function setup(
  handler: Partial<TunnelHandler>,
  options: {
    known?: boolean;
    clientLimits?: Partial<TunnelLimits>;
    serverLimits?: Partial<TunnelLimits>;
  } = {},
): Promise<Setup> {
  const serverKey = generateDeviceKey();
  const deviceKey = generateDeviceKey();
  const devices = new Map<string, string>();
  if (options.known ?? true) devices.set(hex(deviceKey.publicKey), 'device-1');
  const [a, b] = memoryTransportPair();
  const clientTransport = recording(a);
  const fullHandler: TunnelHandler = {
    fetch: handler.fetch ?? (async () => new Response('no fetch handler', { status: 500 })),
    openSocket:
      handler.openSocket ?? (async () => new Response('no socket handler', { status: 500 })),
  };
  const serverPromise = createTunnelServer({
    transport: b,
    staticKey: serverKey.privateKey,
    lookupDevice: async (publicKey): Promise<DeviceLookup> => {
      const id = devices.get(hex(publicKey));
      return id ? { known: true, id } : { known: false };
    },
    handler: fullHandler,
    limits: options.serverLimits,
  });
  const client = await createTunnelClient({
    transport: clientTransport,
    serverKey: serverKey.publicKey,
    staticKey: deviceKey.privateKey,
    limits: options.clientLimits,
  });
  const server = await serverPromise;
  const result = { client, server, devices, deviceKey, clientTransport };
  open.push(result);
  return result;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/** A ReadableStream of `total` bytes in `chunk` sized pieces, byte i being i mod 251. */
function patternStream(total: number, chunk: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(chunk, total - sent);
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (sent + i) % 251;
      sent += size;
      controller.enqueue(bytes);
    },
  });
}

async function checkPattern(stream: ReadableStream<Uint8Array>): Promise<number> {
  let seen = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return seen;
    for (let i = 0; i < value.length; i++) {
      if (value[i] !== (seen + i) % 251) throw new Error(`byte ${seen + i} is wrong`);
    }
    seen += value.length;
  }
}

/** A ServerSocket double that records what the client sent. */
function fakeSocket() {
  const received: (string | Uint8Array)[] = [];
  let onMessage: (data: string | Uint8Array) => void = () => {};
  let onClose: (code: number, reason: string) => void = () => {};
  const closes: { code?: number; reason?: string }[] = [];
  const socket: ServerSocket = {
    send: (data) => received.push(data),
    close: (code, reason) => closes.push({ code, reason }),
    onMessage: (handler) => (onMessage = handler),
    onClose: (handler) => (onClose = handler),
    headers: { 'sec-websocket-protocol': 'openbots' },
  };
  return {
    socket,
    received,
    closes,
    emit: (data: string | Uint8Array) => onMessage(data),
    closeFromServer: (code: number, reason: string) => onClose(code, reason),
  };
}

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return vi.waitFor(
    () => {
      if (!condition()) throw new Error('not yet');
    },
    { timeout: timeoutMs, interval: 2 },
  );
}

function socketEvents(ws: TunnelWebSocket) {
  const events: {
    type: string;
    data?: unknown;
    code?: number;
    reason?: string;
    response?: Response;
  }[] = [];
  ws.onopen = () => events.push({ type: 'open' });
  ws.onmessage = (event) => events.push({ type: 'message', data: event.data });
  ws.onerror = (event) =>
    events.push({ type: 'error', response: (event as { response?: Response }).response });
  ws.onclose = (event) => {
    const { code, reason } = event as { code: number; reason: string };
    events.push({ type: 'close', code, reason });
  };
  return events;
}

describe('tunnel client and server', () => {
  it('runs a GET with a JSON response, sending only the path and query', async () => {
    const seen: { url: string; headers: Record<string, string>; meta: TunnelRequestMeta }[] = [];
    const { client, server } = await setup({
      fetch: async (request, meta) => {
        seen.push({ url: request.url, headers: Object.fromEntries(request.headers), meta });
        return Response.json(
          { items: [1, 2, 3] },
          { headers: { 'x-trace': 'abc', 'set-cookie': 'a=b' } },
        );
      },
    });
    expect(client.device).toBe('known');
    expect(server.deviceId).toBe('device-1');
    expect(client.handshakeHash).toEqual(server.handshakeHash);

    const response = await client.fetch('https://ignored.example/api/v1/bots?x=1#frag', {
      headers: {
        Authorization: 'Bearer obk_test',
        Cookie: 'session=1',
        Host: 'evil',
        'X-Forwarded-For': '1.2.3.4',
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('x-trace')).toBe('abc');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({ items: [1, 2, 3] });

    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!.url).pathname + new URL(seen[0]!.url).search).toBe('/api/v1/bots?x=1');
    expect(seen[0]!.headers.authorization).toBe('Bearer obk_test');
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(seen[0]!.headers['x-forwarded-for']).toBeUndefined();
    expect(seen[0]!.meta).toEqual({ deviceId: 'device-1' });

    const second = await client.fetch('/api/v1/bots');
    expect(second.ok).toBe(true);
    expect(server.clientKey).toEqual(open[0]!.deviceKey.publicKey);
  });

  it('streams a 16 MiB request body in frames, kept moving by credit', async () => {
    let received = -1;
    const { client, clientTransport } = await setup({
      fetch: async (request) => {
        received = await checkPattern(request.body!);
        return new Response(String(received), { status: 201 });
      },
    });
    const response = await client.fetch('/api/v1/files', {
      method: 'POST',
      body: patternStream(16 * MiB, 100_000),
      duplex: 'half',
    } as RequestInit);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe(String(16 * MiB));
    expect(received).toBe(16 * MiB);
    // Every transport message fits a relay payload and the body went in many of them.
    expect(Math.max(...clientTransport.sizes)).toBeLessThanOrEqual(MAX_PLAINTEXT_BYTES + 16);
    expect(clientTransport.sizes.length).toBeGreaterThan((16 * MiB) / 61_432);
  }, 30_000);

  it('streams a large response body back under the window', async () => {
    const { client } = await setup({
      fetch: async () => new Response(patternStream(5 * MiB, 300_000)),
    });
    const response = await client.fetch('/api/v1/download');
    expect(await checkPattern(response.body!)).toBe(5 * MiB);
  }, 30_000);

  it('holds the sender at the window while the reader does not read', async () => {
    let produced = 0;
    const { client } = await setup({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              produced += 65_536;
              controller.enqueue(new Uint8Array(65_536));
            },
          }),
        ),
    });
    const response = await client.fetch('/api/v1/endless');
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The server read its body only as far as the 1 MiB window (and a chunk or two of buffering) allowed.
    expect(produced).toBeLessThan(MiB + 4 * 65_536);
    await response.body!.cancel();
  });

  it('refuses a request body over the limit with too_large, on both sides', async () => {
    const calls: string[] = [];
    const { client } = await setup({
      fetch: async (request) => {
        calls.push(request.url);
        await request.arrayBuffer();
        return new Response('ok');
      },
    });
    const tooBig = client.fetch('/api/v1/files', {
      method: 'POST',
      body: new Uint8Array(16 * MiB + 1),
    });
    await expect(tooBig).rejects.toMatchObject({ name: 'TunnelError', code: 'too_large' });

    // A client with a looser limit meets the server's.
    const loose = await setup(
      {
        fetch: async (request) => {
          await request.arrayBuffer();
          return new Response('ok');
        },
      },
      { serverLimits: { maxRequestBodyBytes: 100_000 } },
    );
    await expect(
      loose.client.fetch('/api/v1/files', {
        method: 'POST',
        body: patternStream(300_000, 50_000),
        duplex: 'half',
      } as RequestInit),
    ).rejects.toMatchObject({ code: 'too_large' });
    await expect(
      loose.client.fetch('/api/v1/files', {
        method: 'POST',
        body: new Uint8Array(10),
        headers: { 'content-length': '200000' },
      }),
    ).rejects.toMatchObject({ code: 'too_large' });
    // The stream is still good afterwards.
    expect(
      (await loose.client.fetch('/api/v1/files', { method: 'POST', body: 'small' })).status,
    ).toBe(200);
  });

  it('serves 64 concurrent requests and refuses a 65th with too_many_requests', async () => {
    const release = gate();
    let waiting = 0;
    const { client } = await setup({
      fetch: async () => {
        waiting++;
        await release.promise;
        return new Response('done');
      },
    });
    const first64 = Array.from({ length: 64 }, (_, n) => client.fetch(`/api/v1/n/${n}`));
    await waitFor(() => waiting === 64);
    await expect(client.fetch('/api/v1/n/65')).rejects.toMatchObject({ code: 'too_many_requests' });
    release.release();
    const responses = await Promise.all(first64);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await Promise.all(responses.map((response) => response.text()));
    // The ids are free again.
    expect((await client.fetch('/api/v1/n/again')).status).toBe(200);
  });

  it('frees the id of a response that ends in its http.res frame', async () => {
    const { client } = await setup({ fetch: async () => new Response(null, { status: 204 }) });
    for (let n = 0; n < 70; n++)
      expect((await client.fetch(`/api/v1/empty/${n}`)).status).toBe(204);
  });

  it('has the server refuse a 65th request from a client that does not count', async () => {
    const release = gate();
    let waiting = 0;
    const { client } = await setup(
      {
        fetch: async () => {
          waiting++;
          await release.promise;
          return new Response('done');
        },
      },
      { clientLimits: { maxOpenIds: 100 } },
    );
    const first64 = Array.from({ length: 64 }, (_, n) => client.fetch(`/api/v1/n/${n}`));
    await waitFor(() => waiting === 64);
    await expect(client.fetch('/api/v1/n/65')).rejects.toBeInstanceOf(TunnelError);
    await expect(client.fetch('/api/v1/n/66')).rejects.toMatchObject({ code: 'too_many_requests' });
    release.release();
    await Promise.all(first64);
  });

  it('cancels an aborted request with `cancelled` and rejects the fetch', async () => {
    let serverSignal: AbortSignal | null = null;
    const { client } = await setup({
      fetch: async (request) => {
        serverSignal = request.signal;
        await new Promise((resolve) => request.signal.addEventListener('abort', resolve));
        return new Response('too late');
      },
    });
    const controller = new AbortController();
    const pending = client.fetch('/api/v1/slow', { signal: controller.signal });
    await waitFor(() => serverSignal !== null);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => serverSignal!.aborted);
    expect(serverSignal!.reason).toMatchObject({ code: 'cancelled' });

    const already = new AbortController();
    already.abort();
    await expect(client.fetch('/api/v1/x', { signal: already.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('errors the response body when aborted mid-stream', async () => {
    let cancelled = false;
    const { client } = await setup({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(1000));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    const controller = new AbortController();
    const response = await client.fetch('/api/v1/stream', { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) return;
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => cancelled);
  });

  it('carries a WebSocket: open, text and binary both ways, close from the client', async () => {
    const fake = fakeSocket();
    const opened: { path: string; headers: Record<string, string>; meta: TunnelRequestMeta }[] = [];
    const { client } = await setup({
      openSocket: async (path, headers, meta) => {
        opened.push({ path, headers, meta });
        return fake.socket;
      },
    });
    const ws = client.createSocket('wss://host.example/ws?token=1', {
      headers: { authorization: 'Bearer k' },
    });
    const events = socketEvents(ws);
    expect(ws.readyState).toBe(0);
    expect(() => ws.send('early')).toThrow();
    await waitFor(() => ws.readyState === 1);
    expect(events[0]).toEqual({ type: 'open' });
    expect(opened[0]).toEqual({
      path: '/ws?token=1',
      headers: { authorization: 'Bearer k' },
      meta: { deviceId: 'device-1' },
    });
    expect(ws.responseHeaders).toEqual({ 'sec-websocket-protocol': 'openbots' });

    ws.send('hello');
    ws.send(new Uint8Array([1, 2, 3]));
    const large = new Uint8Array(200_000).map((_, i) => i % 256);
    ws.send(large.buffer);
    await waitFor(() => fake.received.length === 3);
    expect(fake.received[0]).toBe('hello');
    expect(fake.received[1]).toEqual(new Uint8Array([1, 2, 3]));
    expect(Buffer.from(fake.received[2] as Uint8Array).equals(large)).toBe(true);

    fake.emit('{"type":"pong"}');
    fake.emit(new Uint8Array([9, 8]));
    fake.emit(large);
    await waitFor(() => events.filter((event) => event.type === 'message').length === 3);
    const messages = events.filter((event) => event.type === 'message').map((event) => event.data);
    expect(messages[0]).toBe('{"type":"pong"}');
    expect(new Uint8Array(messages[1] as ArrayBuffer)).toEqual(new Uint8Array([9, 8]));
    expect(Buffer.from(messages[2] as ArrayBuffer).equals(large)).toBe(true);

    ws.close(4000, 'bye');
    expect(ws.readyState).toBe(2);
    await waitFor(() => ws.readyState === 3);
    expect(fake.closes).toEqual([{ code: 4000, reason: 'bye' }]);
    expect(events.at(-1)).toEqual({ type: 'close', code: 4000, reason: '' });
  });

  it('closes a WebSocket from the server side', async () => {
    const fake = fakeSocket();
    const { client } = await setup({ openSocket: async () => fake.socket });
    const ws = client.createSocket('/computer/pty');
    const events = socketEvents(ws);
    await waitFor(() => ws.readyState === 1);
    fake.emit('last words');
    fake.closeFromServer(1011, 'upstream went away');
    await waitFor(() => ws.readyState === 3);
    expect(events.map((event) => event.type)).toEqual(['open', 'message', 'close']);
    expect(events.at(-1)).toMatchObject({ code: 1011, reason: 'upstream went away' });
    // The client's answer reaches the server and does not close the server socket a second time.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.closes).toEqual([]);
    // The id is free: a new socket opens.
    const again = client.createSocket('/computer/pty');
    await waitFor(() => again.readyState === 1);
  });

  it('delivers a refused upgrade as a Response', async () => {
    const { client } = await setup({
      openSocket: async () =>
        new Response('{"code":"UNAUTHORIZED"}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const ws = client.createSocket('/ws');
    const events = socketEvents(ws);
    await waitFor(() => events.some((event) => event.type === 'close'));
    expect(events.map((event) => event.type)).toEqual(['error', 'close']);
    expect(events[1]).toMatchObject({ code: 1006 });
    const response = events[0]!.response!;
    expect(response).toBe(ws.upgradeResponse);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED' });
    expect(ws.readyState).toBe(3);
  });

  it('fits the WebSocketLike shape createWsClient takes', async () => {
    interface WebSocketLike {
      readonly readyState: number;
      onopen: ((event: unknown) => void) | null;
      onmessage: ((event: { data: unknown }) => void) | null;
      onclose: ((event: unknown) => void) | null;
      onerror: ((event: unknown) => void) | null;
      send(data: string): void;
      close(code?: number, reason?: string): void;
    }
    const fake = fakeSocket();
    const { client } = await setup({ openSocket: async () => fake.socket });
    const createSocket: (url: string) => WebSocketLike = (url) => client.createSocket(url);
    const ws = createSocket('/ws');
    await waitFor(() => ws.readyState === 1);
    ws.send(JSON.stringify({ type: 'ping' }));
    await waitFor(() => fake.received.length === 1);
    ws.close(1000, 'client closed');
  });

  it('serves pairing only to an unknown device, then promotes the stream', async () => {
    const calls: { path: string; meta: TunnelRequestMeta }[] = [];
    // Filled in once setup answers; the handler only runs after that.
    const later: { devices?: Map<string, string>; deviceKey?: Uint8Array } = {};
    const fake = fakeSocket();
    const { client, server, ...rest } = await setup(
      {
        fetch: async (request, meta) => {
          const url = new URL(request.url);
          calls.push({ path: url.pathname, meta });
          if (url.pathname === '/api/v1/devices/pair') {
            const body = (await request.json()) as { publicKey: string };
            expect(body.publicKey).toBe('pk');
            later.devices!.set(hex(later.deviceKey!), 'device-new');
            return Response.json({ device: { id: 'device-new' }, key: 'obk_new' });
          }
          return Response.json({ items: [] });
        },
        openSocket: async () => fake.socket,
      },
      { known: false },
    );
    later.devices = rest.devices;
    later.deviceKey = rest.deviceKey.publicKey;
    expect(client.device).toBe('unknown');
    expect(server.deviceId).toBeNull();

    const refused = await client.fetch('/api/v1/bots');
    expect(refused.status).toBe(403);
    expect(refused.headers.get('content-type')).toBe('application/json');
    expect(await refused.json()).toMatchObject({
      code: 'DEVICE_UNKNOWN',
      message: expect.any(String),
    });
    expect((await client.fetch('/api/v1/devices/pair')).status).toBe(403);

    const ws = client.createSocket('/ws');
    const events = socketEvents(ws);
    await waitFor(() => events.some((event) => event.type === 'close'));
    expect(ws.upgradeResponse?.status).toBe(403);
    expect(calls).toEqual([]);

    const paired = await client.fetch('/api/v1/devices/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: 'pk' }),
    });
    expect(paired.status).toBe(200);
    expect(calls).toEqual([{ path: '/api/v1/devices/pair', meta: { deviceId: null } }]);
    expect(server.deviceId).toBe('device-new');
    expect(server.device).toBe('known');
    expect(client.device).toBe('known');

    const bots = await client.fetch('/api/v1/bots');
    expect(bots.status).toBe(200);
    expect(calls.at(-1)).toEqual({ path: '/api/v1/bots', meta: { deviceId: 'device-new' } });
    const ws2 = client.createSocket('/ws');
    await waitFor(() => ws2.readyState === 1);
  });

  it('keeps an unknown device unknown when pairing fails', async () => {
    const { client, server } = await setup(
      { fetch: async () => Response.json({ code: 'PAIRING_INVALID' }, { status: 401 }) },
      { known: false },
    );
    const response = await client.fetch('/api/v1/devices/pair', { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    expect(server.deviceId).toBeNull();
    expect((await client.fetch('/api/v1/bots')).status).toBe(403);
  });

  it('answers a handler that throws with an `internal` error', async () => {
    const { client } = await setup({
      fetch: async () => {
        throw new Error('database down');
      },
    });
    await expect(client.fetch('/api/v1/bots')).rejects.toMatchObject({
      code: 'internal',
      message: 'database down',
    });
    expect((await client.ping()) >= 0).toBe(true);
  });

  it('fires onClose on both ends when the transport closes, and fails what is open', async () => {
    const release = gate();
    const { client, server } = await setup({
      fetch: async () => {
        await release.promise;
        return new Response('late');
      },
    });
    const fake = fakeSocket();
    const clientClosed = vi.fn();
    const serverClosed = vi.fn();
    client.onClose(clientClosed);
    server.onClose(serverClosed);
    const pending = client.fetch('/api/v1/slow');
    pending.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    server.close(4410, 'host gone');
    await expect(pending).rejects.toBeInstanceOf(TunnelClosedError);
    await waitFor(
      () => clientClosed.mock.calls.length === 1 && serverClosed.mock.calls.length === 1,
    );
    expect(clientClosed).toHaveBeenCalledWith(4410, 'host gone');
    expect(serverClosed).toHaveBeenCalledWith(4410, 'host gone');
    expect(client.closed).toBe(true);
    await expect(client.fetch('/api/v1/bots')).rejects.toBeInstanceOf(TunnelClosedError);
    await expect(client.ping()).rejects.toBeInstanceOf(TunnelClosedError);
    const ws = client.createSocket('/ws');
    const events = socketEvents(ws);
    await waitFor(() => events.some((event) => event.type === 'close'));
    expect(fake.closes).toEqual([]);
    release.release();
  });

  it('answers ping with pong', async () => {
    const { client, server } = await setup({});
    expect(await client.ping()).toBeGreaterThanOrEqual(0);
    expect(await server.ping()).toBeGreaterThanOrEqual(0);
  });

  it('closes the stream 4400 when a direction reaches its message limit', async () => {
    const { client, server } = await setup(
      { fetch: async () => new Response('x') },
      { clientLimits: { maxMessages: 4 } },
    );
    const closed = vi.fn();
    server.onClose(closed);
    await client.ping();
    await client.ping();
    await client.ping();
    await client.ping();
    await expect(client.ping()).rejects.toMatchObject({ closeCode: 4400 });
    await waitFor(() => closed.mock.calls.length === 1);
    expect(closed).toHaveBeenCalledWith(4400, 'noise counter exhausted');
  });
});

describe('handshake failures', () => {
  it('fails when the pinned server key is wrong, closing 4400', async () => {
    const serverKey = generateDeviceKey();
    const [a, b] = memoryTransportPair();
    const closed = vi.fn();
    a.onClose(closed);
    const server = createTunnelServer({
      transport: b,
      staticKey: serverKey.privateKey,
      lookupDevice: async () => ({ known: false }),
      handler: { fetch: async () => new Response(), openSocket: async () => new Response() },
    });
    const client = createTunnelClient({
      transport: a,
      serverKey: generateDeviceKey().publicKey,
      staticKey: generateDeviceKey().privateKey,
    });
    await expect(server).rejects.toBeInstanceOf(TunnelHandshakeError);
    await expect(client).rejects.toBeInstanceOf(TunnelHandshakeError);
    await waitFor(() => closed.mock.calls.length === 1);
    expect(closed.mock.calls[0]![0]).toBe(4400);
  });

  it('times out when the server never answers', async () => {
    const [a] = memoryTransportPair();
    await expect(
      createTunnelClient({
        transport: a,
        serverKey: generateDeviceKey().publicKey,
        staticKey: generateDeviceKey().privateKey,
        handshakeTimeoutMs: 20,
      }),
    ).rejects.toThrow(/within 20 ms/);
  });
});

/** A hand-driven client: the handshake, then raw frames, for protocol error tests. */
async function rawClient() {
  const serverKey = generateDeviceKey();
  const deviceKey = generateDeviceKey();
  const [a, b] = memoryTransportPair();
  const fetches: Request[] = [];
  const serverPromise = createTunnelServer({
    transport: b,
    staticKey: serverKey.privateKey,
    lookupDevice: async () => ({ known: true, id: 'raw' }),
    handler: {
      fetch: async (request) => {
        fetches.push(request);
        await new Promise((resolve) => request.signal.addEventListener('abort', resolve));
        return new Response('never');
      },
      openSocket: async () => new Response(null, { status: 404 }),
    },
  });
  const received: ReturnType<typeof decodeFrame>[] = [];
  const handshake = new HandshakeState({
    initiator: true,
    staticKey: {
      privateKey: deviceKey.privateKey,
      publicKey: x25519PublicKey(deviceKey.privateKey),
    },
    remoteStaticKey: serverKey.publicKey,
  });
  let ciphers: TransportCiphers | null = null;
  let closedWith: [number, string] | null = null;
  const reply = new Promise<void>((resolve) => {
    a.onMessage((bytes) => {
      if (!ciphers) {
        handshake.readMessage(bytes);
        ciphers = handshake.split();
        resolve();
        return;
      }
      received.push(decodeFrame(ciphers.receive.decrypt(bytes)));
    });
  });
  a.onClose((code, reason) => (closedWith = [code, reason]));
  a.send(handshake.writeMessage(new TextEncoder().encode('{"v":1}')));
  await reply;
  const server = await serverPromise;
  return {
    server,
    received,
    fetches,
    closed: () => closedWith,
    send: (frame: FrameInit) => a.send(ciphers!.send.encrypt(encodeFrame(frame))),
    sendRaw: (bytes: Uint8Array) => a.send(bytes),
  };
}

describe('protocol errors', () => {
  it('answers a frame in the wrong state with a stream-level protocol error and 4400', async () => {
    const raw = await rawClient();
    raw.send({
      type: FrameType.HttpRes,
      id: 1,
      flags: FLAG_END,
      header: { status: 200, headers: {} },
    });
    await waitFor(() => raw.closed() !== null);
    expect(raw.received.at(-1)).toMatchObject({
      type: FrameType.Error,
      id: 0,
      header: { code: 'protocol' },
    });
    expect(raw.closed()![0]).toBe(4400);
  });

  it('refuses an even id, a reused id and a malformed header', async () => {
    for (const frames of [
      [
        {
          type: FrameType.HttpReq,
          id: 2,
          flags: FLAG_END,
          header: { method: 'GET', path: '/', headers: {} },
        },
      ],
      [
        {
          type: FrameType.HttpReq,
          id: 1,
          flags: FLAG_END,
          header: { method: 'GET', path: '/a', headers: {} },
        },
        {
          type: FrameType.HttpReq,
          id: 1,
          flags: FLAG_END,
          header: { method: 'GET', path: '/a', headers: {} },
        },
      ],
      [
        {
          type: FrameType.HttpReq,
          id: 1,
          flags: FLAG_END,
          header: { method: 'GET', path: 'no-slash' },
        },
      ],
      [
        {
          type: FrameType.HttpReq,
          id: 1,
          flags: FLAG_END,
          header: { method: 'GET', path: '/', headers: { a: 1 } },
        },
      ],
      [{ type: FrameType.Credit, id: 1, header: { bytes: -5 } }],
      [{ type: FrameType.HttpBody, id: 7, flags: FLAG_END }],
    ] as FrameInit[][]) {
      const raw = await rawClient();
      for (const frame of frames) raw.send(frame);
      await waitFor(() => raw.closed() !== null);
      expect(raw.received.at(-1)).toMatchObject({
        type: FrameType.Error,
        id: 0,
        header: { code: 'protocol' },
      });
      expect(raw.closed()![0]).toBe(4400);
    }
  });

  it('closes 4400 on a message that does not decrypt', async () => {
    const raw = await rawClient();
    raw.sendRaw(new Uint8Array(40));
    await waitFor(() => raw.closed() !== null);
    expect(raw.closed()).toEqual([4400, 'decryption failed']);
  });

  it('fails every open request on a stream-level error from the peer, then closes 4400', async () => {
    const raw = await rawClient();
    raw.send({
      type: FrameType.HttpReq,
      id: 1,
      flags: FLAG_END,
      header: { method: 'GET', path: '/slow', headers: {} },
    });
    await waitFor(() => raw.fetches.length === 1);
    raw.send({
      type: FrameType.Error,
      id: 0,
      header: { code: 'internal', message: 'client broke' },
    });
    await waitFor(() => raw.closed() !== null);
    expect(raw.closed()![0]).toBe(4400);
    expect(raw.fetches[0]!.signal.aborted).toBe(true);
    expect(raw.server.closed).toBe(true);
  });

  it('refuses a sender that goes past the window', async () => {
    const raw = await rawClient();
    raw.send({
      type: FrameType.HttpReq,
      id: 1,
      header: { method: 'POST', path: '/upload', headers: {} },
    });
    const chunk = new Uint8Array(60_000);
    for (let n = 0; n < 18; n++) raw.send({ type: FrameType.HttpBody, id: 1, body: chunk });
    await waitFor(() => raw.closed() !== null);
    expect(raw.received.at(-1)).toMatchObject({
      type: FrameType.Error,
      id: 0,
      header: { code: 'protocol' },
    });
  });

  it('drops late frames for an id it already closed', async () => {
    const raw = await rawClient();
    raw.send({
      type: FrameType.HttpReq,
      id: 1,
      header: { method: 'POST', path: '/upload', headers: {} },
    });
    await waitFor(() => raw.fetches.length === 1);
    raw.send({ type: FrameType.Error, id: 1, header: { code: 'cancelled', message: '' } });
    raw.send({ type: FrameType.HttpBody, id: 1, flags: FLAG_END, body: new Uint8Array(5) });
    raw.send({ type: FrameType.Ping, id: 0, header: { ts: 42 } });
    await waitFor(() => raw.received.some((frame) => frame.type === FrameType.Pong));
    expect(raw.closed()).toBeNull();
    expect(raw.fetches[0]!.signal.aborted).toBe(true);
    expect(raw.received.find((frame) => frame.type === FrameType.Pong)?.header).toEqual({ ts: 42 });
  });
});
