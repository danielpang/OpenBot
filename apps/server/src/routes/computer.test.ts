import { createRemoteProvider } from '@openbots/computer';
import { startFakeAgent, type FakeAgent } from '@openbots/computer/testing';
import { EVENTS_CHANNEL, type WsEvent } from '@openbots/shared';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import {
  IDLE_STOP_RETRY_MAX_MS,
  IDLE_SWEEP_MS,
  idleStopRetryDelayMs,
  refreshSandboxImage,
  setComputerProvider,
  sweepIdleComputers,
} from '../services/computer.js';
import { useTestComputer, type TestComputer } from '../test-computer.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { inEveryOrganization } from '../workers.js';

describe('computer API', () => {
  let t: TestApp;
  let computer: TestComputer;
  let dana: string;
  let eve: string;
  let danaId: string;
  const events: WsEvent[] = [];

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    computer = await useTestComputer(t.ownerDeps);
    dana = (await t.signUp('dana@example.com')).cookie!;
    eve = (await t.signUp('eve@example.com')).cookie!;
    danaId = (
      await t.db.select().from(schema.users).where(eq(schema.users.email, 'dana@example.com'))
    )[0]!.id;
    await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
  });
  afterAll(async () => {
    await computer.close();
    await t.close();
  });

  function call(
    cookie: string,
    method: string,
    path: string,
    body?: RequestInit['body'],
    type = 'application/json',
  ) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': type }) },
      body,
    });
  }

  it('has no computer until first use', async () => {
    const res = await call(dana, 'GET', '/computer');
    expect(await res.json()).toEqual({ available: true, computer: null });
    const caps = await (await t.app.request('/api/v1/capabilities')).json();
    expect(caps).toMatchObject({ computer: true });
  });

  it('creates and starts the computer on first use, with the token sealed', async () => {
    const res = await call(dana, 'POST', '/computer/start');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      provider: 'docker',
      status: 'running',
      alwaysOn: false,
      idleTimeoutMin: 30,
      screens: [],
    });
    expect(JSON.stringify(body)).not.toContain(computer.agent.token);

    const created = computer.docker.calls.find((c) => c.op === 'createContainer')!.args[0] as {
      HostConfig: Record<string, unknown>;
      Env: string[];
    };
    expect(created.HostConfig).toMatchObject({
      CapDrop: ['ALL'],
      ReadonlyRootfs: true,
      NetworkMode: 'openbots-sbx',
    });
    // The token goes in as a file, not in the container's environment (S-7).
    expect(JSON.stringify(created)).not.toContain(computer.agent.token);
    expect(computer.docker.calls.some((c) => c.op === 'putArchive')).toBe(true);

    const [row] = await t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.ownerId, danaId));
    expect(Buffer.from(row!.agentToken!).toString()).not.toContain(computer.agent.token);
    expect(row!.volumeName).toBe(`openbots-home-${row!.id}`);

    const statuses = events.filter((e) => e.type === 'computer.status');
    expect(statuses.map((e) => e.payload.status)).toEqual([
      'creating',
      'stopped',
      'starting',
      'running',
    ]);
    expect(statuses.every((e) => e.user_id === danaId && !e.bot_id)).toBe(true);
    await vi.waitFor(() =>
      expect(computer.agent.calls.some((c) => c.path === '/wallpaper')).toBe(true),
    );

    // Started again: nothing new is created.
    const creates = computer.docker.calls.filter((c) => c.op === 'createContainer').length;
    expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
    expect(computer.docker.calls.filter((c) => c.op === 'createContainer')).toHaveLength(creates);
  });

  it('browses, uploads and downloads files under /home/bot (K7)', async () => {
    const put = await call(
      dana,
      'PUT',
      '/computer/files/notes/my%20plan.md',
      '# Plan',
      'application/octet-stream',
    );
    expect(put.status, await put.clone().text()).toBe(200);
    expect(await put.json()).toEqual({ path: '/home/bot/notes/my plan.md', size: 6 });
    expect(new TextDecoder().decode(computer.agent.files.get('notes/my plan.md'))).toBe('# Plan');

    const list = await call(dana, 'GET', '/computer/files?path=notes');
    expect(await list.json()).toMatchObject({
      path: '/home/bot/notes',
      entries: [{ name: 'my plan.md', type: 'file', size: 6 }],
    });
    const root = await call(dana, 'GET', '/computer/files');
    expect(await root.json()).toMatchObject({
      path: '/home/bot',
      entries: [{ name: 'notes', type: 'dir' }],
    });

    const file = await call(dana, 'GET', '/computer/files/notes/my%20plan.md');
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('# Plan');
    expect(file.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''my%20plan.md",
    );
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(file.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");

    expect((await call(dana, 'GET', '/computer/files/notes/missing.md')).status).toBe(404);
    expect((await call(dana, 'GET', '/computer/files?path=/etc')).status).toBe(400);
    expect((await call(dana, 'GET', '/computer/files/..%2F..%2Fetc%2Fpasswd')).status).toBe(400);
    expect((await t.app.request('/api/v1/computer/files?path=notes')).status).toBe(401);
  });

  it('takes a Bot screen over and hands it back (K3)', async () => {
    const bot = (await (
      await call(dana, 'POST', '/bots', JSON.stringify({ name: 'Browser' }))
    ).json()) as { id: string };
    expect(
      (
        await call(
          dana,
          'POST',
          `/bots/${bot.id}/screen/control`,
          JSON.stringify({ action: 'release' }),
        )
      ).status,
    ).toBe(404);

    const taken = await call(
      dana,
      'POST',
      `/bots/${bot.id}/screen/control`,
      JSON.stringify({ action: 'take' }),
    );
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({
      botId: bot.id,
      display: 10,
      status: 'running',
      controlledByUserId: danaId,
    });
    // A fresh screen starts with a clean browser profile: no logins from a deleted Bot.
    expect(computer.agent.calls).toContainEqual({
      method: 'POST',
      path: '/screens',
      body: { n: 0, width: 1280, height: 800, fresh: true },
    });
    expect(computer.agent.screens.get(0)).toMatchObject({
      cdpPort: 9222,
      width: 1280,
      height: 800,
    });

    const released = await call(
      dana,
      'POST',
      `/bots/${bot.id}/screen/control`,
      JSON.stringify({ action: 'release' }),
    );
    expect(await released.json()).toMatchObject({
      controlledByUserId: null,
      controlledSince: null,
    });
    // A sign-in the owner did on the screen reaches the other Bots' browsers (K1).
    expect(computer.agent.cookieSyncs).toEqual([0]);
    expect(
      events
        .filter((e) => e.type === 'screen.control')
        .map((e) => [e.bot_id, e.payload.controller]),
    ).toEqual([
      [bot.id, 'user'],
      [bot.id, 'bot'],
    ]);
    const state = (await (await call(dana, 'GET', '/computer')).json()) as {
      computer: { screens: unknown[] };
    };
    expect(state.computer.screens).toEqual([
      expect.objectContaining({ botId: bot.id, display: 10 }),
    ]);

    // Another user's Bot is not found.
    expect(
      (
        await call(
          eve,
          'POST',
          `/bots/${bot.id}/screen/control`,
          JSON.stringify({ action: 'take' }),
        )
      ).status,
    ).toBe(404);
  });

  it('stops on request and after the idle timeout, keeping the volume', async () => {
    const stopped = await call(dana, 'POST', '/computer/stop');
    expect(await stopped.json()).toMatchObject({
      status: 'stopped',
      screens: [expect.objectContaining({ status: 'stopped' })],
    });
    // The home and the state volume (Chromium profiles).
    expect(computer.docker.volumes.size).toBe(2);
    expect((await call(eve, 'POST', '/computer/stop')).status).toBe(404);

    await call(dana, 'POST', '/computer/start');
    expect(await inEveryOrganization(t.deps, () => sweepIdleComputers(t.deps))).toBe(0);
    const [row] = await t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.ownerId, danaId));
    await t.db
      .update(schema.computers)
      .set({ alwaysOn: true, lastUsedAt: new Date(0) })
      .where(eq(schema.computers.id, row!.id));
    expect(await inEveryOrganization(t.deps, () => sweepIdleComputers(t.deps))).toBe(0);
    await t.db
      .update(schema.computers)
      .set({ alwaysOn: false })
      .where(eq(schema.computers.id, row!.id));
    expect(await inEveryOrganization(t.deps, () => sweepIdleComputers(t.deps))).toBe(1);
    const [after] = await t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.id, row!.id));
    expect(after!.status).toBe('stopped');
    // The home and the state volume (Chromium profiles).
    expect(computer.docker.volumes.size).toBe(2);
  });

  it('audits create, start, stop, takeover and release (S-11)', async () => {
    const { db } = t;
    const [row] = await db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.ownerId, danaId));
    const lifecycle = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, row!.id))
      .orderBy(schema.auditLog.createdAt);
    expect(lifecycle.map((a) => [a.action, a.actorType, a.actorId])).toEqual([
      ['computer.create', 'user', danaId],
      ['computer.start', 'user', danaId],
      ['computer.stop', 'user', danaId],
      ['computer.start', 'user', danaId],
      // The idle sweep.
      ['computer.stop', 'system', null],
    ]);
    expect(lifecycle[1]!.metadata).toMatchObject({ durationMs: expect.any(Number) });

    const screens = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetType, 'bot'))
      .orderBy(schema.auditLog.createdAt);
    expect(
      screens
        .filter((a) => a.action.startsWith('computer.'))
        .map((a) => [a.action, a.actorId, a.metadata]),
    ).toEqual([
      ['computer.takeover', danaId, expect.objectContaining({ display: 10 })],
      ['computer.release', danaId, expect.objectContaining({ display: 10 })],
    ]);
  });

  it('retries a failed idle stop on later sweeps, backing off (plan 9.5)', async () => {
    const { db } = t;
    const rowOf = async () =>
      (await db.select().from(schema.computers).where(eq(schema.computers.ownerId, danaId)))[0]!;
    await call(dana, 'POST', '/computer/start');
    await db
      .update(schema.computers)
      .set({ lastUsedAt: new Date(0) })
      .where(eq(schema.computers.id, (await rowOf()).id));
    const stop = computer.provider.stop;
    let attempts = 0;
    computer.provider.stop = async () => {
      attempts++;
      throw new Error('daemon busy');
    };
    const sweep = (at: number) =>
      inEveryOrganization(t.deps, () => sweepIdleComputers(t.deps, new Date(at)));
    const now = Date.now();
    const seen = events.length;
    try {
      // The first failure: `error`, with the retry one sweep later.
      expect(await sweep(now)).toBe(0);
      expect(attempts).toBe(1);
      let row = await rowOf();
      expect(row.status).toBe('error');
      expect(row.spec).toMatchObject({
        idleStopRetry: { failures: 1, retryAt: new Date(now + IDLE_SWEEP_MS).toISOString() },
      });
      expect(
        events
          .slice(seen)
          .filter((e) => e.type === 'computer.status')
          .map((e) => [e.payload.status, e.payload.error]),
      ).toEqual([
        ['stopping', null],
        ['error', 'daemon busy'],
      ]);

      // Not due yet: nothing is tried.
      expect(await sweep(now + IDLE_SWEEP_MS / 2)).toBe(0);
      expect(attempts).toBe(1);

      // Due: it fails again and waits twice as long.
      expect(await sweep(now + IDLE_SWEEP_MS)).toBe(0);
      expect(attempts).toBe(2);
      row = await rowOf();
      expect(row.spec).toMatchObject({
        idleStopRetry: {
          failures: 2,
          retryAt: new Date(now + 3 * IDLE_SWEEP_MS).toISOString(),
        },
      });
      expect(await sweep(now + 2 * IDLE_SWEEP_MS)).toBe(0);
      expect(attempts).toBe(2);

      // The daemon answers again: the retry stops it and the retry is dropped.
      computer.provider.stop = stop;
      expect(await sweep(now + 3 * IDLE_SWEEP_MS)).toBe(1);
      row = await rowOf();
      expect(row.status).toBe('stopped');
      expect(row.spec).not.toHaveProperty('idleStopRetry');
      expect(await sweep(now + 10 * IDLE_SWEEP_MS)).toBe(0);
    } finally {
      computer.provider.stop = stop;
    }
  });

  it('drops a pending idle stop retry when the computer starts again', async () => {
    const { db } = t;
    await call(dana, 'POST', '/computer/start');
    const [row] = await db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.ownerId, danaId));
    await db
      .update(schema.computers)
      .set({ lastUsedAt: new Date(0) })
      .where(eq(schema.computers.id, row!.id));
    const stop = computer.provider.stop;
    computer.provider.stop = () => Promise.reject(new Error('daemon busy'));
    try {
      expect(await inEveryOrganization(t.deps, () => sweepIdleComputers(t.deps))).toBe(0);
    } finally {
      computer.provider.stop = stop;
    }
    expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
    const [started] = await db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.id, row!.id));
    expect(started).toMatchObject({ status: 'running' });
    expect(started!.spec).not.toHaveProperty('idleStopRetry');
    // Used just now: a sweep leaves it running.
    expect(await inEveryOrganization(t.deps, () => sweepIdleComputers(t.deps))).toBe(0);
    await call(dana, 'POST', '/computer/stop');
  });

  it('does not start a stopped computer to list, download or upload files', async () => {
    const [row] = await t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.ownerId, danaId));
    expect(row!.status).toBe('stopped');
    const starts = computer.docker.calls.filter((c) => c.op === 'start').length;
    for (const res of [
      await call(dana, 'GET', '/computer/files?path=notes'),
      await call(dana, 'GET', '/computer/files/notes/my%20plan.md'),
      await call(dana, 'PUT', '/computer/files/x.txt', 'x', 'application/octet-stream'),
    ]) {
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'COMPUTER_OFF' });
    }
    expect(computer.docker.calls.filter((c) => c.op === 'start')).toHaveLength(starts);
    // A user with no computer yet gets the same, and none is created.
    expect((await call(eve, 'GET', '/computer/files')).status).toBe(409);
    expect(await (await call(eve, 'GET', '/computer')).json()).toMatchObject({ computer: null });
  });

  it("stops a deleted Bot's screen and hands its display on fresh (B7, K2)", async () => {
    const { db } = t;
    const newBot = async (name: string) =>
      (
        (await (await call(dana, 'POST', '/bots', JSON.stringify({ name }))).json()) as {
          id: string;
        }
      ).id;
    const take = (botId: string, action: 'take' | 'release') =>
      call(dana, 'POST', `/bots/${botId}/screen/control`, JSON.stringify({ action }));
    const screenRows = (botId: string) =>
      db.select().from(schema.botScreens).where(eq(schema.botScreens.botId, botId));

    // Taking the screen over starts the computer and the Bot's screen.
    const doomed = await newBot('Doomed');
    const taken = (await (await take(doomed, 'take')).json()) as { display: number };
    await take(doomed, 'release');
    const n = taken.display - 10;
    expect(computer.agent.screens.has(n)).toBe(true);

    expect((await call(dana, 'DELETE', `/bots/${doomed}`)).status).toBe(204);
    expect(computer.agent.calls).toContainEqual(
      expect.objectContaining({ method: 'DELETE', path: `/screens/${n}` }),
    );
    expect(computer.agent.screens.has(n)).toBe(false);
    expect(await screenRows(doomed)).toEqual([]);

    // The next Bot gets the freed display with an empty browser profile.
    const next = await newBot('Next');
    expect(await (await take(next, 'take')).json()).toMatchObject({ display: taken.display });
    expect(computer.agent.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/screens',
      body: { n, fresh: true },
    });
    await take(next, 'release');

    // Stopped: nothing to stop on the agent, and the delete still succeeds.
    await call(dana, 'POST', '/computer/stop');
    const before = computer.agent.calls.length;
    expect((await call(dana, 'DELETE', `/bots/${next}`)).status).toBe(204);
    expect(computer.agent.calls).toHaveLength(before);
    expect(await screenRows(next)).toEqual([]);
  });

  it('makes a stopped computer again when the egress proxy changed, keeping its volumes (plan 9.5)', async () => {
    const creates = () => computer.docker.calls.filter((c) => c.op === 'createContainer');
    const made = creates().length;
    const volumes = new Set(computer.docker.volumes);
    const computerRow = async () =>
      (await t.db.select().from(schema.computers).where(eq(schema.computers.ownerId, danaId)))[0]!;
    expect((await computerRow()).status).toBe('stopped');

    // Unchanged settings: started as it is.
    expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
    expect(creates()).toHaveLength(made);
    await call(dana, 'POST', '/computer/stop');

    t.deps.config.sandboxProxy = { url: 'http://172.30.255.3:8888' };
    try {
      expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
      expect(creates()).toHaveLength(made + 1);
      const env = (creates().at(-1)!.args[0] as { Env: string[] }).Env;
      expect(env).toContain('HTTPS_PROXY=http://172.30.255.3:8888');
      expect(env).toContain('http_proxy=http://172.30.255.3:8888');
      expect(env).toContain('NO_PROXY=localhost,127.0.0.1');
      expect(computer.docker.volumes).toEqual(volumes);
      const row = await computerRow();
      expect(row.status).toBe('running');
      // Only a fingerprint of the settings is stored: a proxy URL may hold a password.
      expect(row.spec).toMatchObject({ envKey: expect.any(String) });
      expect(JSON.stringify(row.spec)).not.toContain('172.30.255.3');

      // A running computer keeps its settings until it next starts.
      t.deps.config.sandboxProxy = undefined;
      expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
      expect(creates()).toHaveLength(made + 1);
    } finally {
      t.deps.config.sandboxProxy = undefined;
      await call(dana, 'POST', '/computer/stop');
    }
  });

  it('makes a stopped computer again on a new sandbox network, keeping its volumes (K6)', async () => {
    const creates = () => computer.docker.calls.filter((c) => c.op === 'createContainer');
    const volumes = new Set(computer.docker.volumes);
    const specOf = async () =>
      (await t.db.select().from(schema.computers).where(eq(schema.computers.ownerId, danaId)))[0]!
        .spec as Record<string, unknown>;
    // Made on the default network, and recorded so.
    expect(await specOf()).toMatchObject({ network: 'openbots-sbx' });
    const made = creates().length;

    const old = t.deps.config.sandboxNetwork;
    t.deps.config.sandboxNetwork = { name: 'openbots-app-sandbox-254', bridge: 'openbots-a-254' };
    try {
      expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
      expect(creates()).toHaveLength(made + 1);
      expect(await specOf()).toMatchObject({ network: 'openbots-app-sandbox-254' });
      expect(computer.docker.volumes).toEqual(volumes);
      await call(dana, 'POST', '/computer/stop');
      // Unchanged since: started as it is.
      expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
      expect(creates()).toHaveLength(made + 1);
    } finally {
      t.deps.config.sandboxNetwork = old;
      await call(dana, 'POST', '/computer/stop');
    }
    // Back on the default network: made again there.
    expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
    expect(creates()).toHaveLength(made + 2);
    expect(await specOf()).toMatchObject({ network: 'openbots-sbx' });
    await call(dana, 'POST', '/computer/stop');
  });

  it("runs the computer on the instance's timezone, made again when it changes", async () => {
    const creates = () => computer.docker.calls.filter((c) => c.op === 'createContainer');
    const envOf = (i: number) => (creates().at(i)!.args[0] as { Env: string[] }).Env;
    // The first computer ran on the default.
    expect(envOf(0)).toContain('TZ=UTC');
    const made = creates().length;

    t.deps.config.timezone = 'America/New_York';
    try {
      expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
      expect(creates()).toHaveLength(made + 1);
      expect(envOf(-1)).toContain('TZ=America/New_York');
      // The wallpaper follows the computer's own clock, not the server's hour.
      await vi.waitFor(() =>
        expect(computer.agent.calls.filter((c) => c.path === '/wallpaper').at(-1)?.body).toEqual(
          {},
        ),
      );
      await call(dana, 'POST', '/computer/stop');
      // Unchanged since: started as it is.
      expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
      expect(creates()).toHaveLength(made + 1);
    } finally {
      t.deps.config.timezone = 'UTC';
      await call(dana, 'POST', '/computer/stop');
    }
  });

  it('moves a computer to a new image after an upgrade, at a start and never while it runs (plan 16.3)', async () => {
    const creates = () => computer.docker.calls.filter((c) => c.op === 'createContainer');
    const imageOf = (i: number) => (creates().at(i)!.args[0] as { Image: string }).Image;
    const volumes = new Set(computer.docker.volumes);
    const statusesSince = (seen: number) =>
      events
        .slice(seen)
        .filter((e) => e.type === 'computer.status')
        .map((e) => e.payload.status);
    const old = t.deps.config.sandboxImage;
    expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
    const made = creates().length;

    t.deps.config.sandboxImage = 'ghcr.io/danielpang/openbots/computer:9.9.9';
    try {
      // Running: it keeps its container, so no task loses its machine.
      expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
      expect(creates()).toHaveLength(made);

      // Its next start, after a stop, makes it again from the new image.
      await call(dana, 'POST', '/computer/stop');
      const seen = events.length;
      expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
      expect(creates()).toHaveLength(made + 1);
      expect(imageOf(-1)).toBe('ghcr.io/danielpang/openbots/computer:9.9.9');
      expect(statusesSince(seen)).toEqual(['updating', 'stopped', 'starting', 'running']);
      expect(computer.docker.volumes).toEqual(volumes);
      const [row] = await t.db
        .select()
        .from(schema.computers)
        .where(eq(schema.computers.ownerId, danaId));
      expect(row!.spec).toMatchObject({ image: 'ghcr.io/danielpang/openbots/computer:9.9.9' });
      const [audit] = await t.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'computer.create'))
        .orderBy(desc(schema.auditLog.createdAt))
        .limit(1);
      expect(audit!.metadata).toMatchObject({
        updated: true,
        image: 'ghcr.io/danielpang/openbots/computer:9.9.9',
      });

      // Up to date since: started as it is.
      await call(dana, 'POST', '/computer/stop');
      expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
      expect(creates()).toHaveLength(made + 1);
    } finally {
      t.deps.config.sandboxImage = old;
      await call(dana, 'POST', '/computer/stop');
    }
  });

  it('moves a computer to a newer build of the same tag, pulled at worker start (plan 16.3)', async () => {
    const creates = () => computer.docker.calls.filter((c) => c.op === 'createContainer');
    const image = t.deps.config.sandboxImage;
    // Back on the configured image after the test before.
    await call(dana, 'POST', '/computer/start');
    await call(dana, 'POST', '/computer/stop');
    const made = creates().length;
    await refreshSandboxImage(t.ownerDeps);
    expect(computer.docker.calls.at(-1)).toEqual({ op: 'pull', args: [image] });
    // Nothing moved: started as it is.
    expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
    await call(dana, 'POST', '/computer/stop');
    expect(creates()).toHaveLength(made);

    computer.docker.imageIds.set(image, 'sha256:next-release');
    try {
      expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
      expect(creates()).toHaveLength(made + 1);
      await call(dana, 'POST', '/computer/stop');
      expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
      expect(creates()).toHaveLength(made + 1);
    } finally {
      await call(dana, 'POST', '/computer/stop');
    }
  });

  it('never stops a computer for idleness while the owner has a screen, and a stop hands it back (K3)', async () => {
    const { db } = t;
    const bot = (await (
      await call(dana, 'POST', '/bots', JSON.stringify({ name: 'Held' }))
    ).json()) as { id: string };
    const control = (action: 'take' | 'release') =>
      call(dana, 'POST', `/bots/${bot.id}/screen/control`, JSON.stringify({ action }));
    const idle = async () => {
      const [row] = await db
        .select()
        .from(schema.computers)
        .where(eq(schema.computers.ownerId, danaId));
      await db
        .update(schema.computers)
        .set({ lastUsedAt: new Date(0) })
        .where(eq(schema.computers.id, row!.id));
    };
    expect((await control('take')).status).toBe(200);
    await idle();
    // A long sign-in on the screen: the computer stays on.
    expect(await inEveryOrganization(t.deps, () => sweepIdleComputers(t.deps))).toBe(0);
    expect((await control('release')).status).toBe(200);
    expect(await inEveryOrganization(t.deps, () => sweepIdleComputers(t.deps))).toBe(1);

    // Stopped while held: the takeover ends and the Bot is told it has the screen back.
    expect((await control('take')).status).toBe(200);
    const seen = events.length;
    expect((await call(dana, 'POST', '/computer/stop')).status).toBe(200);
    const [screen] = await db
      .select()
      .from(schema.botScreens)
      .where(eq(schema.botScreens.botId, bot.id));
    expect(screen).toMatchObject({ controlledByUserId: null, controlledSince: null });
    expect(
      events
        .slice(seen)
        .filter((e) => e.type === 'screen.control')
        .map((e) => [e.bot_id, e.payload.controller]),
    ).toEqual([[bot.id, 'bot']]);
  });

  it('lets the owner keep the computer on or change its idle timeout (plan 9.5)', async () => {
    const { db } = t;
    const settings = (cookie: string, body: unknown) =>
      call(cookie, 'PATCH', '/computer', JSON.stringify(body));
    expect((await settings(eve, { alwaysOn: true })).status, 'no computer yet').toBe(404);
    for (const bad of [{ idleTimeoutMin: 4 }, { idleTimeoutMin: 1441 }, { other: 1 }]) {
      expect((await settings(dana, bad)).status).toBe(400);
    }

    await call(dana, 'POST', '/computer/start');
    const [row] = await db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.ownerId, danaId));
    const usedAgo = (minutes: number) =>
      db
        .update(schema.computers)
        .set({ lastUsedAt: new Date(Date.now() - minutes * 60_000) })
        .where(eq(schema.computers.id, row!.id));

    const saved = await settings(dana, { idleTimeoutMin: 120 });
    expect(await saved.json()).toMatchObject({ idleTimeoutMin: 120, alwaysOn: false });
    // Unused for an hour: under the new timeout, it stays on.
    await usedAgo(60);
    expect(await inEveryOrganization(t.deps, () => sweepIdleComputers(t.deps))).toBe(0);

    expect(await (await settings(dana, { alwaysOn: true })).json()).toMatchObject({
      alwaysOn: true,
      idleTimeoutMin: 120,
    });
    await usedAgo(24 * 60);
    expect(await inEveryOrganization(t.deps, () => sweepIdleComputers(t.deps))).toBe(0);

    await settings(dana, { alwaysOn: false, idleTimeoutMin: 30 });
    expect(await inEveryOrganization(t.deps, () => sweepIdleComputers(t.deps))).toBe(1);
    expect(await (await call(dana, 'GET', '/computer')).json()).toMatchObject({
      computer: { status: 'stopped', alwaysOn: false, idleTimeoutMin: 30 },
    });
  });

  it('backs idle stop retries off up to a cap', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(idleStopRetryDelayMs)).toEqual([
      IDLE_SWEEP_MS,
      2 * IDLE_SWEEP_MS,
      4 * IDLE_SWEEP_MS,
      8 * IDLE_SWEEP_MS,
      16 * IDLE_SWEEP_MS,
      IDLE_STOP_RETRY_MAX_MS,
      IDLE_STOP_RETRY_MAX_MS,
    ]);
  });

  it('opens a sign-in page on the screen when taking it over (K8)', async () => {
    const bot = (await (
      await call(dana, 'POST', '/bots', JSON.stringify({ name: 'Signer' }))
    ).json()) as { id: string };
    const control = (body: unknown) =>
      call(dana, 'POST', `/bots/${bot.id}/screen/control`, JSON.stringify(body));

    expect(
      (await control({ action: 'take', url: 'javascript:alert(1)' })).status,
      'only web pages',
    ).toBe(400);

    const taken = await control({ action: 'take', url: 'https://github.com/login' });
    expect(taken.status).toBe(200);
    const { display } = (await taken.json()) as { display: number };
    expect(computer.agent.browser).toContainEqual({
      n: display - 10,
      action: { action: 'navigate', url: 'https://github.com/login' },
    });

    const navigations = computer.agent.browser.length;
    expect((await control({ action: 'release', url: 'https://example.com/' })).status).toBe(200);
    expect(computer.agent.browser, 'a hand back never navigates').toHaveLength(navigations);
  });

  it('restarts the computer, or just starts a stopped one, keeping its volumes', async () => {
    expect((await call(eve, 'POST', '/computer/restart')).status, 'no computer yet').toBe(404);
    const statuses = () =>
      events.filter((e) => e.type === 'computer.status').map((e) => e.payload.status);

    expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
    let seen = statuses().length;
    const restarted = await call(dana, 'POST', '/computer/restart');
    expect(restarted.status).toBe(200);
    expect(await restarted.json()).toMatchObject({ status: 'running' });
    expect(statuses().slice(seen)).toEqual(['stopping', 'stopped', 'starting', 'running']);
    expect(computer.docker.volumes.size).toBe(2);

    await call(dana, 'POST', '/computer/stop');
    seen = statuses().length;
    expect(await (await call(dana, 'POST', '/computer/restart')).json()).toMatchObject({
      status: 'running',
    });
    expect(statuses().slice(seen)).toEqual(['starting', 'running']);
    await call(dana, 'POST', '/computer/stop');
  });

  it('answers 503 without a computer provider', async () => {
    const other = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_SIGNUP_MODE: 'open',
    });
    try {
      setComputerProvider(other.ownerDeps, null);
      const cookie = (await other.signUp('solo@example.com')).cookie!;
      const req = (method: string, path: string) =>
        other.app.request(`/api/v1${path}`, { method, headers: { cookie } });
      expect(await (await req('GET', '/computer')).json()).toEqual({
        available: false,
        computer: null,
      });
      const res = await req('POST', '/computer/start');
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'COMPUTER_UNAVAILABLE' });
      expect(await (await other.app.request('/api/v1/capabilities')).json()).toMatchObject({
        computer: false,
      });
    } finally {
      await other.close();
    }
  });
});

