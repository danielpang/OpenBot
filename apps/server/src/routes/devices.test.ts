import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { EVENTS_CHANNEL, type WsEvent } from '@openbots/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_HEADER, DEVICE_KEY_HEADER } from '../client-ip.js';
import { schema } from '../db/client.js';
import { inWorkspace } from '../db/scope.js';
import { decryptSecret, decryptSecretString, keyringFromConfig } from '../secrets.js';
import { SYSTEM_ACTOR } from '../services/audit.js';
import {
  MAX_OPEN_PAIRINGS,
  PAIRING_TTL_MS,
  anyDevicesOrPairings,
  createPairing,
  expireDuePairings,
  findDeviceByPublicKey,
} from '../services/devices.js';
import { ensureInstanceKey } from '../services/instance-key.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';
import { ensureWorkspace } from '../workspace.js';

// Devices and pairing (docs/RELAY_PROTOCOL.md 6; routes/devices.ts).

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/** The link's fragment as key and values; `direct` may repeat. */
function parseLink(link: string): Record<string, string[]> {
  expect(link.startsWith('openbots://pair#')).toBe(true);
  const fields: Record<string, string[]> = {};
  for (const part of link.slice('openbots://pair#'.length).split('&')) {
    const [k, v] = part.split('=') as [string, string];
    (fields[k] ??= []).push(decodeURIComponent(v));
  }
  return fields;
}

interface Pairing {
  id: string;
  expiresAt: string;
  link: string;
  qr: { code: string; setup: boolean; relay: string | null; direct: string[]; name: string };
}

interface Paired {
  device: { id: string; name: string; platform: string; createdAt: string };
  key: string;
  owner: { id: string; name: string };
  setupNeeded: boolean;
}

let peers = 0;
/** A different client address each call, so the per-client limit stays out of the way. */
const freshPeer = () => `198.51.100.${(peers++ % 250) + 1}`;

function request(
  t: TestApp,
  method: string,
  path: string,
  {
    cookie,
    key,
    body,
    peer = freshPeer(),
    headers = {},
  }: {
    cookie?: string;
    key?: string;
    body?: unknown;
    peer?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return t.app.request(
    `/api/v1${path}`,
    {
      method,
      headers: {
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { incoming: { socket: { remoteAddress: peer, remotePort: 50_000, remoteFamily: 'IPv4' } } },
  );
}

const pairBody = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  name: "Ada's iPhone",
  platform: 'ios',
  publicKey: b64(randomBytes(32)),
  pushKey: b64(randomBytes(32)),
  ...extra,
});

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as T;
}

