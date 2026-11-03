import { createHash, randomBytes } from 'node:crypto';
import { createRelay, type PushGateway, type PushRequest, type Relay } from '@openbots/relay';
import { wsEvent, type WsEvent } from '@openbots/shared';
import {
  base64urlEncode,
  connectThroughRelay,
  createTunnelClient,
  generateDeviceKey,
  type KeyPair,
  type TunnelClient,
} from '@openbots/tunnel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { publishEvent } from '../infra/index.js';
import { createPairing } from '../services/devices.js';
import { ensureInstanceKey, type InstanceKey } from '../services/instance-key.js';
import { createTestApp, serveTestApp, type TestApp } from '../test-app.js';
import { decryptPush, startPushWorker, type PushWorker } from '../workers/push.js';
import { CLOSE_REVOKED, startRelayAdapter, type RelayAdapter } from './adapter.js';
import { createRelayLink, type HostRelayLink } from './link.js';

// Phase 1's acceptance check (MOBILE_AND_VM_PLAN.md section 11), end to end
// over real sockets: the test app served on an ephemeral port, a relay in
// process, the link and the adapter, and a Node client speaking the tunnel
// as the phone will. Pairing through the tunnel, REST and `/ws` with the
// device's key, a large upload, a push from a real notice, a device revoking
// itself over its own stream, and the link coming back after the relay
// restarts.