describe('the remote computer (plan 9.2)', () => {
  let t: TestApp;
  let agent: FakeAgent;
  let dana: string;
  let eve: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    agent = await startFakeAgent({ token: 'remote-token' });
    t.deps.config.computerAgent = { url: agent.url, token: 'remote-token', shared: false };
    setComputerProvider(
      t.ownerDeps,
      createRemoteProvider({ url: agent.url, token: 'remote-token' }),
    );
    dana = (await t.signUp('dana@example.com')).cookie!;
    eve = (await t.signUp('eve@example.com')).cookie!;
  });
  afterAll(async () => {
    await agent.close();
    await t.close();
  });

  function call(cookie: string, method: string, path: string, body?: unknown) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function takeNewBot(cookie: string, name: string) {
    const bot = (await (await call(cookie, 'POST', '/bots', { name })).json()) as { id: string };
    const res = await call(cookie, 'POST', `/bots/${bot.id}/screen/control`, { action: 'take' });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { display: number };
  }

  it('keeps one machine for the first account and refuses the others', async () => {
    expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
    expect(await takeNewBot(dana, 'Dana bot')).toMatchObject({ display: 10 });

    const refused = await call(eve, 'POST', '/computer/start');
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      code: 'COMPUTER_UNAVAILABLE',
      title: expect.stringContaining('OPENBOTS_COMPUTER_AGENT_SHARED'),
    });
    const bot = (await (await call(eve, 'POST', '/bots', { name: 'Eve bot' })).json()) as {
      id: string;
    };
    expect(
      (await call(eve, 'POST', `/bots/${bot.id}/screen/control`, { action: 'take' })).status,
    ).toBe(503);
    expect((await call(eve, 'GET', '/computer/files')).status).toBe(409);
    const rows = await t.db.select().from(schema.computers);
    expect(rows).toHaveLength(1);
    // Dana's screen was never handed to anyone else.
    expect(agent.calls.filter((c) => c.path === '/screens' && c.method === 'POST')).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ n: 0, fresh: true }) }),
    ]);
  });

  it('gives each account its own displays once the operator shares the machine', async () => {
    t.deps.config.computerAgent = { url: agent.url, token: 'remote-token', shared: true };
    try {
      expect((await call(eve, 'POST', '/computer/start')).status).toBe(200);
      // Display :10 is Dana's on this machine: Eve's first Bot gets the next one.
      expect(await takeNewBot(eve, 'Eve second bot')).toMatchObject({ display: 11 });
      expect(await takeNewBot(dana, 'Dana second bot')).toMatchObject({ display: 12 });
      const fresh = agent.calls
        .filter((c) => c.path === '/screens' && c.method === 'POST')
        .map((c) => (c.body as { n: number; fresh?: boolean }).n);
      expect(fresh).toEqual([0, 1, 2]);
    } finally {
      t.deps.config.computerAgent = { url: agent.url, token: 'remote-token', shared: false };
    }
  });
});
