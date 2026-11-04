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
import {
  CLOSE_PAIRING_DONE,
  CLOSE_REVOKED,
  CLOSE_TOO_MANY,
  startRelayAdapter,
  type RelayAdapter,
} from './adapter.js';
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
  /** The known device's API key. */
  let knownKey: string;
  const clients: TunnelClient[] = [];
  const transports: ByteTransport[] = [];

  const relayUrl = () => relay.url.replace(/^http/, 'ws');
  const targetPort = () => (target.address() as AddressInfo).port;

  /** Starts the adapter again with these options, for one test. */
  async function restartAdapter(extra: Partial<Parameters<typeof startRelayAdapter>[1]> = {}) {
    await adapter.stop();
    adapter = startRelayAdapter(deps, { link, instance, port: targetPort(), ...extra });
  }

  /** An API key of the owner's, as a pairing makes one. */
  const apiKey = (name: string) =>
    t.deps.auth.api.createApiKey({ body: { name, userId: ownerId, expiresIn: null } });

  /** A paired device of the owner's, made in the database, in `workspace` (the default one). */
  async function addDevice(key = generateDeviceKey(), workspace = workspaceId) {
    const credential = await apiKey('Spare');
    const [row] = await t.db
      .insert(schema.devices)
      .values({
        workspaceId: workspace,
        ownerId,
        name: 'Spare',
        platform: 'ios',
        publicKey: Buffer.from(key.publicKey),
        apiKeyId: credential.id,
      })
      .returning();
    return { key, id: row!.id, apiKey: credential.key };
  }

  /** The close code of a stream the adapter refuses during its handshake. */
  async function refusedWith(staticKey: Uint8Array): Promise<number> {
    const transport = await connectThroughRelay({
      relayUrl: relayUrl(),
      hostId: instance.hostId,
      createSocket: (url) => new WebSocket(url),
    });
    transports.push(transport);
    const closed = new Promise<number>((resolve) => transport.onClose((c) => resolve(c)));
    await createTunnelClient({
      transport,
      serverKey: instance.tunnelPublicKey,
      staticKey,
    }).then(
      (client) => {
        clients.push(client);
        throw new Error('the handshake was accepted');
      },
      () => undefined,
    );
    return closed;
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
    // Every client here is one address; the relay's own per-address limits are not under test.
    relay = await createRelay({
      port: 0,
      host: '127.0.0.1',
      limits: {
        streamsPerHost: 20,
        addressStreamsPerHost: 20,
        addressOpensPerHostPerMinute: 1_000,
      },
    });
    t = await createTestApp();
    await t.signUp('owner@example.com');
    ownerId = await t.userId('owner@example.com');
    workspaceId = await t.defaultOrganization();
    deps = { ...t.deps, config: { ...t.deps.config, relayUrl: relayUrl() } };
    instance = await ensureInstanceKey({ db: t.deps.db, config: t.deps.config });
    known = generateDeviceKey();
    const credential = await apiKey('Phone');
    knownKey = credential.key;
    const [device] = await t.db
      .insert(schema.devices)
      .values({
        workspaceId,
        ownerId,
        name: 'Phone',
        platform: 'ios',
        publicKey: Buffer.from(known.publicKey),
        apiKeyId: credential.id,
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

  it('serves an unknown device one pairing only, keyed on its address, then closes', async () => {
    const stranger = generateDeviceKey();
    const client = await open(stranger.privateKey);
    expect(client.device).toBe('unknown');
    const closed = new Promise<number>((resolve) => client.onClose((code) => resolve(code)));
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
    // The relay's address for the client, not the stream id, which restarts on every link.
    expect(echo.headers['x-openbots-device']).toBe('remote:127.0.0.1');
    expect(echo.headers['x-openbots-device-key']).toBe(base64urlEncode(stranger.publicKey));
    expect(echo.headers.origin).toBeUndefined();
    expect(echo.headers.cookie).toBeUndefined();
    expect(res.headers.get('set-cookie')).toBeNull();
    // Paired or not, the session is over; the phone comes back as a device.
    expect(await closed).toBe(CLOSE_PAIRING_DONE);
  });

  it('closes an unknown session that does not pair in time', async () => {
    await restartAdapter({ unknownSessionMs: 150 });
    try {
      const client = await open(generateDeviceKey().privateKey);
      const closed = new Promise<number>((resolve) => client.onClose((code) => resolve(code)));
      expect(await closed).toBe(CLOSE_PAIRING_DONE);
    } finally {
      await restartAdapter();
    }
  });

  it('forwards a known device’s requests with its id, and never follows a redirect', async () => {
    const client = await open(known.privateKey);
    expect(client.device).toBe('known');
    const res = await client.fetch('/api/v1/bots?limit=2', {
      headers: {
        authorization: `Bearer ${knownKey}`,
        'x-openbots-device': 'spoofed',
        'x-openbots-adapter': 'spoofed',
      },
    });
    const echo = (await res.json()) as Echo;
    expect(echo.url).toBe('/api/v1/bots?limit=2');
    expect(echo.headers['x-openbots-device']).toBe(knownId);
    expect(echo.headers['x-openbots-adapter']).not.toBe('spoofed');
    expect(echo.headers['x-openbots-adapter']).toBeTruthy();
    expect(echo.headers.authorization).toBe(`Bearer ${knownKey}`);
    expect(echo.headers['x-openbots-device-key']).toBeUndefined();

    const redirect = await client.fetch('/redirect', { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('https://elsewhere.example/');
  });

  it('refuses a key that is not the device’s, so a session cannot carry another phone’s', async () => {
    const other = await addDevice();
    const script = await apiKey('script');
    const client = await open(known.privateKey);
    for (const key of [other.apiKey, script.key, 'obk_made_up']) {
      for (const headers of [{ authorization: `Bearer ${key}` }, { 'x-api-key': key }] as Record<
        string,
        string
      >[]) {
        const res = await client.fetch('/api/v1/bots', { headers });
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ code: 'DEVICE_KEY_MISMATCH' });
      }
    }
    const socket = client.createSocket('/echo', {
      headers: { authorization: `Bearer ${other.apiKey}` },
    });
    const response = await new Promise<Response>((resolve) => {
      socket.onerror = (event) => resolve((event as unknown as { response: Response }).response);
    });
    expect(response.status).toBe(401);
    // Its own key still goes through on the same session.
    const ok = await client.fetch('/api/v1/bots', {
      headers: { authorization: `Bearer ${knownKey}` },
    });
    expect(((await ok.json()) as Echo).headers['x-openbots-device']).toBe(knownId);
  });

  it('serves a phone paired with two organizations as the device whose key it sends', async () => {
    const phone = generateDeviceKey();
    const home = await addDevice(phone);
    const elsewhere = await addDevice(phone, await t.createOrganization('Elsewhere'));
    const client = await open(phone.privateKey);
    expect(client.device).toBe('known');
    const as = async (key: string) => {
      const res = await client.fetch('/api/v1/me', { headers: { authorization: `Bearer ${key}` } });
      return ((await res.json()) as Echo).headers['x-openbots-device'];
    };
    expect(await as(elsewhere.apiKey)).toBe(elsewhere.id);
    expect(await as(home.apiKey)).toBe(home.id);
    expect(await as(elsewhere.apiKey)).toBe(elsewhere.id);
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

  it('caps known devices at 8 and unknown ones at 2, each apart, closing the next 4429', async () => {
    const phones = [];
    for (let i = 0; i < 9; i++) phones.push(await addDevice());
    for (const phone of phones.slice(0, 8)) await open(phone.key.privateKey);
    expect(adapter.sessions()).toBe(8);
    expect(await refusedWith(phones[8]!.key.privateKey)).toBe(CLOSE_TOO_MANY);
    // Strangers have their own two places, and never a paired phone's.
    const first = await open(generateDeviceKey().privateKey);
    await open(generateDeviceKey().privateKey);
    expect(first.device).toBe('unknown');
    expect(await refusedWith(generateDeviceKey().privateKey)).toBe(CLOSE_TOO_MANY);
    expect(adapter.sessions()).toBe(10);
    // A known place frees when its session closes.
    clients.shift()!.close();
    await waitFor(() => adapter.sessions() === 9);
    const again = await open(phones[8]!.key.privateKey);
    expect(again.device).toBe('known');
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
