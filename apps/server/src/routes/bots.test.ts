import { EVENTS_CHANNEL, type WsEvent } from '@openbots/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextSeq, schema } from '../db/client.js';
import type { Message } from '../schemas.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { ensureWorkspace, updateSettings } from '../workspace.js';

interface Bot {
  id: string;
  handle: string;
  name: string;
  label: string | null;
  description: string;
  avatar: { kind: string; seed?: string; shape?: string };
  modelConfig: { provider_id: string; model_id: string } | null;
  toolPolicy: Record<string, unknown>;
  pinned: boolean;
  hidden: boolean;
  isMain: boolean;
  chatId: string;
  state: { botId: string; state: string; currentAction: string | null; runId: string | null };
}

describe('/api/v1/bots', () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  let aliceId: string;
  let workspaceId: string;
  let providerId: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    alice = (await t.signUp('alice@example.com')).cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
    const users = await t.db.select().from(schema.users);
    aliceId = users.find((u) => u.email === 'alice@example.com')!.id;
    workspaceId = (await ensureWorkspace(t.db)).id;
    providerId = await t.providerId();
    await t.addModels(providerId, ['gpt-x', 'm']);
  });
  afterAll(() => t.close());

  const call = (cookie: string | undefined, method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const create = async (cookie: string, body: Record<string, unknown>) => {
    const res = await call(cookie, 'POST', '/bots', body);
    expect(res.status).toBe(201);
    return (await res.json()) as Bot;
  };

  const audits = (action: string, targetId: string) =>
    t.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.targetId, targetId)));

  it('creates a Bot with its transcript, idle state and a generated handle', async () => {
    const bot = await create(alice, {
      name: 'Ada Lovelace',
      label: 'Analyst',
      description: 'Always cite sources.',
      modelConfig: { provider_id: providerId, model_id: 'gpt-x', max_steps: 20 },
    });
    expect(bot).toMatchObject({
      handle: 'ada-lovelace',
      name: 'Ada Lovelace',
      label: 'Analyst',
      description: 'Always cite sources.',
      modelConfig: { provider_id: providerId, model_id: 'gpt-x', max_steps: 20 },
      toolPolicy: {},
      pinned: false,
      hidden: false,
      // The owner's first Bot is their main Bot (K8).
      isMain: true,
      state: { botId: bot.id, state: 'idle', currentAction: null, runId: null },
    });
    expect(bot.avatar.kind).toBe('generated');
    // A random one of the Bot shapes, Moon, Box or Egg, pinned.
    expect(['bean', 'rounded', 'blob']).toContain(bot.avatar.shape);

    const chats = await t.db.select().from(schema.chats).where(eq(schema.chats.botId, bot.id));
    expect(chats).toMatchObject([{ id: bot.chatId, type: 'bot_dm', ownerId: aliceId }]);
    expect(await audits('bot.create', bot.id)).toHaveLength(1);

    // A second Bot with the same name gets the next free handle, and is not main.
    const second = await create(alice, { name: 'Ada Lovelace' });
    expect(second).toMatchObject({ handle: 'ada-lovelace-2', isMain: false });
  });

  it('creates a Bot from a name and an avatar, and it speaks first', async () => {
    const events: WsEvent[] = [];
    const off = await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
    const avatar = { kind: 'generated', seed: 'picked-in-new' };
    const bot = await create(alice, { name: 'Scout', avatar });
    await off();
    expect(bot).toMatchObject({ name: 'Scout', handle: 'scout', avatar, description: '' });

    // Its transcript opens with its own message, written without a model call.
    const res = await call(alice, 'GET', `/chats/${bot.chatId}/messages`);
    const { messages } = (await res.json()) as { messages: Message[] };
    expect(messages).toEqual([
      expect.objectContaining({
        seq: 1,
        authorType: 'bot',
        authorId: bot.id,
        status: 'complete',
        runId: null,
        parts: [{ type: 'text', text: "Hi, I'm Scout. What would you like me to work on?" }],
      }),
    ]);
    expect(await t.db.select().from(schema.runs).where(eq(schema.runs.botId, bot.id))).toEqual([]);
    // Published like any Bot message, to the chat's and the Bot's subscribers.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'message.created',
        chat_id: bot.chatId,
        bot_id: bot.id,
        payload: { message: expect.objectContaining({ id: messages[0]!.id }) },
      }),
    );
    // Profile and memory start empty: the owner's answer is how it learns its job.
    expect(
      await t.db.select().from(schema.botMemories).where(eq(schema.botMemories.botId, bot.id)),
    ).toEqual([]);
  });

  it('refuses what creating no longer takes', async () => {
    for (const body of [
      { name: 'Guided', routine: { name: 'R', trigger: { type: 'manual' } } },
      { name: 'Guided', connectors: [] },
    ]) {
      expect((await call(alice, 'POST', '/bots', body)).status).toBe(400);
    }
  });

  it('has no template routes', async () => {
    const bot = await create(alice, { name: 'Plain' });
    for (const [method, path, body] of [
      ['POST', `/bots/${bot.id}/template`, {}],
      ['GET', '/templates', undefined],
      ['GET', '/templates/some-token', undefined],
      ['PATCH', '/templates/some-token', { visibility: 'public' }],
      ['DELETE', '/templates/some-token', undefined],
      ['POST', '/bots/from-template', { token: 'some-token' }],
    ] as const) {
      expect((await call(alice, method, path, body)).status, `${method} ${path}`).toBe(404);
    }
  });

  it('validates and enforces unique handles', async () => {
    const bot = await create(alice, { name: 'Grace', handle: '@Grace_H' });
    expect(bot.handle).toBe('grace_h');
    expect((await call(alice, 'POST', '/bots', { name: 'X', handle: 'grace_h' })).status).toBe(409);
    expect((await call(alice, 'POST', '/bots', { name: 'X', handle: 'no spaces' })).status).toBe(
      400,
    );
    expect((await call(alice, 'POST', '/bots', { name: '' })).status).toBe(400);
    expect((await call(alice, 'POST', '/bots', { name: 'X', nope: 1 })).status).toBe(400);

    // Handles are per (organization, owner) (plan 21.1): another member's take
    // nothing from, and say nothing about, Alice's.
    const res = await call(bob, 'POST', '/bots', { name: 'Grace', handle: 'grace_h' });
    expect(res.status).toBe(201);
    const graces = (await res.json()) as Bot;
    expect((await call(bob, 'DELETE', `/bots/${graces.id}`)).status).toBe(204);
  });

  it('edits the profile', async () => {
    const bot = await create(alice, { name: 'Editable' });
    const res = await call(alice, 'PATCH', `/bots/${bot.id}`, {
      name: 'Edited',
      handle: 'edited',
      label: null,
      description: 'Rules',
      avatar: { kind: 'generated', seed: 'abc', eyes: 'round' },
      toolPolicy: { tools: { bash: 'ask' } },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: bot.id,
      name: 'Edited',
      handle: 'edited',
      label: null,
      description: 'Rules',
      avatar: { kind: 'generated', seed: 'abc', eyes: 'round' },
      toolPolicy: { tools: { bash: 'ask' } },
    });
    // Keeping one's own handle is not a conflict; taking another's is.
    expect((await call(alice, 'PATCH', `/bots/${bot.id}`, { handle: 'edited' })).status).toBe(200);
    expect((await call(alice, 'PATCH', `/bots/${bot.id}`, { handle: 'grace_h' })).status).toBe(409);
    expect(
      (await call(alice, 'PATCH', `/bots/${bot.id}`, { avatar: { kind: 'upload' } })).status,
    ).toBe(400);
  });

  it('refuses a model its provider does not list or has turned off (L5)', async () => {
    const config = (model_id: string) => ({ provider_id: providerId, model_id });
    const unknown = await call(alice, 'POST', '/bots', {
      name: 'Unknown model',
      modelConfig: config('nope'),
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({
      code: 'UNKNOWN_MODEL',
      title:
        'This provider has no model nope. Pick one of its models, or add it in Settings > Models.',
    });

    await t.addModels(providerId, ['retired']);
    const keeper = await create(alice, { name: 'Keeper', modelConfig: config('retired') });
    const other = await create(alice, { name: 'Mover', modelConfig: config('m') });
    await t.db
      .update(schema.providerModels)
      .set({ enabled: false })
      .where(eq(schema.providerModels.modelId, 'retired'));

    const moved = await call(alice, 'PATCH', `/bots/${other.id}`, {
      modelConfig: config('retired'),
    });
    expect(moved.status).toBe(400);
    expect(await moved.json()).toMatchObject({ code: 'MODEL_DISABLED' });
    expect(
      (await call(alice, 'PATCH', `/bots/${other.id}`, { modelConfig: config('nope') })).status,
    ).toBe(400);
    // Saving a Bot with the model it already has still works, so the rest of its settings can change.
    const kept = await call(alice, 'PATCH', `/bots/${keeper.id}`, {
      name: 'Keeper renamed',
      modelConfig: { ...config('retired'), max_steps: 10 },
    });
    expect(kept.status).toBe(200);
    // Clearing the model is always allowed.
    expect((await call(alice, 'PATCH', `/bots/${keeper.id}`, { modelConfig: null })).status).toBe(
      200,
    );
  });

  it('isolates Bots by owner', async () => {
    const mine = await create(bob, { name: 'Bob Bot' });
    const list = (await (await call(alice, 'GET', '/bots')).json()) as { items: Bot[] };
    expect(list.items.map((b) => b.id)).not.toContain(mine.id);
    const bobs = (await (await call(bob, 'GET', '/bots')).json()) as { items: Bot[] };
    expect(bobs.items.map((b) => b.id)).toEqual([mine.id]);

    for (const [method, path] of [
      ['GET', `/bots/${mine.id}`],
      ['PATCH', `/bots/${mine.id}`],
      ['DELETE', `/bots/${mine.id}`],
      ['POST', `/bots/${mine.id}/duplicate`],
      ['POST', `/bots/${mine.id}/pin`],
      ['POST', `/bots/${mine.id}/hide`],
      ['GET', `/bots/${mine.id}/state`],
    ] as const) {
      const res = await call(alice, method, path, method === 'PATCH' ? { name: 'x' } : undefined);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await call(undefined, 'GET', '/bots')).status).toBe(401);
    expect((await call(alice, 'GET', '/bots/not-a-uuid')).status).toBe(400);
    expect((await call(bob, 'GET', `/bots/${mine.id}`)).status).toBe(200);
  });

  it('pins, unpins, hides and unhides', async () => {
    const bot = await create(alice, { name: 'Pinnable' });
    const pinned = (await (await call(alice, 'POST', `/bots/${bot.id}/pin`)).json()) as Bot;
    expect(pinned.pinned).toBe(true);
    const list = (await (await call(alice, 'GET', '/bots')).json()) as { items: Bot[] };
    expect(list.items[0]!.id).toBe(bot.id);

    expect(
      ((await (await call(alice, 'POST', `/bots/${bot.id}/unpin`)).json()) as Bot).pinned,
    ).toBe(false);
    const hidden = (await (await call(alice, 'POST', `/bots/${bot.id}/hide`)).json()) as Bot;
    expect(hidden.hidden).toBe(true);
    // Hidden Bots stay in the list, flagged, so they can be shown again.
    const again = (await (await call(alice, 'GET', '/bots')).json()) as { items: Bot[] };
    expect(again.items.find((b) => b.id === bot.id)!.hidden).toBe(true);
    expect(
      ((await (await call(alice, 'POST', `/bots/${bot.id}/unhide`)).json()) as Bot).hidden,
    ).toBe(false);
  });

  it('keeps one main Bot per owner, and copies never take it over (K8)', async () => {
    const first = await create(alice, { name: 'Main one' });
    const second = await create(alice, { name: 'Main two' });
    const bobs = await create(bob, { name: 'Bob main' });
    const patch = async (cookie: string, id: string, isMain: boolean) => {
      const res = await call(cookie, 'PATCH', `/bots/${id}`, { isMain });
      expect(res.status).toBe(200);
      return (await res.json()) as Bot;
    };
    const mains = async (cookie: string) =>
      ((await (await call(cookie, 'GET', '/bots')).json()) as { items: Bot[] }).items
        .filter((b) => b.isMain)
        .map((b) => b.id);

    expect((await patch(alice, first.id, true)).isMain).toBe(true);
    expect((await patch(bob, bobs.id, true)).isMain, 'each owner has their own').toBe(true);
    expect(await mains(alice)).toEqual([first.id]);

    // Marking another moves it.
    await patch(alice, second.id, true);
    expect(await mains(alice)).toEqual([second.id]);
    expect(await mains(bob)).toEqual([bobs.id]);
    // Marking it again is a no-op.
    await patch(alice, second.id, true);
    expect(await mains(alice)).toEqual([second.id]);

    // The database refuses a second one, whatever the caller.
    await expect(
      t.db.update(schema.bots).set({ isMain: true }).where(eq(schema.bots.id, first.id)),
    ).rejects.toThrow();

    // Two at once still leave one.
    await Promise.all([patch(alice, first.id, true), patch(alice, second.id, true)]);
    expect(await mains(alice)).toHaveLength(1);
    await patch(alice, second.id, true);

    const copy = (await (await call(alice, 'POST', `/bots/${second.id}/duplicate`)).json()) as Bot;
    expect(copy.isMain).toBe(false);
    expect(await mains(alice)).toEqual([second.id]);

    expect((await patch(alice, second.id, false)).isMain).toBe(false);
    expect(await mains(alice)).toEqual([]);
    expect(
      (await call(bob, 'PATCH', `/bots/${second.id}`, { isMain: true })).status,
      "another owner's Bot",
    ).toBe(404);
  });

  it('returns the state', async () => {
    const bot = await create(alice, { name: 'Stateful' });
    const res = await call(alice, 'GET', `/bots/${bot.id}/state`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      botId: bot.id,
      state: 'idle',
      currentAction: null,
      runId: null,
    });
  });

  it('duplicates profile, settings, enabled Skills and Routines, not history or memory', async () => {
    const { db } = t;
    const source = await create(alice, {
      name: 'Original',
      label: 'Lead',
      description: 'Be brief.',
      avatar: { kind: 'generated', seed: 'orig', accessory: 'hat' },
      modelConfig: { provider_id: providerId, model_id: 'm' },
      toolPolicy: { tools: { send_email: 'ask' } },
    });
    await call(alice, 'POST', `/bots/${source.id}/pin`);

    const [on, off] = await db
      .insert(schema.skills)
      .values([
        { workspaceId, ownerId: aliceId, name: 'On', slug: 'on' },
        { workspaceId, ownerId: aliceId, name: 'Off', slug: 'off' },
      ])
      .returning();
    await db
      .insert(schema.botSkillBlocks)
      .values({ workspaceId, botId: source.id, skillId: off!.id });
    await db.insert(schema.routines).values([
      {
        workspaceId,
        botId: source.id,
        name: 'Daily',
        slug: 'daily',
        trigger: { type: 'schedule', cron: '0 9 * * *' },
        promptMd: 'Report',
        chatId: source.chatId,
      },
    ]);
    await db.transaction(async (tx) => {
      await tx.insert(schema.messages).values({
        workspaceId,
        chatId: source.chatId,
        seq: await nextSeq(tx, source.chatId),
        authorType: 'user',
        authorId: aliceId,
        parts: [{ type: 'text', text: 'hello' }],
      });
    });
    await db
      .insert(schema.botMemories)
      .values({ workspaceId, botId: source.id, kind: 'fact', content: 'Likes tea' });

    const res = await call(alice, 'POST', `/bots/${source.id}/duplicate`);
    expect(res.status).toBe(201);
    const copy = (await res.json()) as Bot;
    expect(copy.id).not.toBe(source.id);
    expect(copy.chatId).not.toBe(source.chatId);
    expect(copy).toMatchObject({
      handle: 'original-copy',
      name: 'Original copy',
      label: 'Lead',
      description: 'Be brief.',
      avatar: { kind: 'generated', seed: 'orig', accessory: 'hat' },
      modelConfig: { provider_id: providerId, model_id: 'm' },
      toolPolicy: { tools: { send_email: 'ask' } },
      pinned: false,
      hidden: false,
      state: { state: 'idle' },
    });

    // The copy has the same Skills turned off: 'Off' only.
    const blocks = await db
      .select()
      .from(schema.botSkillBlocks)
      .where(eq(schema.botSkillBlocks.botId, copy.id));
    expect(blocks.map((b) => b.skillId)).toEqual([off!.id]);
    expect(on).toBeTruthy();
    const routines = await db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.botId, copy.id));
    expect(routines).toMatchObject([{ name: 'Daily', slug: 'daily', chatId: copy.chatId }]);
    const messages = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.chatId, copy.chatId));
    // None of the history: only its own greeting, like any new Bot.
    expect(messages).toMatchObject([
      { authorType: 'bot', authorId: copy.id, parts: [{ type: 'text', text: expect.any(String) }] },
    ]);
    const memories = await db
      .select()
      .from(schema.botMemories)
      .where(eq(schema.botMemories.botId, copy.id));
    expect(memories).toEqual([]);
    expect(await audits('bot.duplicate', copy.id)).toMatchObject([
      { metadata: { sourceBotId: source.id } },
    ]);

    // Duplicating again picks the next free handle.
    const second = (await (
      await call(alice, 'POST', `/bots/${source.id}/duplicate`)
    ).json()) as Bot;
    expect(second.handle).toBe('original-copy-2');
  });

  it('deletes a Bot with its transcript, messages, Routines, memories and state', async () => {
    const { db } = t;
    const bot = await create(alice, { name: 'Doomed' });
    await db.transaction(async (tx) => {
      await tx.insert(schema.messages).values({
        workspaceId,
        chatId: bot.chatId,
        seq: await nextSeq(tx, bot.chatId),
        authorType: 'user',
        authorId: aliceId,
        parts: [],
      });
    });
    await db.insert(schema.routines).values({
      workspaceId,
      botId: bot.id,
      name: 'R',
      slug: 'r',
      trigger: { type: 'schedule', cron: '* * * * *' },
    });
    await db
      .insert(schema.botMemories)
      .values({ workspaceId, botId: bot.id, kind: 'fact', content: 'x' });
    const [group] = await db
      .insert(schema.chats)
      .values({ workspaceId, ownerId: aliceId, type: 'group' })
      .returning();
    await db
      .insert(schema.chatMembers)
      .values({ workspaceId, chatId: group!.id, memberType: 'bot', memberId: bot.id });

    expect((await call(alice, 'DELETE', `/bots/${bot.id}`)).status).toBe(204);
    expect((await call(alice, 'GET', `/bots/${bot.id}`)).status).toBe(404);
    expect((await call(alice, 'DELETE', `/bots/${bot.id}`)).status).toBe(404);

    const count = async (rows: Promise<unknown[]>) => (await rows).length;
    expect(await count(db.select().from(schema.chats).where(eq(schema.chats.id, bot.chatId)))).toBe(
      0,
    );
    expect(
      await count(db.select().from(schema.messages).where(eq(schema.messages.chatId, bot.chatId))),
    ).toBe(0);
    expect(
      await count(db.select().from(schema.routines).where(eq(schema.routines.botId, bot.id))),
    ).toBe(0);
    expect(
      await count(db.select().from(schema.botMemories).where(eq(schema.botMemories.botId, bot.id))),
    ).toBe(0);
    expect(
      await count(db.select().from(schema.botState).where(eq(schema.botState.botId, bot.id))),
    ).toBe(0);
    expect(
      await count(
        db.select().from(schema.chatMembers).where(eq(schema.chatMembers.memberId, bot.id)),
      ),
    ).toBe(0);
    expect(await audits('bot.delete', bot.id)).toMatchObject([{ metadata: { name: 'Doomed' } }]);
  });

  it("sums a Bot's usage over recent days, by day and by model (plan 5.8)", async () => {
    const bot = await create(alice, { name: 'Counter' });
    const day = 24 * 60 * 60 * 1000;
    const usage = (inputTokens: number, steps: number, costUsd: number | null) => ({
      inputTokens,
      outputTokens: inputTokens / 10,
      cachedInputTokens: 0,
      steps,
      costUsd,
    });
    const run = (model: string, value: unknown, ago = 0) => ({
      workspaceId,
      botId: bot.id,
      chatId: bot.chatId,
      trigger: 'message' as const,
      status: 'completed' as const,
      model,
      usage: value,
      createdAt: new Date(Date.now() - ago * day),
    });
    await t.db.insert(schema.runs).values([
      run('gpt-x', usage(1000, 2, 0.01)),
      run('gpt-x', usage(500, 1, 0.005)),
      run('m', usage(300, 1, null), 3),
      run('gpt-x', usage(9000, 1, 1), 40),
      // Neither called a model: one paused before its first step, one has no usage.
      run('gpt-x', usage(0, 0, 0)),
      run('gpt-x', null),
    ]);

    const res = await call(alice, 'GET', `/bots/${bot.id}/usage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: number;
      totals: Record<string, number | null>;
      daily: { date: string; runs: number }[];
      models: { model: string; runs: number; costUsd: number | null }[];
    };
    expect(body.days).toBe(30);
    expect(body.totals).toMatchObject({
      runs: 3,
      inputTokens: 1800,
      outputTokens: 180,
      steps: 4,
      unpricedRuns: 1,
    });
    expect(body.totals.costUsd).toBeCloseTo(0.015);
    expect(body.daily.map((d) => d.runs)).toEqual([1, 2]);
    expect(body.daily.at(-1)!.date).toBe(new Date().toISOString().slice(0, 10));
    expect(body.models).toMatchObject([
      { model: 'gpt-x', runs: 2 },
      { model: 'm', runs: 1, costUsd: null },
    ]);

    const longer = (await (await call(alice, 'GET', `/bots/${bot.id}/usage?days=60`)).json()) as {
      totals: { runs: number; costUsd: number };
    };
    expect(longer.totals.runs).toBe(4);
    expect(longer.totals.costUsd).toBeCloseTo(1.015);
    expect((await call(alice, 'GET', `/bots/${bot.id}/usage?days=0`)).status).toBe(400);
    expect((await call(bob, 'GET', `/bots/${bot.id}/usage`)).status).toBe(404);
  });
});

describe("a member's first Bot is their main Bot (K8)", () => {
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
  });
  afterAll(() => t.close());

  /** A new member, with helpers that call the API as them. */
  async function member() {
    const cookie = (await t.signUp(`member${++n}@example.com`)).cookie!;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await t.app.request(`/api/v1${path}`, {
        method,
        headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(res.status, `${method} ${path}`).toBeLessThan(300);
      return res.status === 204 ? null : ((await res.json()) as Bot);
    };
    const create = async (name: string) => (await call('POST', '/bots', { name }))!;
    const mains = async () =>
      ((await call('GET', '/bots')) as unknown as { items: Bot[] }).items
        .filter((b) => b.isMain)
        .map((b) => b.id);
    return { call, create, mains };
  }

  it('makes the first Bot main and the second not', async () => {
    const me = await member();
    const first = await me.create('First');
    const second = await me.create('Second');
    expect(first.isMain).toBe(true);
    expect(second.isMain).toBe(false);
    expect(await me.mains()).toEqual([first.id]);
  });

  it('makes the next Bot main once the main Bot is deleted or unmarked', async () => {
    const me = await member();
    const first = await me.create('First');
    const kept = await me.create('Kept');
    await me.call('DELETE', `/bots/${first.id}`);
    // Deleting it does not pass the mark on.
    expect(await me.mains()).toEqual([]);
    const next = await me.create('Next');
    expect(next.isMain).toBe(true);
    expect(await me.mains()).toEqual([next.id]);

    await me.call('PATCH', `/bots/${next.id}`, { isMain: false });
    const after = await me.create('After');
    expect(after.isMain).toBe(true);
    expect(await me.mains()).toEqual([after.id]);
    expect((await me.call('GET', `/bots/${kept.id}`))!.isMain).toBe(false);
  });

  it('counts a duplicate only when the member has no main Bot', async () => {
    const me = await member();
    const main = await me.create('Main');
    const other = await me.create('Other');
    const copy = (await me.call('POST', `/bots/${main.id}/duplicate`))!;
    expect(copy.isMain, 'the mark is not copied').toBe(false);
    expect(await me.mains()).toEqual([main.id]);

    await me.call('DELETE', `/bots/${main.id}`);
    const second = (await me.call('POST', `/bots/${other.id}/duplicate`))!;
    expect(second.isMain).toBe(true);
    expect(await me.mains()).toEqual([second.id]);
  });

  it('leaves one main Bot when several are made at once', async () => {
    const me = await member();
    const made = await Promise.all(['A', 'B', 'C'].map((name) => me.create(name)));
    expect(made.filter((b) => b.isMain)).toHaveLength(1);
    expect(await me.mains()).toHaveLength(1);
  });
});

describe('Bot limit (B8)', () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_LIMITS_BOTS_PER_ACCOUNT: '2' });
    cookie = (await t.signUp('admin@example.com')).cookie!;
  });
  afterAll(() => t.close());

  const post = (path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('refuses the Bot past the limit, for creation and duplication', async () => {
    const first = (await (await post('/bots', { name: 'One' })).json()) as Bot;
    expect((await post('/bots', { name: 'Two' })).status).toBe(201);

    const res = await post('/bots', { name: 'Three' });
    expect(res.status).toBe(409);
    const problem = (await res.json()) as { code: string; title: string };
    expect(problem.code).toBe('BOT_LIMIT_REACHED');
    expect(problem.title).toContain('limit of 2 Bots');
    expect((await post(`/bots/${first.id}/duplicate`)).status).toBe(409);
  });

  it('follows the workspace override', async () => {
    const workspace = await ensureWorkspace(t.db);
    await updateSettings(t.db, workspace, { limits: { botsPerAccount: 3 } });
    expect((await post('/bots', { name: 'Three' })).status).toBe(201);
    expect((await post('/bots', { name: 'Four' })).status).toBe(409);
  });
});
