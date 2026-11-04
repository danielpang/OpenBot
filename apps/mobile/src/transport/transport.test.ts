import { describe, expect, it, vi } from 'vitest';
import { connectHost, createDirectTransport, normalizeServerUrl } from './index';
import type { SavedHost } from '../hosts/types';
import {
  base64urlEncode,
  createTunnelServer,
  generateDeviceKey,
  memoryTransportPair,
  type BinaryWebSocketLike,
} from '@openbots/tunnel';

describe('direct transport', () => {
  it('requires HTTPS or explicit local HTTP and refuses credentials and public HTTP', () => {
    expect(normalizeServerUrl('https://example.com/')).toBe('https://example.com');
    expect(normalizeServerUrl('http://192.168.1.5:8080', true)).toBe('http://192.168.1.5:8080');
    for (const url of [
      'http://example.com',
      'https://user:pass@example.com',
      'https://example.com/api',
      'http://192.168.1.5',
    ])
      expect(() => normalizeServerUrl(url)).toThrow();
  });

  it('adds a bearer key and never sends it to another origin', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const transport = createDirectTransport('https://bots.example.com', 'secret', {
      fetch: fetchImpl,
    });
    await transport.fetch('/api/v1/bots', { headers: { 'x-test': 'yes' } });
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer secret',
    );
    await expect(transport.fetch('https://evil.example.com/steal')).rejects.toThrow(
      'another server',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls through failed direct probes and returns the reachable origin', async () => {
    const host: SavedHost = {
      id: 'host',
      name: 'host',
      kind: 'server',
      directUrls: ['https://offline.example.com', 'https://online.example.com'],
      relayUrl: null,
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('offline')) throw new TypeError('Network request failed');
      return Response.json({ user: {} });
    });
    const transport = await connectHost(host, { apiKey: 'secret' }, { fetch: fetchImpl });
    expect(transport.baseUrl).toBe('https://online.example.com');
    transport.close();
  });

  it('opens authenticated binary sockets on the chosen host and closes them with the transport', () => {
    const binary: BinaryWebSocketLike = {
      readyState: 1,
      binaryType: '',
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: vi.fn(),
      close: vi.fn(),
    };
    const createSocket = vi.fn(() => binary);
    const transport = createDirectTransport('https://bots.example.com', 'device-key', {
      createSocket,
    });
    const socket = transport.createBinarySocket('/api/v1/bots/ada/screen/vnc');
    expect(createSocket).toHaveBeenCalledWith('wss://bots.example.com/api/v1/bots/ada/screen/vnc', {
      authorization: 'Bearer device-key',
    });
    expect(socket.binaryType).toBe('arraybuffer');
    const bytes = new Uint8Array([1, 2, 3]);
    socket.send(bytes);
    expect(binary.send).toHaveBeenCalledWith(bytes);
    expect(() => transport.createBinarySocket('wss://evil.example.com/vnc')).toThrow('origin');
    transport.close();
    expect(binary.close).toHaveBeenCalledOnce();
  });
});

describe('relay transport', () => {
  it('does not contact the shared relay for unpaired URL/API-key connections', async () => {
    const createRelaySocket = vi.fn();
    await expect(
      connectHost(
        {
          id: 'server-https://bots.example.com',
          name: 'Server',
          kind: 'server',
          directUrls: ['https://bots.example.com'],
          relayUrl: null,
        },
        { apiKey: 'secret' },
        {
          fetch: async () => {
            throw new Error('Offline');
          },
          createRelaySocket,
        },
      ),
    ).rejects.toThrow('Cannot reach this server');
    expect(createRelaySocket).not.toHaveBeenCalled();
  });
  it.each([
    ['wss://relay.example.com', 'wss://relay.example.com'],
    [null, 'wss://openbots-relay.fly.dev'],
  ])('uses pinned Noise and authenticated HTTP with relay %s', async (relayUrl, expectedRelay) => {
    const serverKey = generateDeviceKey();
    const deviceKey = generateDeviceKey();
    const [devicePipe, serverPipe] = memoryTransportPair();
    const fetchHandler = vi.fn(async (request: Request) => {
      expect(request.headers.get('authorization')).toBe('Bearer relay-secret');
      expect(new URL(request.url).pathname).toBe('/api/v1/bots');
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"items":'));
            controller.enqueue(new TextEncoder().encode('[]}'));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    const serverReady = createTunnelServer({
      transport: serverPipe,
      staticKey: serverKey.privateKey,
      lookupDevice: async () => ({ known: true, id: 'device' }),
      handler: {
        fetch: fetchHandler,
        openSocket: async (path, headers) => {
          expect(path).toBe('/api/v1/bots/ada/screen/vnc');
          expect(headers.authorization).toBe('Bearer relay-secret');
          let emit: ((data: string | Uint8Array) => void) | undefined;
          return {
            send: (data) => emit?.(data),
            close() {},
            onMessage: (handler) => {
              emit = handler;
            },
            onClose() {},
          };
        },
      },
    });
    const transport = await connectHost(
      {
        id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
        name: 'Mac',
        kind: 'paired',
        directUrls: [],
        relayUrl,
        serverPublicKey: base64urlEncode(serverKey.publicKey),
      },
      { apiKey: 'relay-secret', devicePrivateKey: base64urlEncode(deviceKey.privateKey) },
      {
        createRelaySocket(url) {
          expect(url).toBe(`${expectedRelay}/v1/connect/aaaaaaaaaaaaaaaaaaaaaaaaaa`);
          const socket: BinaryWebSocketLike = {
            readyState: 1,
            binaryType: 'arraybuffer',
            onopen: null,
            onclose: null,
            onmessage: null,
            onerror: null,
            send: (bytes) =>
              devicePipe.send(
                bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer),
              ),
            close: (code, reason) => devicePipe.close(code, reason),
          };
          devicePipe.onMessage((bytes) => socket.onmessage?.({ data: bytes }));
          devicePipe.onClose((code, reason) => socket.onclose?.({ code, reason }));
          queueMicrotask(() => socket.onmessage?.({ data: '{"type":"open","v":1}' }));
          return socket;
        },
      },
    );
    const server = await serverReady;
    try {
      expect(transport.kind).toBe('relay');
      const response = await transport.fetch('/api/v1/bots');
      expect(await response.json()).toEqual({ items: [] });
      expect(fetchHandler).toHaveBeenCalledOnce();
      const socket = transport.createBinarySocket('/api/v1/bots/ada/screen/vnc');
      const received = new Promise<unknown>((resolve, reject) => {
        socket.onopen = () => socket.send(new Uint8Array([0, 1, 255]));
        socket.onmessage = (event) => resolve(event.data);
        socket.onerror = reject;
      });
      expect(new Uint8Array((await received) as ArrayBuffer)).toEqual(new Uint8Array([0, 1, 255]));
    } finally {
      transport.close();
      server.close();
    }
  });
});
