import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRelay, type Relay } from '@openbots/relay';
import { wsEvent } from '@openbots/shared';
import {
  connectThroughRelay,
  createTunnelClient,
  generateDeviceKey,
  base64urlEncode,
  type ByteTransport,
  type KeyPair,
  type TunnelClient,
} from '@openbots/tunnel';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { publishEvent } from '../infra/index.js';
import { ensureInstanceKey, type InstanceKey } from '../services/instance-key.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { CLOSE_REVOKED, startRelayAdapter, type RelayAdapter } from './adapter.js';
import { createRelayLink, type HostRelayLink } from './link.js';

// The adapter between a real relay and a fake loopback target: an HTTP server
// that echoes what it was sent, and a WebSocket echo on `/echo`. What reaches
// the target is what the server's own port would see from a tunneled client.

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Echo {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

describe('relay adapter', () => {
  let t: TestApp;
  let relay: Relay;
  let instance: InstanceKey;
  let deps: AppDeps;
  let link: HostRelayLink;
  let adapter: RelayAdapter;
  let target: Server;
  let workspaceId: string;
  let ownerId: string;
  let known: KeyPair;
  let knownId: string;
  const clients: TunnelClient[] = [];
  const transports: ByteTransport[] = [];

  const relayUrl = () => relay.url.replace(/^http/, 'ws');
  const targetPort = () => (target.address() as AddressInfo).port;

  /** Starts the adapter again with these options, for one test. */
  async function restartAdapter(extra: Partial<Parameters<typeof startRelayAdapter>[1]> = {}) {
    await adapter.stop();
    adapter = startRelayAdapter(deps, { link, instance, port: targetPort(), ...extra });
  }

  /** A paired device of the owner's, made in the database. */
  async function addDevice() {
    const key = generateDeviceKey();
    const [row] = await t.db
      .insert(schema.devices)
      .values({
        workspaceId,
        ownerId,
        name: 'Spare',
        platform: 'ios',
        publicKey: Buffer.from(key.publicKey),
      })
      .returning();
    return { key, id: row!.id };
  }

  /** Revokes a device as `openbots devices revoke` in another process would: no event reaches this one. */
  const revokeInDatabase = (id: string) =>
    t.db
      .update(schema.devices)
      .set({ revokedAt: new Date(), publicKey: null })
      .where(eq(schema.devices.id, id));

  async function open(staticKey: Uint8Array) {
    const transport = await connectThroughRelay({
      relayUrl: relayUrl(),
      hostId: instance.hostId,
      createSocket: (url) => new WebSocket(url),
    });
    transports.push(transport);
    const client = await createTunnelClient({
      transport,
      serverKey: instance.tunnelPublicKey,
      staticKey,
    });
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    relay = await createRelay({ port: 0, host: '127.0.0.1', limits: { streamsPerHost: 20 } });
    t = await createTestApp();
    await t.signUp('owner@example.com');
    ownerId = await t.userId('owner@example.com');
    workspaceId = await t.defaultOrganization();
    deps = { ...t.deps, config: { ...t.deps.config, relayUrl: relayUrl() } };
    instance = await ensureInstanceKey({ db: t.deps.db, config: t.deps.config });
    known = generateDeviceKey();
    const [device] = await t.db
      .insert(schema.devices)
      .values({
        workspaceId,
        ownerId,
        name: 'Phone',
        platform: 'ios',
        publicKey: Buffer.from(known.publicKey),
      })
      .returning();
    knownId = device!.id;

    target = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'https://elsewhere.example/' }).end();
          return;
        }
        const echo: Echo = {
          method: req.method!,
          url: req.url!,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'a=b' });
        res.end(JSON.stringify(echo));
      });
    });
    const wss = new WebSocketServer({ noServer: true });
    target.on('upgrade', (req, socket, head) => {
      if (req.url !== '/echo') {
        socket.end(
          'HTTP/1.1 401 Unauthorized\r\ncontent-type: text/plain\r\ncontent-length: 4\r\n\r\nnope',
        );
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(
          JSON.stringify({
            origin: req.headers.origin ?? null,
            device: req.headers['x-openbots-device'],
          }),
        );
        ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
        ws.on('close', () => {});
      });
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));

    link = await createRelayLink(deps, {
      instance,
      timing: { initialBackoffMs: 50, maxBackoffMs: 200 },
    });
    adapter = startRelayAdapter(deps, {
      link,
      instance,
      port: (target.address() as AddressInfo).port,
    });
    await waitFor(() => link.status().status === 'linked');
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const transport of transports.splice(0)) transport.close();
    await waitFor(() => adapter.sessions() === 0);
  });

  afterAll(async () => {
    await adapter.stop();
    await link.stop();
    await relay.close();
    await new Promise((resolve) => target.close(resolve));
    await t.close();
  });

  it('serves an unknown device pairing only, keyed on its stream', async () => {
    const stranger = generateDeviceKey();
    const client = await open(stranger.privateKey);
    expect(client.device).toBe('unknown');
    const refused = await client.fetch('/api/v1/bots');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'DEVICE_UNKNOWN' });

    const res = await client.fetch('/api/v1/devices/pair?x=1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        cookie: 'c=d',
      },
      body: JSON.stringify({ hello: true }),
    });
    expect(res.status).toBe(200);
    const echo = (await res.json()) as Echo;
    expect(echo.method).toBe('POST');
    expect(echo.url).toBe('/api/v1/devices/pair?x=1');
    expect(echo.body).toBe('{"hello":true}');
    expect(echo.headers['x-openbots-device']).toMatch(/^stream:\d+$/);
    expect(echo.headers['x-openbots-device-key']).toBe(base64urlEncode(stranger.publicKey));
    expect(echo.headers.origin).toBeUndefined();
    expect(echo.headers.cookie).toBeUndefined();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('forwards a known device’s requests with its id, and never follows a redirect', async () => {
    const client = await open(known.privateKey);
    expect(client.device).toBe('known');
    const res = await client.fetch('/api/v1/bots?limit=2', {
      headers: {
        authorization: 'Bearer obk_x',
        'x-openbots-device': 'spoofed',
        'x-openbots-adapter': 'spoofed',
      },
    });
    const echo = (await res.json()) as Echo;
    expect(echo.url).toBe('/api/v1/bots?limit=2');
    expect(echo.headers['x-openbots-device']).toBe(knownId);
    expect(echo.headers['x-openbots-adapter']).not.toBe('spoofed');
    expect(echo.headers['x-openbots-adapter']).toBeTruthy();
    expect(echo.headers.authorization).toBe('Bearer obk_x');
    expect(echo.headers['x-openbots-device-key']).toBeUndefined();

    const redirect = await client.fetch('/redirect', { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('https://elsewhere.example/');
  });

  it('pipes a WebSocket both ways with no Origin, and answers a refused upgrade', async () => {
    const client = await open(known.privateKey);
    const socket = client.createSocket('/echo', { headers: { origin: 'https://evil.example' } });
    const messages: string[] = [];
    socket.onmessage = (event) => messages.push(String(event.data));
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('socket failed'));
    });
    await waitFor(() => messages.length === 1);
    expect(JSON.parse(messages[0]!)).toEqual({ origin: null, device: knownId });
    socket.send('ping through the tunnel');
    await waitFor(() => messages.length === 2);
    expect(messages[1]).toBe('ping through the tunnel');
    const closed = new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve((event as { code: number }).code);
    });
    socket.close(1000, 'done');
    expect(await closed).toBe(1000);

    const refused = client.createSocket('/elsewhere');
    const response = await new Promise<Response>((resolve) => {
      refused.onerror = (event) => resolve((event as unknown as { response: Response }).response);
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('nope');
  });

  it('closes a device’s streams when it is revoked', async () => {
    const client = await open(known.privateKey);
    const other = await open(generateDeviceKey().privateKey);
    const closed = new Promise<number>((resolve) => client.onClose((code) => resolve(code)));
    await publishEvent(
      t.deps.infra.bus,
      wsEvent(
        'device.revoked',
        {
          device: {
            id: knownId,
            name: 'Phone',
            platform: 'ios',
            createdAt: new Date().toISOString(),
            revokedAt: new Date().toISOString(),
          },
        },
        { user_id: ownerId, workspace_id: workspaceId },
      ),
    );
    expect(await closed).toBe(CLOSE_REVOKED);
    // Another device's stream is untouched.
    expect(other.closed).toBe(false);
    expect((await other.fetch('/api/v1/bots')).status).toBe(403);
  });

  it('closes a revoked device’s stream on its timer when no event comes', async () => {
    const spare = await addDevice();
    await restartAdapter({ recheckMs: 100 });
    try {
      const client = await open(spare.key.privateKey);
      const other = await open(known.privateKey);
      expect(client.device).toBe('known');
      expect((await client.fetch('/api/v1/bots')).status).toBe(200);
      const closed = new Promise<number>((resolve) => client.onClose((code) => resolve(code)));
      await revokeInDatabase(spare.id);
      expect(await closed).toBe(CLOSE_REVOKED);
      // A device still paired keeps its stream.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(other.closed).toBe(false);
    } finally {
      await restartAdapter();
    }
  });

  it('looks a stale session’s device up before serving it, and refuses a revoked one', async () => {
    const spare = await addDevice();
    // Every request finds its last check stale; the timer never runs in the test.
    await restartAdapter({ recheckMs: 0, recheckIntervalMs: 3_600_000 });
    try {
      const client = await open(spare.key.privateKey);
      expect((await client.fetch('/api/v1/bots')).status).toBe(200);
      const closed = new Promise<number>((resolve) => client.onClose((code) => resolve(code)));
      await revokeInDatabase(spare.id);
      const refused = await client.fetch('/api/v1/bots');
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({ code: 'DEVICE_REVOKED' });
      expect(await closed).toBe(CLOSE_REVOKED);
    } finally {
      await restartAdapter();
    }
  });

  it('caps open sessions at 8 and closes a ninth 4429', async () => {
    for (let i = 0; i < 8; i++) await open(generateDeviceKey().privateKey);
    expect(adapter.sessions()).toBe(8);
    const transport = await connectThroughRelay({
      relayUrl: relayUrl(),
      hostId: instance.hostId,
      createSocket: (url) => new WebSocket(url),
    });
    transports.push(transport);
    const code = await new Promise<number>((resolve) => transport.onClose((c) => resolve(c)));
    expect(code).toBe(4429);
    // A slot frees when a session closes.
    clients.shift()!.close();
    await waitFor(() => adapter.sessions() === 7);
    const again = await open(generateDeviceKey().privateKey);
    expect(again.device).toBe('unknown');
  });

  it('closes a stream whose handshake is not the tunnel’s', async () => {
    const transport = await connectThroughRelay({
      relayUrl: relayUrl(),
      hostId: instance.hostId,
      createSocket: (url) => new WebSocket(url),
    });
    transports.push(transport);
    const closed = new Promise<number>((resolve) => transport.onClose((c) => resolve(c)));
    transport.send(new Uint8Array([1, 2, 3]));
    expect(await closed).toBe(4400);
  });
});
