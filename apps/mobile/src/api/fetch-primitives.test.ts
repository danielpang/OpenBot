import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@openbots/api-client';
import {
  createTunnelClient,
  createTunnelServer,
  generateDeviceKey,
  memoryTransportPair,
} from '@openbots/tunnel';
import { streamFetchPrimitives } from './fetch-primitives';
import { createDirectTransport } from '../transport';
import type * as ExpoRequestUtils from 'expo/build/winter/fetch/RequestUtils';

// Resolve implementation through Vitest, while typechecking against Expo's public
// declarations rather than pulling the package's uncompiled source into our tsc graph.
const { normalizeBodyInitAsync, normalizeHeadersInit } = await vi.importActual<
  typeof ExpoRequestUtils
>('expo/src/winter/fetch/RequestUtils');

// React Native installs these exact constructors (not a browser's streaming classes).
const require = createRequire(import.meta.url);
const nativeRequire = createRequire(require.resolve('react-native/package.json'));
const legacy = nativeRequire('whatwg-fetch') as {
  Request: typeof Request;
  Response: typeof Response;
  Headers: typeof Headers;
};
let RequestClass: typeof Request;
let ResponseClass: typeof Response;
beforeEach(() => {
  const primitives = streamFetchPrimitives(legacy.Request, legacy.Response);
  RequestClass = primitives.Request;
  ResponseClass = primitives.Response;
  vi.stubGlobal('Request', RequestClass);
  vi.stubGlobal('Response', ResponseClass);
  vi.stubGlobal('Headers', legacy.Headers);
});
afterEach(() => vi.unstubAllGlobals());

const chunks = (...parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });

describe('native stream fetch primitives', () => {
  it('reads real byte streams, preserves headers and status, clones independently, and rejects double reads', async () => {
    const response = new ResponseClass(chunks('{"message":', '"hello"}'), {
      status: 201,
      headers: { 'x-test': 'yes' },
    });
    const copy = response.clone();
    copy.headers.set('x-test', 'copy');
    expect(response.headers.get('x-test')).toBe('yes');
    expect(response.status).toBe(201);
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ message: 'hello' });
    expect(await copy.text()).toBe('{"message":"hello"}');
    expect(response.bodyUsed).toBe(true);
    await expect(response.text()).rejects.toThrow('consumed');
    expect(() => response.clone()).toThrow('consumed');
  });

  it('tracks direct reader consumption and rejects cloning a locked body', async () => {
    const response = new ResponseClass(chunks('hello'));
    const reader = response.body!.getReader();
    expect(() => response.clone()).toThrow('consumed');
    expect(response.bodyUsed).toBe(false);
    await reader.read();
    reader.releaseLock();
    expect(response.bodyUsed).toBe(true);
    expect(() => response.clone()).toThrow('consumed');
  });

  it('reads typed-array subviews without Native Blob construction and provides JSON helpers', async () => {
    const bytes = new Uint8Array([0, 65, 66, 255]);
    const response = new ResponseClass(bytes.subarray(1, 3));
    expect(await response.text()).toBe('AB');
    const json = ResponseClass.json({ ok: true });
    expect(json.headers.get('content-type')).toBe('application/json');
    expect(await json.json()).toEqual({ ok: true });
    expect(() => new ResponseClass('body', { status: 204 })).toThrow();
    expect(() => new RequestClass('https://example.com', { body: 'invalid' })).toThrow();
  });

  it('preserves native Request bodies, cloning, metadata, abort signals, and URL-encoded content types', async () => {
    const signal = new AbortController();
    const request = new RequestClass('https://example.com/post', {
      method: 'POST',
      body: new URLSearchParams({ text: 'hello world' }),
      signal: signal.signal,
      credentials: 'omit',
      headers: { 'x-test': 'yes' },
    });
    const copy = request.clone();
    expect(copy.method).toBe('POST');
    expect(copy.credentials).toBe('omit');
    expect(copy.headers.get('content-type')).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    );
    signal.abort();
    expect(copy.signal.aborted).toBe(true);
    expect(await request.text()).toBe('text=hello+world');
    expect(await copy.text()).toBe('text=hello+world');
    const native = new legacy.Request('https://example.com/post', {
      method: 'POST',
      body: 'legacy',
    });
    expect(await new RequestClass(native).text()).toBe('legacy');
  });

  it('passes openapi-fetch POST bytes and bearer headers to the actual Expo body normalizer', async () => {
    const transport = createDirectTransport('https://example.com', 'device-secret', {
      fetch: async (input, init) => {
        const request = input as Request;
        expect(request.method).toBe('POST');
        const headers = normalizeHeadersInit(init?.headers ?? request.headers);
        expect(headers).toContainEqual(['authorization', 'Bearer device-secret']);
        expect(headers).toContainEqual(['content-type', 'application/json']);
        const normalized = await normalizeBodyInitAsync(init?.body ?? request.body);
        expect(JSON.parse(new TextDecoder().decode(normalized.body!))).toEqual({ name: 'Ada' });
        return ResponseClass.json({ id: 'bot-1' }, { status: 201 });
      },
    });
    const client = createClient(transport.baseUrl, transport.fetch);
    const result = await client.POST('/api/v1/bots', { body: { name: 'Ada' } });
    expect(result.data).toMatchObject({ id: 'bot-1' });
  });

  it('runs the real shared Noise tunnel with native Request/Response globals and a streaming POST response', async () => {
    const serverKey = generateDeviceKey();
    const deviceKey = generateDeviceKey();
    const [a, b] = memoryTransportPair();
    const serverReady = createTunnelServer({
      transport: b,
      staticKey: serverKey.privateKey,
      lookupDevice: async () => ({ known: true, id: 'phone' }),
      handler: {
        async fetch(request) {
          expect(request.method).toBe('POST');
          expect(request.headers.get('authorization')).toBe('Bearer secret');
          expect(await request.json()).toEqual({ message: 'hello' });
          return new ResponseClass(chunks('{"reply":', '"streamed"}'), {
            headers: { 'content-type': 'application/json' },
          });
        },
        async openSocket() {
          return new ResponseClass(null, { status: 404 });
        },
      },
    });
    const client = await createTunnelClient({
      transport: a,
      serverKey: serverKey.publicKey,
      staticKey: deviceKey.privateKey,
    });
    const server = await serverReady;
    try {
      const request = new RequestClass('https://openbots.tunnel/api/v1/messages', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: chunks('{"message":', '"hello"}'),
      });
      const response = await client.fetch(request);
      expect(await response.json()).toEqual({ reply: 'streamed' });
    } finally {
      client.close();
      server.close();
    }
  });
});
