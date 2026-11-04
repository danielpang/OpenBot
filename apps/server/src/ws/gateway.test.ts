import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { wsEvent, type ServerFrame } from '@openbots/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { schema } from '../db/client.js';
import { publishEvent } from '../infra/index.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';
import { MEMBERSHIP_ENDED_CHANNEL, type MembershipEnded } from '../membership.js';
import { ensureWorkspace } from '../workspace.js';
import { attachGateway, type Gateway } from './gateway.js';

describe('WS gateway', () => {
  let t: TestApp;
  let server: ServerType;
  let gateway: Gateway;
  let url: string;
  let alice: string;
  let bob: string;
  let aliceBot: string;
  let bobBot: string;

  beforeAll(async () => {
    // Over Redis pub/sub when REDIS_URL is set, in-process otherwise.
    const redis = process.env.REDIS_URL;
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_SIGNUP_MODE: 'open',
      ...(redis ? { REDIS_URL: redis } : {}),
    });
    server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    gateway = await attachGateway(server, t.deps);
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;

    alice = (await t.signUp('alice@example.com')).cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
    const workspace = await ensureWorkspace(t.db);
    const users = await t.db.select().from(schema.users);
    const idOf = (email: string) => users.find((u) => u.email === email)!.id;
    const bots = await t.db
      .insert(schema.bots)
      .values([
        { workspaceId: workspace.id, ownerId: idOf('alice@example.com'), handle: 'a', name: 'A' },
        { workspaceId: workspace.id, ownerId: idOf('bob@example.com'), handle: 'b', name: 'B' },
      ])
      .returning({ id: schema.bots.id });
    aliceBot = bots[0]!.id;
    bobBot = bots[1]!.id;
  });

  afterAll(async () => {
    await gateway.close();
    await new Promise((resolve) => server.close(resolve));
    await t.close();
  });

  it('refuses an upgrade from another origin', async () => {
    const status = await refused(url, { cookie: alice, origin: 'https://evil.example' });
    expect(status).toBe(403);
  });

  it('refuses an unauthenticated upgrade', async () => {
    expect(await refused(url, { origin: ORIGIN })).toBe(401);
    expect(await refused(url, { origin: ORIGIN, authorization: 'Bearer obk_nope' })).toBe(401);
  });

  it('refuses upgrades on other paths', async () => {
    expect(await refused(url.replace('/ws', '/elsewhere'), { cookie: alice, origin: ORIGIN })).toBe(
      404,
    );
  });

  it('accepts an API key from a client that sends no Origin', async () => {
    const created = await t.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { cookie: alice, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ws' }),
    });
    const { key } = (await created.json()) as { key: string };
    const client = await connect(url, { authorization: `Bearer ${key}` });
    client.send({ type: 'ping' });
    expect(await client.next()).toMatchObject({ type: 'pong' });
    client.close();
  });

  it('delivers a bot.state event only to sockets subscribed to that Bot', async () => {
    const subscribed = await connect(url, { cookie: alice, origin: ORIGIN });
    const idle = await connect(url, { cookie: alice, origin: ORIGIN });
    const intruder = await connect(url, { cookie: bob, origin: ORIGIN });

    subscribed.send({ type: 'subscribe', bots: [aliceBot] });
    expect(await subscribed.next()).toEqual({
      type: 'subscribed',
      chats: [],
      bots: [aliceBot],
      denied: { chats: [], bots: [] },
    });
    // Bob may not watch Alice's Bot; his own is fine.
    intruder.send({ type: 'subscribe', bots: [aliceBot, bobBot] });
    expect(await intruder.next()).toEqual({
      type: 'subscribed',
      chats: [],
      bots: [bobBot],
      denied: { chats: [], bots: [aliceBot] },
    });

    const event = wsEvent(
      'bot.state',
      { botId: aliceBot, state: 'thinking', currentAction: 'Reading', runId: null },
      { bot_id: aliceBot },
    );
    await publishEvent(t.deps.infra.bus, event);
    expect(await subscribed.next()).toEqual(event);

    // A marker on Bob's Bot reaches Bob next, proving Alice's event never did.
    const marker = wsEvent(
      'bot.state',
      { botId: bobBot, state: 'idle', currentAction: null, runId: null },
      { bot_id: bobBot },
    );
    await publishEvent(t.deps.infra.bus, marker);
    expect(await intruder.next()).toEqual(marker);
    expect(idle.frames).toEqual([]);

    subscribed.send({ type: 'unsubscribe', bots: [aliceBot] });
    expect(await subscribed.next()).toMatchObject({ type: 'subscribed', bots: [] });

    for (const c of [subscribed, idle, intruder]) c.close();
  });

  it('answers malformed frames with an error', async () => {
    const client = await connect(url, { cookie: alice, origin: ORIGIN });
    client.raw.send('not json');
    expect(await client.next()).toMatchObject({ type: 'error', code: 'BAD_FRAME' });
    client.send({ type: 'subscribe', chats: 'everything' });
    expect(await client.next()).toMatchObject({ type: 'error', code: 'BAD_FRAME' });
    client.close();
  });

  it("closes a member's sockets in the organization that suspended them, and only those", async () => {
    const home = await t.defaultOrganization();
    const bobId = await t.userId('bob@example.com');
    const second = await t.createOrganization('Second');
    await t.addMember(bobId, second, 'owner');
    const bobs = [
      await connect(url, { cookie: bob, origin: ORIGIN }),
      await connect(url, { cookie: bob, origin: ORIGIN }),
    ];
    // Bob signed in again and working in his other organization.
    const signedIn = await t.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: 'bob@example.com', password: 'correct horse battery' }),
    });
    const elsewhere = signedIn.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .find((c) => c.includes('session_token='))!;
    await t.switchOrganization(elsewhere, second);
    const bobElsewhere = await connect(url, { cookie: elsewhere, origin: ORIGIN });
    const other = await connect(url, { cookie: alice, origin: ORIGIN });
    const closed = bobs.map(
      (c) => new Promise<number>((resolve) => c.raw.once('close', (code) => resolve(code))),
    );
    await t.deps.infra.bus.publish<MembershipEnded>(MEMBERSHIP_ENDED_CHANNEL, {
      userId: bobId,
      workspaceId: home,
    });
    expect(await Promise.all(closed)).toEqual([1008, 1008]);
    for (const client of [other, bobElsewhere]) {
      client.send({ type: 'ping' });
      expect(await client.next()).toMatchObject({ type: 'pong' });
      client.close();
    }
  });

  it('closes a socket 1008 when its API key is deleted or its device revoked', async () => {
    const makeKey = async (name: string) => {
      const res = await t.app.request('/api/v1/api-keys', {
        method: 'POST',
        headers: { cookie: alice, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      return (await res.json()) as { id: string; key: string };
    };
    const closedWith = (client: TestClient) =>
      new Promise<number>((resolve) => client.raw.once('close', (code) => resolve(code)));

    // A deleted key: at once, on the bus.
    const script = await makeKey('script');
    const scripted = await connect(url, { authorization: `Bearer ${script.key}` });
    const bystander = await connect(url, { cookie: alice, origin: ORIGIN });
    const scriptClosed = closedWith(scripted);
    await t.app.request(`/api/v1/api-keys/${script.id}`, {
      method: 'DELETE',
      headers: { cookie: alice, origin: ORIGIN },
    });
    expect(await scriptClosed).toBe(1008);

    // A revoked phone on the direct path: its key goes with the device.
    const phoneKey = await makeKey('phone');
    const [device] = await t.db
      .insert(schema.devices)
      .values({
        workspaceId: await t.defaultOrganization(),
        ownerId: await t.userId('alice@example.com'),
        name: 'Phone',
        platform: 'ios',
        publicKey: Buffer.alloc(32, 7),
        apiKeyId: phoneKey.id,
      })
      .returning();
    const phone = await connect(url, { authorization: `Bearer ${phoneKey.key}` });
    const phoneClosed = closedWith(phone);
    const revoked = await t.app.request(`/api/v1/devices/${device!.id}`, {
      method: 'DELETE',
      headers: { cookie: alice, origin: ORIGIN },
    });
    expect(revoked.status).toBe(204);
    expect(await phoneClosed).toBe(1008);

    // A key gone with no message on the bus (another process, no Redis): the minute's check.
    const quiet = await makeKey('quiet');
    const unheard = await connect(url, { authorization: `Bearer ${quiet.key}` });
    const unheardClosed = closedWith(unheard);
    await t.db.delete(schema.apikeys).where(eq(schema.apikeys.id, quiet.id));
    await gateway.checkKeys();
    expect(await unheardClosed).toBe(1008);

    // A session's socket stays; it heard of the revocation.
    expect(await bystander.next()).toMatchObject({ type: 'device.revoked' });
    bystander.send({ type: 'ping' });
    expect(await bystander.next()).toMatchObject({ type: 'pong' });
    bystander.close();
  });

  it("delivers a user's account events only to their sockets in that organization (plan 21.3)", async () => {
    const home = await t.defaultOrganization();
    const aliceId = await t.userId('alice@example.com');
    const second = await t.createOrganization('Alice Two');
    await t.addMember(aliceId, second, 'owner');
    const signedIn = await t.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: 'alice@example.com', password: 'correct horse battery' }),
    });
    const elsewhere = signedIn.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .find((c) => c.includes('session_token='))!;
    await t.switchOrganization(elsewhere, second);
    const inHome = await connect(url, { cookie: alice, origin: ORIGIN });
    const inSecond = await connect(url, { cookie: elsewhere, origin: ORIGIN });
    const status = (workspaceId: string, computerId: string) =>
      wsEvent(
        'computer.status',
        { computerId, status: 'running', error: null },
        { user_id: aliceId, workspace_id: workspaceId },
      );
    const forHome = status(home, '00000000-0000-4000-8000-000000000001');
    const forSecond = status(second, '00000000-0000-4000-8000-000000000002');
    await publishEvent(t.deps.infra.bus, forHome);
    await publishEvent(t.deps.infra.bus, forSecond);
    expect(await inHome.next()).toEqual(forHome);
    expect(await inSecond.next()).toEqual(forSecond);
    // An event that names no organization reaches nobody.
    await publishEvent(
      t.deps.infra.bus,
      wsEvent(
        'computer.status',
        { computerId: '00000000-0000-4000-8000-000000000003', status: 'stopped', error: null },
        { user_id: aliceId },
      ),
    );
    inHome.send({ type: 'ping' });
    expect(await inHome.next()).toMatchObject({ type: 'pong' });
    expect(inHome.frames).toEqual([]);
    expect(inSecond.frames).toEqual([]);
    inHome.close();
    inSecond.close();
  });
});

