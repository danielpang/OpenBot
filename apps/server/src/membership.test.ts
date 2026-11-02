import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from './db/client.js';
import { ownerActive } from './membership.js';
import { tickDueRoutines } from './services/routines.js';
import { ORIGIN, createTestApp, type TestApp } from './test-app.js';

// A member suspended or removed in an organization (plan 21.6): their Bots
// there take no webhook deliveries and run no Routines until restored,
// while the rows stay.

describe("a suspended or removed member's Bots", () => {
  let t: TestApp;
  let cookie: string;
  let userId: string;
  let bot: { id: string; chatId: string; workspaceId: string };
  let token: string;
  let inboxId: string;

  const call = (method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const membership = () =>
    and(
      eq(schema.workspaceMembers.userId, userId),
      eq(schema.workspaceMembers.workspaceId, bot.workspaceId),
    );
  const suspend = (on: boolean) =>
    t.db
      .update(schema.workspaceMembers)
      .set({ suspendedAt: on ? new Date() : null })
      .where(membership());
  let sent = 0;
  // Each delivery its own body: a repeat within 10 minutes is answered once.
  const hook = () =>
    t.app.request(`/hooks/${bot.id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ hello: ++sent }),
    });

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    await t.signUp('owner@example.com');
    cookie = (await t.signUp('max@example.com')).cookie!;
    userId = await t.userId('max@example.com');
    const created = (await (await call('POST', '/bots', { name: 'Max Bot' })).json()) as {
      id: string;
      chatId: string;
    };
    bot = { ...created, workspaceId: await t.defaultOrganization() };
    const endpoints = (await (await call('GET', `/bots/${bot.id}/endpoints`)).json()) as {
      items: { id: string }[];
    };
    inboxId = endpoints.items[0]!.id;
    token = (
      (await (await call('POST', `/endpoints/${inboxId}/rotate`)).json()) as { token: string }
    ).token;
  });
  afterAll(() => t.close());

  it('takes no webhook deliveries while the owner is suspended', async () => {
    expect((await hook()).status).toBe(202);
    await suspend(true);
    try {
      expect(await ownerActive(t.db, { ownerId: userId, workspaceId: bot.workspaceId })).toBe(
        false,
      );
      expect((await hook()).status).toBe(404);
    } finally {
      await suspend(false);
    }
    expect((await hook()).status).toBe(202);
  });

  it('runs no Routines while the owner is suspended, and starts again once restored', async () => {
    const routine = (await (
      await call('POST', `/bots/${bot.id}/routines`, {
        name: 'Every minute',
        prompt: 'Report',
        trigger: { type: 'schedule', preset: { kind: 'every_minutes', minutes: 1 } },
      })
    ).json()) as { id: string };
    const due = () =>
      t.db
        .update(schema.routines)
        .set({ nextRunAt: new Date(Date.now() - 1000) })
        .where(eq(schema.routines.id, routine.id));
    await suspend(true);
    await due();
    expect(await tickDueRoutines(t.deps)).toBe(0);
    await suspend(false);
    await due();
    expect(await tickDueRoutines(t.deps)).toBe(1);
  });

  it('takes nothing once the owner is removed; the Bot stays', async () => {
    await t.db.delete(schema.workspaceMembers).where(membership());
    expect((await hook()).status).toBe(404);
    const [row] = await t.db.select().from(schema.bots).where(eq(schema.bots.id, bot.id));
    expect(row).toBeDefined();
  });
});