describe('devices and pairing', () => {
  let t: TestApp;
  let cookie: string;
  let ownerId: string;
  let workspaceId: string;
  const events: WsEvent[] = [];

  const newPairing = async (body: unknown = {}) =>
    json<Pairing>(request(t, 'POST', '/devices/pairings', { cookie, body }), 201);

  const pair = async (body: Record<string, unknown> = {}) => {
    const pairing = await newPairing();
    return json<Paired>(
      request(t, 'POST', '/devices/pair', { body: pairBody(pairing.qr.code, body) }),
    );
  };

  beforeAll(async () => {
    t = await createTestApp();
    cookie = (await t.signUp('ada@example.com')).cookie!;
    ownerId = await t.userId('ada@example.com');
    workspaceId = await t.defaultOrganization();
    await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.db.delete(schema.devicePairings);
    events.length = 0;
  });

  describe('POST /devices/pairings', () => {
    it('makes a link in the format of the spec, good for 5 minutes', async () => {
      const before = Date.now();
      const pairing = await newPairing();
      const instance = await ensureInstanceKey({ db: t.deps.db, config: t.deps.config });
      const fields = parseLink(pairing.link);
      expect(Object.keys(fields)).toEqual(['v', 'host', 'key', 'code', 'name']);
      expect(fields).toMatchObject({
        v: ['1'],
        host: [instance.hostId],
        key: [b64(instance.tunnelPublicKey)],
        code: [pairing.qr.code],
        name: ['OpenBots'],
      });
      expect(instance.hostId).toMatch(/^[a-z2-7]{26}$/);
      expect(Buffer.from(pairing.qr.code, 'base64url')).toHaveLength(32);
      // No relay configured and an http public URL: no way in listed but what the caller gives.
      expect(pairing.qr).toMatchObject({ relay: null, direct: [], setup: false, name: 'OpenBots' });
      const expires = Date.parse(pairing.expiresAt);
      expect(expires - before).toBeGreaterThanOrEqual(PAIRING_TTL_MS - 1000);
      expect(expires - Date.now()).toBeLessThanOrEqual(PAIRING_TTL_MS);
      // Stored as a hash, never the code; audited.
      const [row] = await t.db
        .select()
        .from(schema.devicePairings)
        .where(eq(schema.devicePairings.id, pairing.id));
      expect(row).toMatchObject({ ownerId, createdBy: 'user', createsOwner: false, usedAt: null });
      expect(row!.codeHash.equals(Buffer.from(pairing.qr.code, 'base64url'))).toBe(false);
      const [audit] = await t.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'device.pairing_created'));
      expect(audit).toMatchObject({ actorId: ownerId, targetId: pairing.id });
    });

    it('takes a name and direct addresses, percent-encoded in the link', async () => {
      const pairing = await newPairing({
        name: "Ada's Mac & VM",
        direct: ['https://bots.example.com', 'https://10.0.0.5:3000/'],
      });
      expect(pairing.link).toContain("name=Ada's%20Mac%20%26%20VM");
      expect(pairing.link).toContain(`direct=${encodeURIComponent('https://bots.example.com')}`);
      expect(parseLink(pairing.link)).toMatchObject({
        name: ["Ada's Mac & VM"],
        direct: ['https://bots.example.com', 'https://10.0.0.5:3000/'],
      });
      const bad = await request(t, 'POST', '/devices/pairings', {
        cookie,
        body: { direct: ['ftp://nope'] },
      });
      expect(bad.status).toBe(400);
    });

    it('lists the relay and an https public URL by default', async () => {
      const config = {
        ...t.deps.config,
        publicUrl: 'https://bots.example.com',
        relayUrl: 'wss://relay.example.com',
      };
      const pairing = await createPairing({
        db: t.deps.db,
        config,
        workspaceId,
        ownerId,
        createdBy: 'user',
        actor: { type: 'user', id: ownerId },
      });
      expect(parseLink(pairing.link)).toMatchObject({
        relay: ['wss://relay.example.com'],
        direct: ['https://bots.example.com'],
      });
      expect(pairing.link).toContain(`relay=${encodeURIComponent('wss://relay.example.com')}`);
    });

    it(`keeps at most ${MAX_OPEN_PAIRINGS} open per owner`, async () => {
      for (let i = 0; i < MAX_OPEN_PAIRINGS; i++) await newPairing();
      const refused = await request(t, 'POST', '/devices/pairings', { cookie, body: {} });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: 'TOO_MANY_PAIRINGS' });
      // An expired one does not count.
      await t.db.update(schema.devicePairings).set({ expiresAt: new Date(Date.now() - 1000) });
      await newPairing();
    });

    it('needs a sign-in', async () => {
      expect((await request(t, 'POST', '/devices/pairings', { body: {} })).status).toBe(401);
    });
  });

  describe('POST /devices/pair', () => {
    it('pairs once, answering the key once, the device and the owner', async () => {
      const pairing = await newPairing();
      const body = pairBody(pairing.qr.code);
      const paired = await json<Paired>(request(t, 'POST', '/devices/pair', { body }));
      expect(paired).toMatchObject({
        device: { name: "Ada's iPhone", platform: 'ios' },
        owner: { id: ownerId, name: 'ada' },
        setupNeeded: true,
      });
      expect(paired.key).toMatch(/^obk_/);

      // The key works as the owner.
      const me = await json<{ user: { id: string } }>(
        request(t, 'GET', '/me', { key: paired.key }),
      );
      expect(me.user.id).toBe(ownerId);
      const listed = await json<{ items: { id: string; pushRegistered: boolean }[] }>(
        request(t, 'GET', '/devices', { key: paired.key }),
      );
      expect(listed.items).toEqual([
        expect.objectContaining({ id: paired.device.id, pushRegistered: false }),
      ]);

      // Stored: the static key as is, the push key sealed, the key in the organization.
      const [row] = await t.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, paired.device.id));
      expect(b64(row!.publicKey!)).toBe(body.publicKey);
      expect(b64(decryptSecret(row!.pushKey!, keyringFromConfig(t.deps.config)))).toBe(
        body.pushKey,
      );
      const [key] = await t.db
        .select()
        .from(schema.apikeys)
        .where(eq(schema.apikeys.id, row!.apiKeyId!));
      expect(key).toMatchObject({ workspaceId, name: "Ada's iPhone", expiresAt: null });

      // Audited and published to the owner only.
      const [audit] = await t.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'device.paired'));
      expect(audit).toMatchObject({ targetId: paired.device.id, actorId: ownerId });
      expect(audit!.metadata).toMatchObject({ via: 'direct', pairingId: pairing.id });
      const event = events.find((e) => e.type === 'device.paired');
      expect(event).toMatchObject({
        user_id: ownerId,
        workspace_id: workspaceId,
        payload: { device: { id: paired.device.id, platform: 'ios' } },
      });

      // A second use of the code is refused, with nothing to tell why.
      const again = await request(t, 'POST', '/devices/pair', {
        body: pairBody(pairing.qr.code),
      });
      expect(again.status).toBe(401);
      expect(await again.json()).toMatchObject({ code: 'PAIRING_INVALID' });
    });

    it('refuses an expired, an unknown and a malformed code alike', async () => {
      const pairing = await newPairing();
      await t.db
        .update(schema.devicePairings)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.devicePairings.id, pairing.id));
      for (const code of [pairing.qr.code, b64(randomBytes(32)), 'short', 'not base64!']) {
        const res = await request(t, 'POST', '/devices/pair', { body: pairBody(code) });
        expect(res.status, code).toBe(401);
        expect(await res.json()).toMatchObject({ code: 'PAIRING_INVALID' });
      }
      expect(await t.db.select().from(schema.devices).where(eq(schema.devices.name, 'x'))).toEqual(
        [],
      );
    });

    it("refuses a key that is not the tunnel's, and kills a code after 5 tries", async () => {
      const pairing = await newPairing();
      for (let i = 0; i < 5; i++) {
        // Through the relay adapter: loopback, each its own stream.
        const res = await request(t, 'POST', '/devices/pair', {
          body: pairBody(pairing.qr.code),
          peer: '127.0.0.1',
          headers: { [DEVICE_HEADER]: `stream:${i}`, [DEVICE_KEY_HEADER]: b64(randomBytes(32)) },
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'PAIRING_KEY_MISMATCH' });
      }
      // Even the right request now: the code is dead.
      const publicKey = randomBytes(32);
      const res = await request(t, 'POST', '/devices/pair', {
        body: pairBody(pairing.qr.code, { publicKey: b64(publicKey) }),
        peer: '127.0.0.1',
        headers: { [DEVICE_HEADER]: 'stream:9', [DEVICE_KEY_HEADER]: b64(publicKey) },
      });
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBeTruthy();
    });

    it('pairs through the tunnel when the key is the handshake’s', async () => {
      const pairing = await newPairing();
      const publicKey = randomBytes(32);
      const paired = await json<Paired>(
        request(t, 'POST', '/devices/pair', {
          body: pairBody(pairing.qr.code, { publicKey: b64(publicKey), name: 'Tunnel phone' }),
          peer: '127.0.0.1',
          headers: { [DEVICE_HEADER]: 'stream:42', [DEVICE_KEY_HEADER]: b64(publicKey) },
        }),
      );
      const [audit] = await t.db
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.action, 'device.paired'),
            eq(schema.auditLog.targetId, paired.device.id),
          ),
        );
      expect(audit!.metadata).toMatchObject({ via: 'relay' });
      // The relay adapter's lookup finds it, with its organization.
      const found = await findDeviceByPublicKey(t.deps.db, publicKey);
      expect(found).toMatchObject({ id: paired.device.id, workspaceId, ownerId });
      expect(await findDeviceByPublicKey(t.deps.db, randomBytes(32))).toBeNull();
    });

    it('ignores the tunnel headers from anywhere but loopback', async () => {
      const pairing = await newPairing();
      const paired = await request(t, 'POST', '/devices/pair', {
        body: pairBody(pairing.qr.code),
        peer: '203.0.113.7',
        headers: { [DEVICE_KEY_HEADER]: b64(randomBytes(32)) },
      });
      expect(paired.status).toBe(200);
    });

    it('limits one client to 10 attempts an hour', async () => {
      const peer = '203.0.113.99';
      for (let i = 0; i < 10; i++) {
        const res = await request(t, 'POST', '/devices/pair', {
          body: pairBody(b64(randomBytes(32))),
          peer,
        });
        expect(res.status).toBe(401);
      }
      const limited = await request(t, 'POST', '/devices/pair', {
        body: pairBody(b64(randomBytes(32))),
        peer,
      });
      expect(limited.status).toBe(429);
      // Another client, or another tunnel stream from loopback, has its own bucket.
      const other = await request(t, 'POST', '/devices/pair', {
        body: pairBody(b64(randomBytes(32))),
      });
      expect(other.status).toBe(401);
    });

    it('refuses a static key that is paired already, without spending the code', async () => {
      const first = await newPairing();
      const publicKey = b64(randomBytes(32));
      await json(
        request(t, 'POST', '/devices/pair', { body: pairBody(first.qr.code, { publicKey }) }),
      );
      const second = await newPairing();
      const res = await request(t, 'POST', '/devices/pair', {
        body: pairBody(second.qr.code, { publicKey }),
      });
      expect(res.status).toBe(409);
      const [row] = await t.db
        .select()
        .from(schema.devicePairings)
        .where(eq(schema.devicePairings.id, second.id));
      expect(row!.usedAt).toBeNull();
    });

    it('says setup is needed until the owner has a provider and a Bot', async () => {
      expect((await pair()).setupNeeded).toBe(true);
      await t.providerId();
      expect((await pair()).setupNeeded).toBe(true);
      await t.db
        .insert(schema.bots)
        .values({ workspaceId, ownerId, name: 'Scout', handle: 'scout' });
      expect((await pair()).setupNeeded).toBe(false);
    });
  });

  describe('device keys and API keys', () => {
    it('keeps device keys out of GET /api-keys and DELETE /api-keys/{id}', async () => {
      const paired = await pair();
      const mine = await json<{ id: string }>(
        request(t, 'POST', '/api-keys', { cookie, body: { name: 'script' } }),
        201,
      );
      const keys = await json<{ items: { id: string }[] }>(
        request(t, 'GET', '/api-keys', { cookie }),
      );
      const [device] = await t.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, paired.device.id));
      expect(keys.items.map((k) => k.id)).toContain(mine.id);
      expect(keys.items.map((k) => k.id)).not.toContain(device!.apiKeyId);
      const refused = await request(t, 'DELETE', `/api-keys/${device!.apiKeyId}`, { cookie });
      expect(refused.status).toBe(404);
      expect((await request(t, 'GET', '/me', { key: paired.key })).status).toBe(200);
    });

    it('notes when a device was last seen', async () => {
      const paired = await pair();
      await request(t, 'GET', '/me', { key: paired.key });
      const [row] = await t.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, paired.device.id));
      expect(row!.lastSeenAt).not.toBeNull();
    });
  });

  describe('DELETE /devices/{id}', () => {
    it('revokes at once: the key stops working, the keys are forgotten, the event goes out', async () => {
      const paired = await pair();
      expect((await request(t, 'GET', '/me', { key: paired.key })).status).toBe(200);
      const res = await request(t, 'DELETE', `/devices/${paired.device.id}`, { cookie });
      expect(res.status).toBe(204);
      const after = await request(t, 'GET', '/me', { key: paired.key });
      expect(after.status).toBe(401);

      const [row] = await t.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, paired.device.id));
      expect(row).toMatchObject({
        apiKeyId: null,
        publicKey: null,
        pushKey: null,
        pushToken: null,
      });
      expect(row!.revokedAt).not.toBeNull();
      const event = events.find((e) => e.type === 'device.revoked');
      expect(event).toMatchObject({
        user_id: ownerId,
        workspace_id: workspaceId,
        payload: { device: { id: paired.device.id } },
      });
      expect((event!.payload as { device: { revokedAt: string } }).device.revokedAt).toBeTruthy();
      const [audit] = await t.db
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.action, 'device.revoked'),
            eq(schema.auditLog.targetId, paired.device.id),
          ),
        );
      expect(audit).toBeDefined();

      // Gone from the list, and a second revoke is a 404.
      const listed = await json<{ items: { id: string }[] }>(
        request(t, 'GET', '/devices', { cookie }),
      );
      expect(listed.items.map((d) => d.id)).not.toContain(paired.device.id);
      expect((await request(t, 'DELETE', `/devices/${paired.device.id}`, { cookie })).status).toBe(
        404,
      );
    });

    it('lets a device revoke itself', async () => {
      const paired = await pair();
      const res = await request(t, 'DELETE', `/devices/${paired.device.id}`, { key: paired.key });
      expect(res.status).toBe(204);
      expect((await request(t, 'GET', '/devices', { key: paired.key })).status).toBe(401);
    });
  });

  describe('PUT /devices/{id}/push', () => {
    it('takes the token from the device itself only, sealed', async () => {
      const phone = await pair();
      const tablet = await pair({ name: 'Tablet' });
      const body = { token: 'ABCDEF0123456789abcdef0123456789', environment: 'sandbox' };
      const byOwner = await request(t, 'PUT', `/devices/${phone.device.id}/push`, { cookie, body });
      expect(byOwner.status).toBe(403);
      expect(await byOwner.json()).toMatchObject({ code: 'NOT_THIS_DEVICE' });
      const byOther = await request(t, 'PUT', `/devices/${phone.device.id}/push`, {
        key: tablet.key,
        body,
      });
      expect(byOther.status).toBe(403);
      const ok = await request(t, 'PUT', `/devices/${phone.device.id}/push`, {
        key: phone.key,
        body,
      });
      expect(ok.status).toBe(204);

      const [row] = await t.db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, phone.device.id));
      expect(row!.pushEnvironment).toBe('sandbox');
      expect(decryptSecretString(row!.pushToken!, keyringFromConfig(t.deps.config))).toBe(
        body.token.toLowerCase(),
      );
      const listed = await json<{ items: { id: string; pushRegistered: boolean }[] }>(
        request(t, 'GET', '/devices', { cookie }),
      );
      expect(listed.items.find((d) => d.id === phone.device.id)?.pushRegistered).toBe(true);

      const unknown = await request(t, 'PUT', `/devices/${crypto.randomUUID()}/push`, {
        key: phone.key,
        body,
      });
      expect(unknown.status).toBe(404);
      const badToken = await request(t, 'PUT', `/devices/${phone.device.id}/push`, {
        key: phone.key,
        body: { token: 'not hex', environment: 'sandbox' },
      });
      expect(badToken.status).toBe(400);
    });
  });

  describe('GET /relay', () => {
    it("answers off with the host id when no relay link runs, and the link's status when one does", async () => {
      const instance = await ensureInstanceKey({ db: t.deps.db, config: t.deps.config });
      expect(await json(request(t, 'GET', '/relay', { cookie }))).toEqual({
        hostId: instance.hostId,
        relayUrl: null,
        status: 'off',
        since: null,
      });
      const since = new Date().toISOString();
      t.deps.relay = {
        status: () => ({
          hostId: instance.hostId,
          relayUrl: 'wss://relay.example.com',
          status: 'linked',
          since,
        }),
        wake: () => {},
        push: () => Promise.reject(new Error('not used here')),
        stop: async () => {},
      };
      try {
        expect(await json(request(t, 'GET', '/relay', { cookie }))).toMatchObject({
          status: 'linked',
          since,
        });
      } finally {
        delete t.deps.relay;
      }
      expect((await request(t, 'GET', '/relay')).status).toBe(401);
    });
  });

  describe('upkeep', () => {
    it('drops used and expired pairings, and says whether the relay is wanted', async () => {
      await t.db.update(schema.devices).set({ revokedAt: new Date() });
      expect(await anyDevicesOrPairings(t.deps.db)).toBe(false);
      const open = await newPairing();
      expect(await anyDevicesOrPairings(t.deps.db)).toBe(true);
      const used = await newPairing();
      await t.db
        .update(schema.devicePairings)
        .set({ usedAt: new Date() })
        .where(eq(schema.devicePairings.id, used.id));
      const expired = await newPairing();
      await t.db
        .update(schema.devicePairings)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(eq(schema.devicePairings.id, expired.id));
      expect(await inWorkspace(workspaceId, () => expireDuePairings(t.deps))).toBe(2);
      const left = await t.db.select({ id: schema.devicePairings.id }).from(schema.devicePairings);
      expect(left.map((r) => r.id)).toEqual([open.id]);
      await t.db.delete(schema.devicePairings);
      expect(await anyDevicesOrPairings(t.deps.db)).toBe(false);
    });
  });
});