interface TestClient {
  raw: WebSocket;
  frames: ServerFrame[];
  send(frame: unknown): void;
  next(): Promise<ServerFrame>;
  close(): void;
}

function connect(url: string, headers: Record<string, string>): Promise<TestClient> {
  const raw = new WebSocket(url, { headers });
  const frames: ServerFrame[] = [];
  let waiting: ((frame: ServerFrame) => void) | undefined;
  raw.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as ServerFrame;
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(frame);
    } else frames.push(frame);
  });
  const client: TestClient = {
    raw,
    frames,
    send: (frame) => raw.send(JSON.stringify(frame)),
    next: () => {
      const queued = frames.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no frame')), 2000);
        waiting = (frame) => {
          clearTimeout(timer);
          resolve(frame);
        };
      });
    },
    close: () => raw.close(),
  };
  return new Promise((resolve, reject) => {
    raw.once('open', () => resolve(client));
    raw.once('error', reject);
  });
}

/** The HTTP status an upgrade was refused with. */
function refused(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const raw = new WebSocket(url, { headers });
    raw.once('open', () => {
      raw.close();
      reject(new Error('upgrade was accepted'));
    });
    raw.once('unexpected-response', (_, res) => {
      resolve(res.statusCode ?? 0);
      raw.terminate();
    });
    raw.once('error', () => {});
  });
}
