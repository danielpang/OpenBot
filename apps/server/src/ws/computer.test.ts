import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { COMPUTER_OFF_CLOSE_CODE } from '@openbots/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { schema } from '../db/client.js';
import { MEMBERSHIP_ENDED_CHANNEL, type MembershipEnded } from '../membership.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';
import { useTestComputer, type TestComputer } from '../test-computer.js';
import {
  attachComputerProxies,
  isComputerSocketPath,
  SOCKET_TOUCH_MS,
  type ComputerProxies,
} from './computer.js';
import { attachGateway, type Gateway } from './gateway.js';

// The terminal and screen sockets (plan 9.3, 9.4): authenticated like `/ws`,
// proxied to the agent with its token, frames passed through both ways.

describe('computer socket proxies', () => {
  let t: TestApp;
  let computer: TestComputer;
  let server: ServerType;
  let gateway: Gateway;
  let proxies: ComputerProxies;
  let base: string;
  let dana: string;
  let eve: string;
  let botId: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    computer = await useTestComputer(t.ownerDeps);
    server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    gateway = await attachGateway(server, t.deps, { ignore: isComputerSocketPath });
    // Long enough that reopening a socket on a busy machine fits inside it.
    proxies = await attachComputerProxies(server, t.deps, { takeoverGraceMs: 1_000 });
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dana = (await t.signUp('dana@example.com')).cookie!;
    eve = (await t.signUp('eve@example.com')).cookie!;
    const res = await t.app.request('/api/v1/bots', {
      method: 'POST',
      headers: { cookie: dana, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Viewer' }),
    });
    botId = ((await res.json()) as { id: string }).id;
  });
  async function startedByOwner() {
    const res = await t.app.request('/api/v1/computer/start', {
      method: 'POST',
      headers: { cookie: dana },
    });
    expect(res.status).toBe(200);
  }

  afterAll(async () => {
    await proxies.close();
    await gateway.close();
    await new Promise((resolve) => server.close(resolve));
    await computer.close();
    await t.close();
  });

  it('closes with COMPUTER_OFF instead of starting the computer', async () => {
    const pty = `${base}/api/v1/computer/pty?cols=80&rows=24`;
    expect(await closedWith(pty, dana)).toEqual({
      code: COMPUTER_OFF_CLOSE_CODE,
      reason: 'COMPUTER_OFF',
    });
    // noVNC asks for a subprotocol; the close still reaches it.
    const vnc = `${base}/api/v1/bots/${botId}/screen/vnc`;
    expect(await closedWith(vnc, dana, ['binary'])).toEqual({
      code: COMPUTER_OFF_CLOSE_CODE,
      reason: 'COMPUTER_OFF',
    });
    expect(computer.docker.calls.some((c) => c.op === 'createContainer' || c.op === 'start')).toBe(
      false,
    );
    expect(await t.db.select().from(schema.computers)).toEqual([]);

    // Stopped is off too.
    await startedByOwner();
    await t.app.request('/api/v1/computer/stop', { method: 'POST', headers: { cookie: dana } });
    const starts = computer.docker.calls.filter((c) => c.op === 'start').length;
    expect((await closedWith(vnc, dana, ['binary'])).code).toBe(COMPUTER_OFF_CLOSE_CODE);
    expect(computer.docker.calls.filter((c) => c.op === 'start')).toHaveLength(starts);
  });

  it('proxies the terminal to the agent of a running computer', async () => {
    await startedByOwner();
    const reply = await roundTrip(`${base}/api/v1/computer/pty?cols=80&rows=24`, dana, 'ls');
    expect(reply).toBe('/pty:ls');
  });

  it("proxies a Bot's screen to its display, starting the screen", async () => {
    const reply = await roundTrip(`${base}/api/v1/bots/${botId}/screen/vnc`, dana, 'rfb');
    expect(reply).toBe('/vnc/0:rfb');
    expect(computer.agent.screens.has(0)).toBe(true);
  });

  it('keeps the computer used while frames flow, at most once a minute (plan 9.5)', async () => {
    const lastUsed = async () =>
      (await t.db.select().from(schema.computers))[0]!.lastUsedAt!.getTime();
    const socket = await opened(`${base}/api/v1/computer/pty?cols=80&rows=24`, dana);
    try {
      await t.db.update(schema.computers).set({ lastUsedAt: new Date(0) });
      // Within the minute since it opened: nothing is written.
      await echo(socket, 'pwd');
      expect(await lastUsed()).toBe(0);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + SOCKET_TOUCH_MS);
      await echo(socket, 'ls');
      await vi.waitFor(async () => expect(await lastUsed()).toBeGreaterThan(0));
    } finally {
      vi.useRealTimers();
      socket.close();
    }
  });

  async function control(action: 'take' | 'release') {
    const res = await t.app.request(`/api/v1/bots/${botId}/screen/control`, {
      method: 'POST',
      headers: { cookie: dana, 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    expect(res.status).toBe(200);
  }
  const holder = async () =>
    (await t.db.select().from(schema.botScreens).where(eq(schema.botScreens.botId, botId)))[0]!
      .controlledByUserId;
  const closing = (ws: WebSocket) =>
    new Promise<{ code: number; reason: string }>((resolve) =>
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('hands a takeover back once its tab is gone past the grace, not before (K3)', async () => {
    const vnc = `${base}/api/v1/bots/${botId}/screen/vnc`;
    await control('take');
    const owner = await holder();
    expect(owner).not.toBeNull();

    // The view-only Preview closing is no reason.
    (await opened(vnc, dana, ['binary'])).close();
    await pause(150);
    expect(await holder()).toBe(owner);

    // A reload: the takeover's socket comes back within the grace.
    const first = await opened(`${vnc}?control=1`, dana, ['binary']);
    first.close();
    const again = await opened(`${vnc}?control=1`, dana, ['binary']);
    await pause(150);
    expect(await holder()).toBe(owner);

    // The tab closes for good: handed back, then the screen's cookies synced.
    const syncs = computer.agent.cookieSyncs.length;
    again.close();
    await vi.waitFor(
      async () => {
        expect(await holder()).toBeNull();
        expect(computer.agent.cookieSyncs.slice(syncs)).toEqual([0]);
      },
      { timeout: 5_000 },
    );
    const [audit] = await t.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'computer.release'));
    expect(audit).toMatchObject({ targetId: botId, actorType: 'user' });
  });

  it("closes a suspended member's sockets and hands back their screens (U3, plan 21.6)", async () => {
    await control('take');
    const pty = await opened(`${base}/api/v1/computer/pty?cols=80&rows=24`, dana);
    const screen = await opened(`${base}/api/v1/bots/${botId}/screen/vnc?control=1`, dana, [
      'binary',
    ]);
    const closed = Promise.all([closing(pty), closing(screen)]);
    const userId = (await holder())!;
    await t.deps.infra.bus.publish<MembershipEnded>(MEMBERSHIP_ENDED_CHANNEL, {
      userId,
      workspaceId: await t.defaultOrganization(),
    });
    expect(await closed).toEqual([
      { code: 1008, reason: 'membership ended' },
      { code: 1008, reason: 'membership ended' },
    ]);
    await vi.waitFor(async () => expect(await holder()).toBeNull());
  });

  it("closes a revoked phone's shell and screen at once, and a key gone unheard within the minute", async () => {
    await startedByOwner();
    const workspaceId = await t.defaultOrganization();
    const ownerId = await t.userId('dana@example.com');
    const makeKey = async (name: string) => {
      const res = await t.app.request('/api/v1/api-keys', {
        method: 'POST',
        headers: { cookie: dana, 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      return (await res.json()) as { id: string; key: string };
    };
    const byKey = (url: string, key: string, protocols: string[] = []) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(url, protocols, { headers: { authorization: `Bearer ${key}` } });
        ws.once('open', () => resolve(ws));
        ws.once('unexpected-response', (_, res) => reject(new Error(`refused ${res.statusCode}`)));
        ws.once('error', reject);
      });
    const phoneKey = await makeKey('phone');
    const [device] = await t.db
      .insert(schema.devices)
      .values({
        workspaceId,
        ownerId,
        name: 'Phone',
        platform: 'ios',
        publicKey: Buffer.alloc(32, 8),
        apiKeyId: phoneKey.id,
      })
      .returning();
    const pty = await byKey(`${base}/api/v1/computer/pty?cols=80&rows=24`, phoneKey.key);
    const screen = await byKey(`${base}/api/v1/bots/${botId}/screen/vnc`, phoneKey.key, ['binary']);
    const closed = Promise.all([closing(pty), closing(screen)]);
    const res = await t.app.request(`/api/v1/devices/${device!.id}`, {
      method: 'DELETE',
      headers: { cookie: dana },
    });
    expect(res.status).toBe(204);
    expect(await closed).toEqual([
      { code: 1008, reason: 'api key revoked' },
      { code: 1008, reason: 'api key revoked' },
    ]);

    // Deleted where this process heard nothing of it: the next look finds it.
    const quiet = await makeKey('quiet');
    const shell = await byKey(`${base}/api/v1/computer/pty?cols=80&rows=24`, quiet.key);
    const shellClosed = closing(shell);
    await t.db.delete(schema.apikeys).where(eq(schema.apikeys.id, quiet.id));
    await proxies.checkKeys();
    expect(await shellClosed).toEqual({ code: 1008, reason: 'api key revoked' });
  });

  it('refuses other origins, strangers and other users’ Bots', async () => {
    const vnc = `${base}/api/v1/bots/${botId}/screen/vnc`;
    expect(await refused(vnc, { cookie: dana, origin: 'https://evil.example' })).toBe(403);
    expect(await refused(vnc, { origin: ORIGIN })).toBe(401);
    expect(await refused(vnc, { cookie: eve, origin: ORIGIN })).toBe(404);
    // Refused before anything starts: Eve has no computer (S-18 G4).
    const computers = await t.db
      .select({ ownerId: schema.computers.ownerId, email: schema.users.email })
      .from(schema.computers)
      .innerJoin(schema.users, eq(schema.users.id, schema.computers.ownerId));
    expect(computers.map((c) => c.email)).toEqual(['dana@example.com']);
    // The gateway still answers its own path and refuses unknown ones.
    expect(await refused(`${base}/api/v1/elsewhere`, { cookie: dana, origin: ORIGIN })).toBe(404);
  });
});

function closedWith(
  url: string,
  cookie: string,
  protocols: string[] = [],
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, { headers: { cookie, origin: ORIGIN } });
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.once('unexpected-response', (_, res) => reject(new Error(`refused ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

function roundTrip(url: string, cookie: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { cookie, origin: ORIGIN } });
    ws.once('open', () => ws.send(text));
    ws.once('message', (data) => {
      resolve(data.toString());
      ws.close();
    });
    ws.once('unexpected-response', (_, res) => reject(new Error(`refused ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

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

function opened(url: string, cookie: string, protocols: string[] = []): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, { headers: { cookie, origin: ORIGIN } });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_, res) => reject(new Error(`refused ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

function echo(ws: WebSocket, text: string): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(data.toString()));
    ws.send(text);
  });
}
