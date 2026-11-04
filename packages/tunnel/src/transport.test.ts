import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createTunnelClient } from './client.js';
import { generateDeviceKey } from './keys.js';
import { createTunnelServer } from './server.js';
import { fromWebSocket, memoryTransportPair, type BinaryWebSocketLike } from './transport.js';

let wss: WebSocketServer;
let url: string;
const serverKey = generateDeviceKey();

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  wss.on('connection', (socket, request) => {
    if (request.url === '/echo') {
      socket.on('message', (data, isBinary) => {
        if (isBinary) socket.send(data, { binary: true });
        else socket.send(`text:${String(data)}`);
      });
      return;
    }
    if (request.url === '/close') {
      socket.close(4410, 'host gone');
      return;
    }
    // A tunnel server on a plain server-side `ws` socket.
    void createTunnelServer({
      transport: fromWebSocket(socket as unknown as BinaryWebSocketLike),
      staticKey: serverKey.privateKey,
      lookupDevice: async () => ({ known: false }),
      handler: {
        fetch: async () => new Response('unused'),
        openSocket: async () => new Response(null, { status: 500 }),
      },
    }).catch(() => {});
  });
});

afterAll(async () => {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

describe('fromWebSocket', () => {
  it('queues sends until the socket opens, then carries binary frames and ignores text', async () => {
    const socket = new WebSocket(`${url}/echo`);
    const transport = fromWebSocket(socket as unknown as BinaryWebSocketLike);
    expect(socket.binaryType).toBe('arraybuffer');
    const received: Uint8Array[] = [];
    transport.send(new Uint8Array([1, 2]));
    transport.onMessage((bytes) => received.push(bytes));
    await expect.poll(() => received.length).toBe(1);
    expect(received[0]).toEqual(new Uint8Array([1, 2]));
    expect(received[0]).toBeInstanceOf(Uint8Array);
    // A text frame from the far end is not stream data.
    socket.send('hello');
    transport.send(new Uint8Array([3]));
    await expect.poll(() => received.length).toBe(2);
    expect(received[1]).toEqual(new Uint8Array([3]));
    const closed = new Promise<[number, string]>((resolve) =>
      transport.onClose((code, reason) => resolve([code, reason])),
    );
    transport.close(4000, 'bye');
    expect(await closed).toEqual([4000, 'bye']);
  });

  it('reports the far end close code', async () => {
    const transport = fromWebSocket(
      new WebSocket(`${url}/close`) as unknown as BinaryWebSocketLike,
    );
    const closed = await new Promise<[number, string]>((resolve) =>
      transport.onClose((code, reason) => resolve([code, reason])),
    );
    expect(closed).toEqual([4410, 'host gone']);
  });

  it('carries a tunnel between real sockets', async () => {
    const client = await createTunnelClient({
      transport: fromWebSocket(new WebSocket(`${url}/tunnel`) as unknown as BinaryWebSocketLike),
      serverKey: serverKey.publicKey,
      staticKey: generateDeviceKey().privateKey,
    });
    expect(client.device).toBe('unknown');
    const response = await client.fetch('/api/v1/bots');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'DEVICE_UNKNOWN' });
    const closed = new Promise<number>((resolve) => client.onClose((code) => resolve(code)));
    client.close();
    expect(await closed).toBe(1000);
  });
});

describe('memoryTransportPair', () => {
  it('delivers in order, holds messages until a handler arrives, and closes both ends after pending messages', async () => {
    const [a, b] = memoryTransportPair();
    a.send(new Uint8Array([1]));
    a.send(new Uint8Array([2]));
    const order: string[] = [];
    a.close(4001, 'done');
    await Promise.resolve();
    b.onMessage((bytes) => order.push(`message ${bytes[0]}`));
    a.onClose((code) => order.push(`a close ${code}`));
    b.onClose((code, reason) => order.push(`close ${code} ${reason}`));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['message 1', 'message 2', 'a close 4001', 'close 4001 done']);
    a.send(new Uint8Array([3]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toHaveLength(4);
  });
});
