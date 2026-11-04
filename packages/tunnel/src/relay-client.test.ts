import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createTunnelClient } from './client.js';
import { generateDeviceKey, generateSigningKey, hostIdFromPublicKey } from './keys.js';
import {
  RelayConnectError,
  RelayPresenceError,
  connectThroughRelay,
  hostPresence,
} from './relay-client.js';
import { createTunnelServer } from './server.js';
import { fromWebSocket, type BinaryWebSocketLike, type ByteTransport } from './transport.js';

// A fake relay with one client endpoint: `/v1/connect/{hostId}` answers
// `open` for the one linked host and echoes its binary frames back (or, for
// the tunnel host, hands the socket to a tunnel server); any other host id is
// closed 4404 and a malformed one 4400.

const ONLINE = hostIdFromPublicKey(generateSigningKey().publicKey);
const TUNNEL_HOST = hostIdFromPublicKey(generateSigningKey().publicKey);
const BUSY = hostIdFromPublicKey(generateSigningKey().publicKey);
const serverKey = generateDeviceKey();

let relay: WebSocketServer;
let relayUrl: string;
const createSocket = (url: string) => new WebSocket(url) as unknown as BinaryWebSocketLike;

beforeAll(async () => {
  relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => relay.once('listening', () => resolve()));
  relayUrl = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  relay.on('connection', (socket, request) => {
    const match = /^\/v1\/connect\/([^/]+)$/.exec(request.url ?? '');
    const hostId = match?.[1] ?? '';
    if (!/^[a-z2-7]{26}$/.test(hostId)) return socket.close(4400, 'malformed host id');
    if (hostId === BUSY) return socket.close(4429, 'too many streams');
    if (hostId === TUNNEL_HOST) {
      socket.send(JSON.stringify({ type: 'open', v: 1 }));
      const transport: ByteTransport = fromWebSocket(socket as unknown as BinaryWebSocketLike);
      void createTunnelServer({
        transport,
        staticKey: serverKey.privateKey,
        lookupDevice: async () => ({ known: true, id: 'phone' }),
        handler: {
          fetch: async (req) =>
            Response.json({ path: new URL(req.url).pathname, body: await req.text() }),
          openSocket: async () => new Response(null, { status: 404 }),
        },
      }).catch(() => {});
      return;
    }
    if (hostId !== ONLINE) return socket.close(4404, 'host offline');
    socket.send(JSON.stringify({ type: 'open', v: 1 }));
    socket.on('message', (data, isBinary) => {
      if (isBinary) socket.send(data, { binary: true });
    });
  });
});

afterAll(async () => {
  for (const client of relay.clients) client.terminate();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
});

describe('connectThroughRelay', () => {
  it('resolves on `open` and carries binary frames both ways', async () => {
    const transport = await connectThroughRelay({
      relayUrl: `${relayUrl}/`,
      hostId: ONLINE,
      createSocket,
    });
    const received: Uint8Array[] = [];
    transport.onMessage((bytes) => received.push(bytes));
    transport.send(new Uint8Array([1, 2, 3]));
    transport.send(new Uint8Array(65_536).fill(7));
    await expect.poll(() => received.length).toBe(2);
    expect(received[0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(received[1]!.length).toBe(65_536);
    const closed = new Promise<[number, string]>((resolve) =>
      transport.onClose((code, reason) => resolve([code, reason])),
    );
    transport.close(1000, 'done');
    expect(await closed).toEqual([1000, 'done']);
  });

  it('rejects with the close code when the host is offline, busy or malformed', async () => {
    const offline = connectThroughRelay({
      relayUrl,
      hostId: hostIdFromPublicKey(generateSigningKey().publicKey),
      createSocket,
    });
    await expect(offline).rejects.toBeInstanceOf(RelayConnectError);
    await expect(offline).rejects.toMatchObject({
      code: 4404,
      reason: 'host offline',
      hostOffline: true,
    });
    await expect(
      connectThroughRelay({ relayUrl, hostId: BUSY, createSocket }),
    ).rejects.toMatchObject({ code: 4429 });
    await expect(
      connectThroughRelay({ relayUrl, hostId: 'NOPE', createSocket }),
    ).rejects.toMatchObject({ code: 4400 });
  });

  it('runs a whole tunnel through the relay', async () => {
    const transport = await connectThroughRelay({ relayUrl, hostId: TUNNEL_HOST, createSocket });
    const client = await createTunnelClient({
      transport,
      serverKey: serverKey.publicKey,
      staticKey: generateDeviceKey().privateKey,
    });
    expect(client.device).toBe('known');
    const response = await client.fetch('/api/v1/echo', {
      method: 'POST',
      body: 'x'.repeat(200_000),
    });
    expect(await response.json()).toEqual({ path: '/api/v1/echo', body: 'x'.repeat(200_000) });
    client.close();
  });

  it('honours an abort signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      connectThroughRelay({ relayUrl, hostId: ONLINE, createSocket, signal: controller.signal }),
    ).rejects.toThrow('stop');
  });
});

describe('hostPresence', () => {
  it('asks GET /v1/hosts/{hostId} over https for a wss relay', async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      return Response.json({ hostId: ONLINE, linked: url.endsWith(ONLINE) });
    }) as typeof fetch;
    expect(
      await hostPresence({ relayUrl: 'wss://relay.example/', hostId: ONLINE, fetch: fakeFetch }),
    ).toBe(true);
    expect(
      await hostPresence({ relayUrl: 'wss://relay.example', hostId: BUSY, fetch: fakeFetch }),
    ).toBe(false);
    expect(urls).toEqual([
      `https://relay.example/v1/hosts/${ONLINE}`,
      `https://relay.example/v1/hosts/${BUSY}`,
    ]);
  });

  it('throws on a malformed id and on an error status', async () => {
    const notFound = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expect(
      hostPresence({ relayUrl: 'ws://relay.local', hostId: 'bad', fetch: notFound }),
    ).rejects.toBeInstanceOf(RelayPresenceError);
    await expect(
      hostPresence({ relayUrl: 'ws://relay.local', hostId: ONLINE, fetch: notFound }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});
