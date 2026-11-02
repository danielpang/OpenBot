import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { createTestApp, type TestApp } from '../test-app.js';

describe('Bot memories API', () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  let bot: { id: string };

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    alice = (await t.signUp('alice@example.com')).cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
    bot = (await (await call(alice, 'POST', '/bots', { name: 'Mem' })).json()) as typeof bot;
  });
  afterAll(() => t.close());

  function call(cookie: string, method: string, path: string, body?: unknown) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it('creates, lists, edits and deletes memories', async () => {
    const created = await call(alice, 'POST', `/bots/${bot.id}/memories`, {
      kind: 'fact',
      content: '  Deploys happen on Thursdays ',
    });
    expect(created.status).toBe(201);
    const memory = (await created.json()) as { id: string };
    expect(memory).toMatchObject({
      botId: bot.id,
      kind: 'fact',
      content: 'Deploys happen on Thursdays',
      sourceRunId: null,
    });
    const [row] = await t.db
      .select()
      .from(schema.botMemories)
      .where(eq(schema.botMemories.id, memory.id));
    expect(row!.embedding).toHaveLength(1536);
    // No OpenAI provider: the local embedding, and the row says so (M1).
    expect(row!.embeddingModel).toBe('local');

    const edited = await call(alice, 'PATCH', `/bots/${bot.id}/memories/${memory.id}`, {
      kind: 'preference',
      content: 'Deploys on Fridays',
    });
    expect(await edited.json()).toMatchObject({
      kind: 'preference',
      content: 'Deploys on Fridays',
    });
    const [after] = await t.db
      .select()
      .from(schema.botMemories)
      .where(eq(schema.botMemories.id, memory.id));
    expect(after!.embedding).not.toEqual(row!.embedding);

    const list = await call(alice, 'GET', `/bots/${bot.id}/memories`);
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
    expect((await call(alice, 'DELETE', `/bots/${bot.id}/memories/${memory.id}`)).status).toBe(204);
    expect((await call(alice, 'DELETE', `/bots/${bot.id}/memories/${memory.id}`)).status).toBe(404);
  });

  it("validates input and hides other users' Bots", async () => {
    expect(
      (await call(alice, 'POST', `/bots/${bot.id}/memories`, { kind: 'mood', content: 'x' }))
        .status,
    ).toBe(400);
    expect(
      (await call(alice, 'POST', `/bots/${bot.id}/memories`, { kind: 'fact', content: '  ' }))
        .status,
    ).toBe(400);
    expect((await call(bob, 'GET', `/bots/${bot.id}/memories`)).status).toBe(404);
    expect(
      (await call(bob, 'POST', `/bots/${bot.id}/memories`, { kind: 'fact', content: 'x' })).status,
    ).toBe(404);
  });
});