describe('pairing on a server with no owner yet (headless first run)', () => {
  let t: TestApp;
  let workspaceId: string;

  beforeAll(async () => {
    t = await createTestApp();
    workspaceId = (await ensureWorkspace(t.db)).id;
  });
  afterAll(() => t.close());

  const cliPairing = () =>
    createPairing({
      db: t.deps.db,
      config: t.deps.config,
      workspaceId,
      ownerId: null,
      createdBy: 'cli',
      actor: SYSTEM_ACTOR,
    });

  it('marks the link setup=1 and makes the owner at pairing', async () => {
    const pairing = await cliPairing();
    expect(pairing.qr.setup).toBe(true);
    expect(parseLink(pairing.link).setup).toEqual(['1']);
    const [row] = await t.db.select().from(schema.devicePairings);
    expect(row).toMatchObject({ ownerId: null, createsOwner: true, createdBy: 'cli' });

    const paired = await json<Paired>(
      request(t, 'POST', '/devices/pair', {
        body: pairBody(pairing.qr.code, { ownerName: 'Daniel' }),
      }),
    );
    expect(paired.owner.name).toBe('Daniel');
    expect(paired.setupNeeded).toBe(true);
    const users = await t.db.select().from(schema.users);
    expect(users).toEqual([
      expect.objectContaining({
        id: paired.owner.id,
        email: 'owner@openbots.local',
        name: 'Daniel',
      }),
    ]);
    // An owner, with no password: the device key is how they get in.
    expect(await t.db.select().from(schema.accounts)).toEqual([]);
    const me = await json<{ user: { id: string; name: string }; role: string }>(
      request(t, 'GET', '/me', { key: paired.key }),
    );
    expect(me).toMatchObject({ user: { id: paired.owner.id, name: 'Daniel' }, role: 'owner' });
    expect((await request(t, 'GET', '/setup')).status).toBe(200);

    // The next pairing is an ordinary one, for that owner.
    const next = await cliPairing();
    expect(next.qr.setup).toBe(false);
    const second = await json<Paired>(
      request(t, 'POST', '/devices/pair', { body: pairBody(next.qr.code, { ownerName: 'Eve' }) }),
    );
    expect(second.owner).toEqual({ id: paired.owner.id, name: 'Daniel' });
    expect(await t.db.select().from(schema.users)).toHaveLength(1);
  });
});

describe('a pairing made before the owner, used after they signed up', () => {
  it('pairs the device to that owner and makes nobody', async () => {
    const t = await createTestApp();
    try {
      const workspaceId = (await ensureWorkspace(t.db)).id;
      const pairing = await createPairing({
        db: t.deps.db,
        config: t.deps.config,
        workspaceId,
        ownerId: null,
        createdBy: 'cli',
        actor: SYSTEM_ACTOR,
      });
      await t.signUp('ada@example.com');
      const ownerId = await t.userId('ada@example.com');
      const paired = await json<Paired>(
        request(t, 'POST', '/devices/pair', { body: pairBody(pairing.qr.code) }),
      );
      expect(paired.owner.id).toBe(ownerId);
      expect(await t.db.select().from(schema.users)).toHaveLength(1);
      // The tunnel key really is the X25519 form of the instance's signing key.
      const instance = await ensureInstanceKey({ db: t.deps.db, config: t.deps.config });
      expect(b64(ed25519.utils.toMontgomery(instance.publicKey))).toBe(
        parseLink(pairing.link).key![0],
      );
    } finally {
      await t.close();
    }
  });
});
