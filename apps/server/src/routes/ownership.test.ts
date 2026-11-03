import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextSeq, schema } from '../db/client.js';
import type { FilePurpose } from '../services/files.js';
import { insertRun } from '../services/runs.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { ensureWorkspace } from '../workspace.js';

// Ids in a request body that must be the caller's (S-18 G1 to G3; G4 is in
// ws/computer.test.ts), and the cross-user checks on approval decisions,
// widget actions, group membership and reactions. Another user's resource
// answers 404 and nothing changes.

interface Bot {
  id: string;
  chatId: string;
  avatar: { kind: string; file_id?: string; seed?: string };
  modelConfig: { provider_id: string; model_id: string } | null;
}

describe('ownership', () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  let aliceId: string;
  let bobId: string;
  let workspaceId: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    alice = (await t.signUp('alice@example.com')).cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
    const users = await t.db.select().from(schema.users);
    aliceId = users.find((u) => u.email === 'alice@example.com')!.id;
    bobId = users.find((u) => u.email === 'bob@example.com')!.id;
    workspaceId = (await ensureWorkspace(t.db)).id;
  });
  afterAll(() => t.close());

  const call = (cookie: string, method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const newBot = async (cookie: string, name: string) => {
    const res = await call(cookie, 'POST', '/bots', { name });
    expect(res.status).toBe(201);
    return (await res.json()) as Bot;
  };

  const fileOf = async (
    ownerId: string,
    { mime = 'image/png', purpose = 'avatar' }: { mime?: string; purpose?: FilePurpose } = {},
  ) => {
    const [file] = await t.db
      .insert(schema.files)
      .values({
        workspaceId,
        ownerId,
        name: 'face.png',
        mime,
        size: 3,
        storageKey: `test/${randomUUID()}`,
        sha256: 'x',
        purpose,
      })
      .returning();
    return file!.id;
  };

  const providerOf = async (ownerId: string | null) => {
    const [provider] = await t.db
      .insert(schema.providers)
      .values({
        workspaceId,
        ownerId,
        kind: 'custom',
        protocol: 'openai_compatible',
        name: 'P',
        slug: `p-${randomUUID()}`,
        status: 'untested',
      })
      .returning();
    await t.addModels(provider!.id, ['m']);
    return provider!.id;
  };

  describe('G1: an uploaded avatar is the caller’s file', () => {
    it('refuses another user’s file on create and edit', async () => {
      const bobs = await fileOf(bobId);
      const own = await fileOf(aliceId);
      const avatar = (fileId: string) => ({ kind: 'upload', file_id: fileId });

      const refused = await call(alice, 'POST', '/bots', { name: 'Thief', avatar: avatar(bobs) });
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({ title: 'File not found' });
      expect(
        (await call(alice, 'POST', '/bots', { name: 'Ghost', avatar: avatar(randomUUID()) }))
          .status,
      ).toBe(404);

      const bot = await newBot(alice, 'Portrait');
      expect((await call(alice, 'PATCH', `/bots/${bot.id}`, { avatar: avatar(bobs) })).status).toBe(
        404,
      );
      const [unchanged] = await t.db.select().from(schema.bots).where(eq(schema.bots.id, bot.id));
      expect(unchanged!.avatar).toEqual(bot.avatar);

      const patched = await call(alice, 'PATCH', `/bots/${bot.id}`, { avatar: avatar(own) });
      expect(patched.status).toBe(200);
      expect(((await patched.json()) as Bot).avatar).toEqual(avatar(own));
    });
  });

  describe('an uploaded avatar is a raster image', () => {
    const avatar = (fileId: string) => ({ kind: 'upload', file_id: fileId });

    it('refuses a PDF, an SVG and internal files, and takes any raster type', async () => {
      const bot = await newBot(alice, 'Picky');
      for (const [mime, purpose] of [
        ['application/pdf', 'avatar'],
        ['image/svg+xml', 'avatar'],
        ['text/plain', 'attachment'],
        ['image/png', 'artifact'],
        ['image/png', 'webhook_body'],
      ] as const) {
        const file = await fileOf(aliceId, { mime, purpose });
        const res = await call(alice, 'PATCH', `/bots/${bot.id}`, { avatar: avatar(file) });
        expect(res.status, `${mime} ${purpose}`).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('INVALID_AVATAR');
      }
      const created = await call(alice, 'POST', '/bots', {
        name: 'Paper',
        avatar: avatar(await fileOf(aliceId, { mime: 'application/pdf' })),
      });
      expect(created.status).toBe(400);

      for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
        const file = await fileOf(aliceId, { mime, purpose: 'attachment' });
        const res = await call(alice, 'PATCH', `/bots/${bot.id}`, { avatar: avatar(file) });
        expect(res.status, mime).toBe(200);
      }
    });
  });

  describe('G2: the model’s provider is one the caller may use', () => {
    it('refuses another user’s or an unknown provider, allows shared and own ones', async () => {
      const bobs = await providerOf(bobId);
      const own = await providerOf(aliceId);
      const shared = await providerOf(null);
      const config = (providerId: string) => ({ provider_id: providerId, model_id: 'm' });

      const refused = await call(alice, 'POST', '/bots', {
        name: 'Borrower',
        modelConfig: config(bobs),
      });
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({ title: 'Provider not found' });
      expect(
        (await call(alice, 'POST', '/bots', { name: 'Ghost', modelConfig: config(randomUUID()) }))
          .status,
      ).toBe(404);

      const bot = await newBot(alice, 'Model');
      expect(
        (await call(alice, 'PATCH', `/bots/${bot.id}`, { modelConfig: config(bobs) })).status,
      ).toBe(404);
      for (const id of [own, shared]) {
        const res = await call(alice, 'PATCH', `/bots/${bot.id}`, { modelConfig: config(id) });
        expect(res.status).toBe(200);
        expect(((await res.json()) as Bot).modelConfig).toEqual(config(id));
      }
      // Bob may not name Alice's own provider either.
      expect(
        (await call(bob, 'POST', '/bots', { name: 'Other way', modelConfig: config(own) })).status,
      ).toBe(404);
    });
  });

  describe('G3: an event trigger’s endpoint is one of the Bot’s', () => {
    it('refuses another Bot’s endpoint on create and edit, and drops one from a file', async () => {
      const bobsBot = await newBot(bob, 'Hooked');
      const bobsEndpoint = (await (
        await call(bob, 'POST', `/bots/${bobsBot.id}/endpoints`, { slug: 'deploys' })
      ).json()) as { endpoint: { id: string } };
      const foreign = bobsEndpoint.endpoint.id;

      const bot = await newBot(alice, 'Listener');
      const trigger = (endpointId: string | null) => ({
        type: 'event',
        source: 'webhook',
        endpoint_id: endpointId,
      });
      const refused = await call(alice, 'POST', `/bots/${bot.id}/routines`, {
        name: 'Stolen hook',
        prompt: 'Go.',
        trigger: trigger(foreign),
      });
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({ title: 'Webhook endpoint not found' });

      // Alice's own other Bot's endpoint is not this Bot's either.
      const other = await newBot(alice, 'Sibling');
      const sibling = (await (
        await call(alice, 'POST', `/bots/${other.id}/endpoints`, { slug: 'sib' })
      ).json()) as { endpoint: { id: string } };
      expect(
        (
          await call(alice, 'POST', `/bots/${bot.id}/routines`, {
            name: 'Sibling hook',
            prompt: 'Go.',
            trigger: trigger(sibling.endpoint.id),
          })
        ).status,
      ).toBe(404);

      const created = await call(alice, 'POST', `/bots/${bot.id}/routines`, {
        name: 'Hook',
        prompt: 'Go.',
        trigger: trigger(null),
      });
      expect(created.status).toBe(201);
      const routine = (await created.json()) as { id: string };
      expect(
        (await call(alice, 'PATCH', `/routines/${routine.id}`, { trigger: trigger(foreign) }))
          .status,
      ).toBe(404);
      const own = (await (
        await call(alice, 'POST', `/bots/${bot.id}/endpoints`, { slug: 'own' })
      ).json()) as { endpoint: { id: string } };
      const patched = await call(alice, 'PATCH', `/routines/${routine.id}`, {
        trigger: trigger(own.endpoint.id),
      });
      expect(patched.status).toBe(200);
    });
  });

  /** A Bot message in `bot`'s transcript with the given parts, from a run. */
  const botMessage = async (bot: Bot, parts: unknown[]) => {
    const { db } = t;
    const run = await insertRun(db, { botId: bot.id, chatId: bot.chatId, trigger: 'message' });
    const [message] = await db.transaction(async (tx) =>
      tx
        .insert(schema.messages)
        .values({
          workspaceId,
          chatId: bot.chatId,
          seq: await nextSeq(tx, bot.chatId),
          authorType: 'bot',
          authorId: bot.id,
          parts,
        })
        .returning(),
    );
    return { run, message: message! };
  };

  it('refuses another user’s approval decision', async () => {
    const bot = await newBot(alice, 'Asker');
    const { run, message } = await botMessage(bot, []);
    const [approval] = await t.db
      .insert(schema.approvals)
      .values({ workspaceId, runId: run.id, messageId: message.id, toolName: 'bash', args: {} })
      .returning();
    for (const decision of ['approve', 'deny']) {
      expect(
        (await call(bob, 'POST', `/approvals/${approval!.id}/decide`, { decision })).status,
      ).toBe(404);
    }
    const [after] = await t.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approval!.id));
    expect(after).toMatchObject({ status: 'pending', decidedBy: null });
  });

  it('refuses another user’s widget action', async () => {
    const bot = await newBot(alice, 'Quizzer');
    const { message } = await botMessage(bot, [
      {
        type: 'widget',
        kind: 'question',
        props: { question: 'Which?', options: [{ id: 'a', label: 'A' }] },
      },
    ]);
    const path = `/messages/${message.id}/widgets/0/action`;
    const answer = { action: { type: 'answer', option_id: 'a' } };
    expect((await call(bob, 'POST', path, answer)).status).toBe(404);
    const states = () =>
      t.db.select().from(schema.widgetStates).where(eq(schema.widgetStates.messageId, message.id));
    expect(await states()).toEqual([]);

    expect((await call(alice, 'POST', path, answer)).status).toBe(200);
    expect(await states()).toHaveLength(1);
  });

  it('refuses group membership changes across users', async () => {
    const [a, b, c] = [
      await newBot(alice, 'One'),
      await newBot(alice, 'Two'),
      await newBot(alice, 'Three'),
    ];
    const bobs = await newBot(bob, 'Intruder');
    const group = (await (
      await call(alice, 'POST', '/chats', { botIds: [a!.id, b!.id] })
    ).json()) as { id: string };
    const members = async () =>
      (
        await t.db
          .select({ botId: schema.chatMembers.memberId })
          .from(schema.chatMembers)
          .where(eq(schema.chatMembers.chatId, group.id))
      )
        .map((m) => m.botId)
        .sort();
    const before = await members();

    // Bob cannot touch Alice's group, even with his own Bot.
    expect(
      (await call(bob, 'POST', `/chats/${group.id}/members`, { botIds: [bobs.id] })).status,
    ).toBe(404);
    expect((await call(bob, 'DELETE', `/chats/${group.id}/members/${a!.id}`)).status).toBe(404);
    // Alice cannot pull Bob's Bot into her group, or start one with it.
    expect(
      (await call(alice, 'POST', `/chats/${group.id}/members`, { botIds: [bobs.id] })).status,
    ).toBe(404);
    expect((await call(alice, 'POST', '/chats', { botIds: [c!.id, bobs.id] })).status).toBe(404);
    expect((await call(bob, 'POST', '/chats', { botIds: [bobs.id, a!.id] })).status).toBe(404);
    expect(await members()).toEqual(before);
  });

  it('refuses reactions across users', async () => {
    const bot = await newBot(alice, 'Reacted');
    const { message } = await botMessage(bot, [{ type: 'text', text: 'hi' }]);
    const path = `/messages/${message.id}/reactions`;
    expect((await call(alice, 'POST', path, { emoji: '👍' })).status).toBe(201);
    expect((await call(bob, 'POST', path, { emoji: '👎' })).status).toBe(404);
    expect((await call(bob, 'DELETE', `${path}?emoji=${encodeURIComponent('👍')}`)).status).toBe(
      404,
    );
    const rows = await t.db
      .select({ emoji: schema.reactions.emoji, reactorId: schema.reactions.reactorId })
      .from(schema.reactions)
      .where(eq(schema.reactions.messageId, message.id));
    expect(rows).toEqual([{ emoji: '👍', reactorId: aliceId }]);
  });

  it("keeps one member's devices from another in the same organization", async () => {
    const pairing = (await (await call(alice, 'POST', '/devices/pairings', {})).json()) as {
      qr: { code: string };
    };
    const pairRes = await call(alice, 'POST', '/devices/pair', {
      code: pairing.qr.code,
      name: 'Alice phone',
      platform: 'ios',
      publicKey: randomBytes(32).toString('base64url'),
      pushKey: randomBytes(32).toString('base64url'),
    });
    expect(pairRes.status).toBe(200);
    const paired = (await pairRes.json()) as { device: { id: string }; key: string };
    const id = paired.device.id;

    // Bob sees none of it and can change none of it.
    const listed = (await (await call(bob, 'GET', '/devices')).json()) as { items: unknown[] };
    expect(listed.items).toEqual([]);
    expect((await call(bob, 'DELETE', `/devices/${id}`)).status).toBe(404);
    const push = { token: 'ab'.repeat(32), environment: 'production' };
    expect((await call(bob, 'PUT', `/devices/${id}/push`, push)).status).toBe(404);
    // Bob's own key is not Alice's device's either.
    const bobKey = (await (await call(bob, 'POST', '/api-keys', { name: 'bob' })).json()) as {
      key: string;
    };
    const asBobKey = await t.app.request(`/api/v1/devices/${id}/push`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${bobKey.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(push),
    });
    expect(asBobKey.status).toBe(404);

    const [row] = await t.db.select().from(schema.devices).where(eq(schema.devices.id, id));
    expect(row).toMatchObject({ ownerId: aliceId, revokedAt: null, pushToken: null });
    expect(bobId).not.toBe(aliceId);
  });
});