async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('relay end to end', { timeout: 60_000 }, () => {
  let t: TestApp;
  let served: Awaited<ReturnType<typeof serveTestApp>>;
  let relay: Relay;
  let relayPort: number;
  let instance: InstanceKey;
  let link: HostRelayLink;
  let adapter: RelayAdapter;
  let pushWorker: PushWorker | undefined;
  let ownerId: string;
  let workspaceId: string;
  const pushes: PushRequest[] = [];
  const gateway: PushGateway = {
    send: async (push) => {
      pushes.push(push);
      return { ok: true };
    },
    close: async () => {},
  };

  // What the phone keeps.
  const deviceKey: KeyPair = generateDeviceKey();
  const pushKey = randomBytes(32);
  let apiKey: string;
  let deviceId: string;
  let tunnel: TunnelClient;
  let botId: string;
  let chatId: string;

  const relayWs = () => relay.url.replace(/^http/, 'ws');

  async function connect(): Promise<TunnelClient> {
    const transport = await connectThroughRelay({
      relayUrl: relayWs(),
      hostId: instance.hostId,
      createSocket: (url) => new WebSocket(url),
    });
    return createTunnelClient({
      transport,
      serverKey: instance.tunnelPublicKey,
      staticKey: deviceKey.privateKey,
    });
  }

  const authed = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${apiKey}` },
  });

  const json = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const pairing = () =>
    createPairing({
      db: t.deps.db,
      config: t.deps.config,
      workspaceId,
      ownerId,
      createdBy: 'user',
      actor: { type: 'user', id: ownerId },
      relay: link,
    });

  beforeAll(async () => {
    relay = await createRelay({ port: 0, host: '127.0.0.1', apns: gateway });
    relayPort = relay.port;
    t = await createTestApp();
    t.deps.config.relayUrl = relayWs();
    served = await serveTestApp(t);
    await t.signUp('ada@example.com', { name: 'Ada Lovelace' });
    ownerId = await t.userId('ada@example.com');
    workspaceId = await t.defaultOrganization();
    instance = await ensureInstanceKey({ db: t.deps.db, config: t.deps.config });
    link = await createRelayLink(t.deps, {
      instance,
      timing: { initialBackoffMs: 50, maxBackoffMs: 500 },
    });
    t.deps.relay = link;
    adapter = startRelayAdapter(t.deps, { link, instance, port: served.port });
  });

  afterAll(async () => {
    tunnel?.close();
    await pushWorker?.stop();
    await adapter?.stop();
    await link?.stop();
    await relay?.close();
    await served?.close();
    await t?.close();
  });

  it('dials the relay once a pairing exists', async () => {
    expect(link.status().status).toBe('off');
    await pairing();
    await waitFor(() => link.status().status === 'linked');
  });

  it('pairs a new device through the tunnel and promotes the stream', async () => {
    tunnel = await connect();
    expect(tunnel.device).toBe('unknown');
    const refused = await tunnel.fetch('/api/v1/bots');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'DEVICE_UNKNOWN' });

    const { qr } = await pairing();
    const paired = await tunnel.fetch(
      '/api/v1/devices/pair',
      json({
        code: qr.code,
        name: 'Ada’s iPhone',
        platform: 'ios',
        publicKey: base64urlEncode(deviceKey.publicKey),
        pushKey: base64urlEncode(pushKey),
      }),
    );
    expect(paired.status).toBe(200);
    const body = (await paired.json()) as { key: string; device: { id: string } };
    expect(body.key).toMatch(/^obk_/);
    apiKey = body.key;
    deviceId = body.device.id;
    expect(tunnel.device).toBe('known');
  });

  it('refuses a pairing whose public key is not the handshake’s', async () => {
    const stranger = await connectThroughRelay({
      relayUrl: relayWs(),
      hostId: instance.hostId,
      createSocket: (url) => new WebSocket(url),
    });
    const other = await createTunnelClient({
      transport: stranger,
      serverKey: instance.tunnelPublicKey,
      staticKey: generateDeviceKey().privateKey,
    });
    try {
      const { qr } = await pairing();
      const res = await other.fetch(
        '/api/v1/devices/pair',
        json({
          code: qr.code,
          name: 'Impostor',
          platform: 'ios',
          publicKey: base64urlEncode(generateDeviceKey().publicKey),
          pushKey: base64urlEncode(randomBytes(32)),
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'PAIRING_KEY_MISMATCH' });
    } finally {
      other.close();
    }
  });

  it('serves REST with the device’s key', async () => {
    const me = await tunnel.fetch('/api/v1/me', authed());
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { id: ownerId } });
    const bots = await tunnel.fetch('/api/v1/bots', authed());
    expect(bots.status).toBe(200);
    // And without it, a 401 like any other caller.
    expect((await tunnel.fetch('/api/v1/bots')).status).toBe(401);

    const created = await tunnel.fetch(
      '/api/v1/bots',
      authed(json({ name: 'Researcher', handle: 'researcher' })),
    );
    expect(created.status).toBe(201);
    ({ id: botId, chatId } = (await created.json()) as { id: string; chatId: string });
  });

  it('carries /ws: subscribed, then an event caused through REST', async () => {
    const socket = tunnel.createSocket('/ws', {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const frames: Record<string, unknown>[] = [];
    socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('the socket was refused'));
    });
    socket.send(JSON.stringify({ type: 'subscribe', chats: [chatId], bots: [botId] }));
    await waitFor(() => frames.some((f) => f.type === 'subscribed'));
    expect(frames.find((f) => f.type === 'subscribed')).toMatchObject({
      chats: [chatId],
      bots: [botId],
    });

    const posted = await tunnel.fetch(
      `/api/v1/chats/${chatId}/messages`,
      authed(json({ text: 'hello from the train' })),
    );
    expect(posted.status).toBe(201);
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === 'message.created' &&
          (f.payload as { message: { parts: { text?: string }[] } }).message.parts[0]?.text ===
            'hello from the train',
      ),
    );
    socket.close(1000, 'done');
  });

  it('round-trips a large upload', async () => {
    // The tunnel's request limit is 16 MiB, multipart framing included.
    const bytes = randomBytes(16 * 1024 * 1024 - 64 * 1024);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'big.bin');
    const uploaded = await tunnel.fetch('/api/v1/files', authed({ method: 'POST', body: form }));
    expect(uploaded.status).toBe(201);
    const file = (await uploaded.json()) as { id: string; size: number };
    expect(file.size).toBe(bytes.length);
    const download = await tunnel.fetch(`/api/v1/files/${file.id}`, authed());
    expect(download.status).toBe(200);
    expect(sha256(new Uint8Array(await download.arrayBuffer()))).toBe(sha256(bytes));
  });

  it('pushes a real notice to the device, encrypted for it', async () => {
    const token = 'ab'.repeat(32);
    const registered = await tunnel.fetch(
      `/api/v1/devices/${deviceId}/push`,
      authed({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, environment: 'production' }),
      }),
    );
    expect(registered.status).toBe(204);
    pushWorker = await startPushWorker(t.deps);

    const approvalId = crypto.randomUUID();
    await publishEvent(
      t.deps.infra.bus,
      wsEvent(
        'approval.requested',
        {
          approval: {
            id: approvalId,
            runId: crypto.randomUUID(),
            toolName: 'bash',
            summary: 'bash: rm -rf build',
            args: {},
            reason: null,
            status: 'pending',
          },
        },
        { bot_id: botId, chat_id: chatId, seq: 3, workspace_id: workspaceId },
      ) as WsEvent,
    );
    await waitFor(() => pushes.length === 1);
    const [push] = pushes;
    expect(push).toMatchObject({
      token,
      collapseId: `approval:${approvalId}`,
      priority: 10,
      threadId: botId,
    });
    expect(JSON.parse(decryptPush(pushKey, push!.ciphertext))).toEqual({
      v: 1,
      kind: 'approval',
      tag: `approval:${approvalId}`,
      title: 'Researcher needs your approval',
      body: 'bash: rm -rf build',
      target: { botId, chatId, seq: 3, threadRootId: null },
      host: instance.hostId,
    });
  });

  it('lets a device revoke itself over its own stream: the 204 arrives, then the close', async () => {
    // An open pairing keeps the link up once the only device is gone.
    await pairing();
    const closed = new Promise<number>((resolve) => tunnel.onClose((code) => resolve(code)));
    // `device.revoked` reaches the adapter while this very request is in
    // flight; the stream waits for its response before it closes.
    const res = await tunnel.fetch(`/api/v1/devices/${deviceId}`, authed({ method: 'DELETE' }));
    expect(res.status).toBe(204);
    expect(await closed).toBe(CLOSE_REVOKED);
    await waitFor(() => adapter.sessions() === 0);

    const again = await connect();
    try {
      expect(again.device).toBe('unknown');
      expect((await again.fetch('/api/v1/me', authed())).status).toBe(403);
    } finally {
      again.close();
    }
  });

  it('links again after the relay restarts', async () => {
    await relay.close();
    await waitFor(() => link.status().status === 'connecting');
    relay = await createRelay({ port: relayPort, host: '127.0.0.1', apns: gateway });
    await waitFor(() => link.status().status === 'linked', 10_000);
    const back = await connect();
    expect(back.device).toBe('unknown');
    back.close();
  });
});
