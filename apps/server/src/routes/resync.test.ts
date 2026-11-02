import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextSeq, schema } from '../db/client.js';
import { appendPart, createStreaming, finalize, postMessage } from '../services/messages.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { ensureWorkspace } from '../workspace.js';

describe('GET /api/v1/chats/:id/resync', () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  let chatId: string;
  let botId: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    alice = (await t.signUp('alice@example.com')).cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
    const { db } = t;
    const workspace = await ensureWorkspace(db);
    const aliceId = (await db.select().from(schema.users)).find(
      (u) => u.email === 'alice@example.com',
    )!.id;
    const [bot] = await db
      .insert(schema.bots)
      .values({ workspaceId: workspace.id, ownerId: aliceId, handle: 'a', name: 'A' })
      .returning();
    const [chat] = await db
      .insert(schema.chats)
      .values({ workspaceId: workspace.id, ownerId: aliceId, type: 'bot_dm', botId: bot!.id })
      .returning();
    chatId = chat!.id;
    botId = bot!.id;
    for (const text of ['one', 'two', 'three']) {
      await db.transaction(async (tx) => {
        await tx.insert(schema.messages).values({
          workspaceId: workspace.id,
          chatId,
          seq: await nextSeq(tx, chatId),
          authorType: 'user',
          authorId: aliceId,
          parts: [{ type: 'text', text }],
        });
      });
    }
  });
  afterAll(() => t.close());

  const resync = (cookie: string | undefined, query: string) =>
    t.app.request(`/api/v1/chats/${chatId}/resync${query}`, {
      headers: cookie ? { cookie } : {},
    });

  it('returns only messages newer than `since`, oldest first', async () => {
    const res = await resync(alice, '?since=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: { seq: number; chatId: string; parts: { text: string }[] }[];
      hasMore: boolean;
    };
    expect(body.hasMore).toBe(false);
    expect(body.messages.map((m) => m.seq)).toEqual([2, 3]);
    expect(body.messages.map((m) => m.parts[0]!.text)).toEqual(['two', 'three']);
    expect(body.messages[0]).toMatchObject({ chatId, authorType: 'user', status: 'complete' });
  });

  it('returns everything without `since` and nothing past the end', async () => {
    const all = (await (await resync(alice, '')).json()) as { messages: unknown[] };
    expect(all.messages).toHaveLength(3);
    const none = (await (await resync(alice, '?since=3')).json()) as { messages: unknown[] };
    expect(none.messages).toEqual([]);
  });

  it('carries reactions and reply counts', async () => {
    const { db } = t;
    const [first] = await db.select().from(schema.messages).where(eq(schema.messages.seq, 1));
    const [reply] = await db.transaction(async (tx) =>
      tx
        .insert(schema.messages)
        .values({
          workspaceId: first!.workspaceId,
          chatId,
          seq: await nextSeq(tx, chatId),
          threadRootId: first!.id,
          authorType: 'bot',
          parts: [{ type: 'text', text: 'reply' }],
        })
        .returning(),
    );
    await db.insert(schema.reactions).values({
      workspaceId: first!.workspaceId,
      messageId: first!.id,
      reactorType: 'user',
      reactorId: first!.authorId!,
      emoji: '👍',
    });
    const body = (await (await resync(alice, '')).json()) as {
      messages: { seq: number; reactions: unknown[]; replyCount?: number }[];
    };
    body.messages.sort((a, b) => a.seq - b.seq);
    expect(body.messages.map((m) => [m.seq, m.replyCount, m.reactions.length])).toEqual([
      [1, 1, 1],
      [2, 0, 0],
      [3, 0, 0],
      [reply!.seq, undefined, 0],
    ]);
    expect(body.messages[0]).toMatchObject({
      lastReplySeq: reply!.seq,
      reactions: [{ emoji: '👍', reactorType: 'user', reactorId: first!.authorId }],
    });
    await db.delete(schema.reactions);
    await db.delete(schema.messages).where(eq(schema.messages.id, reply!.id));
  });

  describe('after a reconnect (plan 14.2)', () => {
    interface Read {
      id: string;
      seq: number;
      updatedSeq: number;
      status: string;
      parts: { type: string; text?: string; state?: unknown }[];
      reactions: { emoji: string }[];
    }
    const chatSeq = async () =>
      (
        await t.db
          .select({ seq: schema.chats.chatSeq })
          .from(schema.chats)
          .where(eq(schema.chats.id, chatId))
      )[0]!.seq;
    /** What a client that has heard up to `since` gets back. */
    const caughtUp = async (since: number) =>
      ((await (await resync(alice, `?since=${since}`)).json()) as { messages: Read[] }).messages;
    const call = (method: string, path: string, body?: unknown) =>
      t.app.request(`/api/v1${path}`, {
        method,
        headers: { cookie: alice, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });

    it('returns a message that completed while the client was away', async () => {
      const streaming = await createStreaming(t.ownerDeps, { chatId, botId });
      await appendPart(t.ownerDeps, streaming.id, { type: 'text_delta', text: 'Hel' });
      // The client saw the message start streaming, then lost the socket.
      const since = await chatSeq();
      expect(await caughtUp(since)).toEqual([]);
      await appendPart(t.ownerDeps, streaming.id, { type: 'text_delta', text: 'lo.' });
      await finalize(t.ownerDeps, streaming.id);
      const [back] = await caughtUp(since);
      expect(back).toMatchObject({
        id: streaming.id,
        seq: streaming.seq,
        status: 'complete',
        parts: [{ type: 'text', text: 'Hello.' }],
      });
      expect(back!.updatedSeq).toBeGreaterThan(since);
    });

    it('returns a message whose widget changed while the client was away', async () => {
      const asking = await postMessage(t.ownerDeps, chatId, {
        authorType: 'bot',
        authorId: botId,
        parts: [
          {
            type: 'widget',
            kind: 'question',
            props: { question: 'Which repo?', options: [{ id: 'a', label: 'openbots' }] },
            state: { status: 'pending' },
          },
        ],
      });
      const since = await chatSeq();
      const res = await call('POST', `/messages/${asking.id}/widgets/0/action`, {
        action: { type: 'answer', option_id: 'a' },
      });
      expect(res.status).toBe(200);
      const back = (await caughtUp(since)).find((m) => m.id === asking.id);
      expect(back?.parts[0]?.state).toMatchObject({ status: 'answered' });
    });

    it('returns a message whose reactions changed while the client was away', async () => {
      const said = await postMessage(t.ownerDeps, chatId, {
        authorType: 'bot',
        authorId: botId,
        parts: [{ type: 'text', text: 'Done.' }],
      });
      let since = await chatSeq();
      expect((await call('POST', `/messages/${said.id}/reactions`, { emoji: '👍' })).status).toBe(
        201,
      );
      expect((await caughtUp(since)).map((m) => [m.id, m.reactions.length])).toEqual([
        [said.id, 1],
      ]);
      since = await chatSeq();
      const removed = await call(
        'DELETE',
        `/messages/${said.id}/reactions?emoji=${encodeURIComponent('👍')}`,
      );
      expect(removed.status).toBe(204);
      expect((await caughtUp(since)).map((m) => [m.id, m.reactions.length])).toEqual([
        [said.id, 0],
      ]);
    });

    it('pages in the order messages changed, from the last `updatedSeq`', async () => {
      const all = await caughtUp(0);
      const order = all.map((m) => m.updatedSeq);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(new Set(order).size).toBe(order.length);
      const tail = await caughtUp(all.at(-2)!.updatedSeq);
      expect(tail.map((m) => m.id)).toEqual([all.at(-1)!.id]);
    });
  });

  it("hides another user's chat and requires a caller", async () => {
    expect((await resync(bob, '?since=0')).status).toBe(404);
    expect((await resync(undefined, '?since=0')).status).toBe(401);
  });

  it('rejects a bad `since`', async () => {
    expect((await resync(alice, '?since=-1')).status).toBe(400);
  });
});
