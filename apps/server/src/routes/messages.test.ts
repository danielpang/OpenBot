import { EVENTS_CHANNEL, type WsEvent } from '@openbots/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import type { Message } from '../schemas.js';
import { setState } from '../services/bot-state.js';
import { onUserMessage } from '../services/hooks.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { ensureWorkspace } from '../workspace.js';

interface Chat {
  id: string;
  type: string;
  botId: string | null;
  lastSeq: number;
}

describe('chats and messages', () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  let aliceId: string;
  let ada: { id: string; chatId: string };
  let grace: { id: string };
  const events: WsEvent[] = [];

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    alice = (await t.signUp('alice@example.com')).cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
    aliceId = (await t.db.select().from(schema.users)).find(
      (u) => u.email === 'alice@example.com',
    )!.id;
    ada = (await (await call(alice, 'POST', '/bots', { name: 'Ada' })).json()) as typeof ada;
    grace = (await (await call(alice, 'POST', '/bots', { name: 'Grace' })).json()) as typeof grace;
    await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
  });
  afterAll(() => t.close());

  function call(cookie: string | undefined, method: string, path: string, body?: unknown) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const post = async (chatId: string, body: Record<string, unknown>) => {
    const res = await call(alice, 'POST', `/chats/${chatId}/messages`, body);
    expect(res.status).toBe(201);
    return (await res.json()) as Message;
  };

  const page = async (chatId: string, query = '') => {
    const res = await call(alice, 'GET', `/chats/${chatId}/messages${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as { messages: Message[]; hasMore: boolean };
  };

  const flushEvents = () => new Promise((resolve) => setTimeout(resolve, 0));

  describe('GET /bots/:id/chat', () => {
    it("returns the Bot's transcript and hides other users' Bots", async () => {
      const res = await call(alice, 'GET', `/bots/${ada.id}/chat`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: ada.chatId, type: 'bot_dm', botId: ada.id });
      expect((await call(bob, 'GET', `/bots/${ada.id}/chat`)).status).toBe(404);
      expect((await call(undefined, 'GET', `/bots/${ada.id}/chat`)).status).toBe(401);
    });

    it('creates the transcript when it is missing', async () => {
      const { db } = t;
      const workspace = await ensureWorkspace(db);
      const [bot] = await db
        .insert(schema.bots)
        .values({ workspaceId: workspace.id, ownerId: aliceId, handle: 'orphan', name: 'Orphan' })
        .returning();
      await db.insert(schema.botState).values({ workspaceId: workspace.id, botId: bot!.id });
      const first = (await (await call(alice, 'GET', `/bots/${bot!.id}/chat`)).json()) as Chat;
      const again = (await (await call(alice, 'GET', `/bots/${bot!.id}/chat`)).json()) as Chat;
      expect(first).toMatchObject({ type: 'bot_dm', botId: bot!.id, lastSeq: 0 });
      expect(again.id).toBe(first.id);
    });

    it('clears a blocked Bot back to idle', async () => {
      await setState(t.ownerDeps, ada.id, 'blocked');
      await call(alice, 'GET', `/bots/${ada.id}/chat`);
      const state = (await (await call(alice, 'GET', `/bots/${ada.id}/state`)).json()) as {
        state: string;
      };
      expect(state.state).toBe('idle');
    });
  });

  it('GET /chats lists no groups yet', async () => {
    const res = await call(alice, 'GET', '/chats');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  describe('POST /chats/:id/messages', () => {
    it('stores a text message, publishes message.created and calls the hook', async () => {
      const seen: Message[] = [];
      const off = onUserMessage((_deps, message) => {
        seen.push(message);
      });
      events.length = 0;
      const message = await post(ada.chatId, { text: 'hello' });
      off();
      expect(message).toMatchObject({
        chatId: ada.chatId,
        authorType: 'user',
        authorId: aliceId,
        parts: [{ type: 'text', text: 'hello' }],
        status: 'complete',
        mentions: [],
        mentionEveryone: false,
        deltaSeq: 0,
      });
      expect(seen).toEqual([message]);
      await flushEvents();
      expect(events).toEqual([
        expect.objectContaining({
          type: 'message.created',
          chat_id: ada.chatId,
          seq: message.seq,
          payload: { message },
        }),
      ]);
    });

    it('keeps the message when a hook fails', async () => {
      const off = onUserMessage(() => {
        throw new Error('runtime down');
      });
      const message = await post(ada.chatId, { text: 'still here' });
      off();
      expect((await page(ada.chatId)).messages[0]!.id).toBe(message.id);
    });

    it('resolves @handle mentions to the owner’s Bots and @everyone to the flag', async () => {
      const message = await post(ada.chatId, { text: '@ada ask @grace and @nobody' });
      expect(new Set(message.mentions)).toEqual(new Set([ada.id, grace.id]));
      expect(message.mentionEveryone).toBe(false);
      const everyone = await post(ada.chatId, { text: 'hey @everyone' });
      expect(everyone).toMatchObject({ mentions: [], mentionEveryone: true });
      const flagged = await post(ada.chatId, { text: 'no mention', mentionEveryone: true });
      expect(flagged.mentionEveryone).toBe(true);
    });

    it("does not resolve another user's Bot handles", async () => {
      const bobBot = (await (await call(bob, 'POST', '/bots', { name: 'Zed' })).json()) as {
        id: string;
      };
      const message = await post(ada.chatId, { text: 'hi @zed' });
      expect(message.mentions).not.toContain(bobBot.id);
    });

    it('rejects empty messages, unknown attachments and other users’ chats', async () => {
      const empty = await call(alice, 'POST', `/chats/${ada.chatId}/messages`, { text: '  ' });
      expect(empty.status).toBe(400);
      expect(((await empty.json()) as { code: string }).code).toBe('EMPTY_MESSAGE');
      const missing = await call(alice, 'POST', `/chats/${ada.chatId}/messages`, {
        attachments: ['00000000-0000-4000-8000-000000000001'],
      });
      expect(missing.status).toBe(404);
      const foreign = await call(bob, 'POST', `/chats/${ada.chatId}/messages`, { text: 'hi' });
      expect(foreign.status).toBe(404);
    });

    it('attaches images and files as parts and references a Skill', async () => {
      const { db } = t;
      const workspace = await ensureWorkspace(db);
      const [image, doc] = await db
        .insert(schema.files)
        .values([
          {
            workspaceId: workspace.id,
            ownerId: aliceId,
            name: 'cat.png',
            mime: 'image/png',
            size: 10,
            storageKey: 'k-cat',
            sha256: 'x',
          },
          {
            workspaceId: workspace.id,
            ownerId: aliceId,
            name: 'notes.pdf',
            mime: 'application/pdf',
            size: 20,
            storageKey: 'k-notes',
            sha256: 'y',
          },
        ])
        .returning();
      const [skill] = await db
        .insert(schema.skills)
        .values({
          workspaceId: workspace.id,
          ownerId: aliceId,
          name: 'Triage',
          slug: 'triage',
        })
        .returning();
      const message = await post(ada.chatId, {
        text: 'look',
        attachments: [image!.id, doc!.id],
        skillId: skill!.id,
      });
      expect(message.parts).toEqual([
        { type: 'skill_ref', skill_id: skill!.id, name: 'Triage' },
        { type: 'text', text: 'look' },
        { type: 'image', file_id: image!.id, name: 'cat.png', mime: 'image/png', size: 10 },
        { type: 'file', file_id: doc!.id, name: 'notes.pdf', mime: 'application/pdf', size: 20 },
      ]);
    });

    it('references only a Skill that is on for one of the chat Bots with / (S2)', async () => {
      const { db } = t;
      const workspace = await ensureWorkspace(db);
      const insert = async (slug: string) =>
        (
          await db
            .insert(schema.skills)
            .values({ workspaceId: workspace.id, ownerId: aliceId, name: slug, slug })
            .returning()
        )[0]!;
      const graces = await insert('graces-ref');
      const off = await insert('off-ref');
      // Both are turned off for Ada; graces-ref stays on for Grace.
      await db.insert(schema.botSkillBlocks).values([
        { workspaceId: workspace.id, botId: ada.id, skillId: graces.id },
        { workspaceId: workspace.id, botId: ada.id, skillId: off.id },
      ]);
      const refuse = async (chatId: string, skillId: string, title: string) => {
        const res = await call(alice, 'POST', `/chats/${chatId}/messages`, { text: 'x', skillId });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'SKILL_UNAVAILABLE', title });
      };
      const enable =
        "This Skill is turned off for the Bots in this chat. Turn it on for one on the Skill's page before using it with /";
      await refuse(ada.chatId, graces.id, enable);
      await refuse(ada.chatId, off.id, enable);

      // In a group, a Skill that is on for any member Bot.
      const res = await call(alice, 'POST', '/chats', { botIds: [ada.id, grace.id] });
      const groupChat = (await res.json()) as Chat;
      const message = await post(groupChat.id, { text: 'go', skillId: graces.id });
      expect(message.parts[0]).toEqual({
        type: 'skill_ref',
        skill_id: graces.id,
        name: 'graces-ref',
      });
      // Later tests count the groups.
      await db.delete(schema.chats).where(eq(schema.chats.id, groupChat.id));
    });

    it('attaches only chat attachments and records the chat each was first sent in', async () => {
      const { db } = t;
      const workspace = await ensureWorkspace(db);
      const file = (
        name: string,
        purpose: 'attachment' | 'artifact' | 'webhook_body' | 'avatar',
      ) => ({
        workspaceId: workspace.id,
        ownerId: aliceId,
        name,
        mime: 'text/plain',
        size: 1,
        storageKey: `k-${name}`,
        sha256: 'z',
        purpose,
      });
      const [plain, blob, body, avatar] = await db
        .insert(schema.files)
        .values([
          file('plain.txt', 'attachment'),
          file('blob.txt', 'artifact'),
          file('body.txt', 'webhook_body'),
          file('avatar.txt', 'avatar'),
        ])
        .returning();
      for (const internal of [blob!, body!, avatar!]) {
        const res = await call(alice, 'POST', `/chats/${ada.chatId}/messages`, {
          attachments: [internal.id],
        });
        expect(res.status, internal.purpose).toBe(404);
      }
      await post(ada.chatId, { attachments: [plain!.id] });
      const other = (await (await call(alice, 'GET', `/bots/${grace.id}/chat`)).json()) as Chat;
      await post(other.id, { attachments: [plain!.id] });
      const [row] = await db.select().from(schema.files).where(eq(schema.files.id, plain!.id));
      expect(row!.chatId).toBe(ada.chatId);
    });

    it('assigns strictly increasing seqs under concurrent posts', async () => {
      const chat = (await (await call(alice, 'GET', `/bots/${grace.id}/chat`)).json()) as Chat;
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => post(chat.id, { text: `m${i}` })),
      );
      const seqs = results.map((m) => m.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => chat.lastSeq + i + 1));
      const [row] = await t.db
        .select({ chatSeq: schema.chats.chatSeq })
        .from(schema.chats)
        .where(eq(schema.chats.id, chat.id));
      expect(row!.chatSeq).toBe(chat.lastSeq + 20);
    });
  });

  describe('GET /chats/:id/messages', () => {
    let chatId: string;
    let root: Message;

    beforeAll(async () => {
      const workspace = await ensureWorkspace(t.db);
      const [chat] = await t.db
        .insert(schema.chats)
        .values({ workspaceId: workspace.id, ownerId: aliceId, type: 'group', title: 'Team' })
        .returning();
      chatId = chat!.id;
      for (let i = 1; i <= 5; i++) await post(chatId, { text: `top ${i}` });
      root = (await page(chatId, '?limit=1')).messages[0]!;
      await post(chatId, { text: 'reply 1', threadRootId: root.id });
      await post(chatId, { text: 'reply 2', threadRootId: root.id });
      await post(chatId, { text: 'top 6' });
    });

    const texts = (messages: Message[]) =>
      messages.map((m) => (m.parts[0] as { text: string }).text);

    it('pages top-level messages by seq, newest first', async () => {
      const first = await page(chatId, '?limit=3');
      expect(texts(first.messages)).toEqual(['top 6', 'top 5', 'top 4']);
      expect(first.hasMore).toBe(true);
      const next = await page(chatId, `?limit=3&before=${first.messages.at(-1)!.seq}`);
      expect(texts(next.messages)).toEqual(['top 3', 'top 2', 'top 1']);
      expect(next.hasMore).toBe(false);
    });

    it('counts thread replies on top-level messages, with the newest reply seq', async () => {
      const { messages } = await page(chatId);
      const replies = (await page(chatId, `?thread=${root.id}`)).messages;
      const counts = Object.fromEntries(
        messages.map((m) => [texts([m])[0], [m.replyCount, m.lastReplySeq]]),
      );
      expect(counts).toEqual({
        'top 6': [0, null],
        'top 5': [2, replies[0]!.seq],
        'top 4': [0, null],
        'top 3': [0, null],
        'top 2': [0, null],
        'top 1': [0, null],
      });
      expect(replies.slice(0, 2).every((m) => m.replyCount === undefined)).toBe(true);
    });

    it('scopes to a thread: the root and its replies', async () => {
      const thread = await page(chatId, `?thread=${root.id}`);
      expect(texts(thread.messages)).toEqual(['reply 2', 'reply 1', 'top 5']);
      expect(thread.messages.slice(0, 2).every((m) => m.threadRootId === root.id)).toBe(true);
    });

    it('rejects a reply to a reply or to another chat', async () => {
      const reply = (await page(chatId, `?thread=${root.id}`)).messages[0]!;
      const nested = await call(alice, 'POST', `/chats/${chatId}/messages`, {
        text: 'x',
        threadRootId: reply.id,
      });
      expect(((await nested.json()) as { code: string }).code).toBe('INVALID_THREAD');
      const elsewhere = await call(alice, 'POST', `/chats/${ada.chatId}/messages`, {
        text: 'x',
        threadRootId: root.id,
      });
      expect(elsewhere.status).toBe(400);
    });

    it("hides other users' chats and validates the query", async () => {
      expect((await call(bob, 'GET', `/chats/${chatId}/messages`)).status).toBe(404);
      expect((await call(alice, 'GET', `/chats/${chatId}/messages?limit=0`)).status).toBe(400);
    });

    it('lists the group in GET /chats', async () => {
      const { items } = (await (await call(alice, 'GET', '/chats')).json()) as { items: Chat[] };
      expect(items.map((c) => c.id)).toEqual([chatId]);
      expect(items[0]!.lastSeq).toBe(8);
      expect(await (await call(bob, 'GET', '/chats')).json()).toEqual({ items: [] });
    });
  });

  describe('reactions', () => {
    it('adds once, publishes reaction.added, and removes', async () => {
      const message = await post(ada.chatId, { text: 'react to me' });
      events.length = 0;
      const path = `/messages/${message.id}/reactions`;
      const added = await call(alice, 'POST', path, { emoji: '👍' });
      expect(added.status).toBe(201);
      expect(await added.json()).toEqual({
        messageId: message.id,
        emoji: '👍',
        reactorType: 'user',
        reactorId: aliceId,
      });
      expect((await call(alice, 'POST', path, { emoji: '👍' })).status).toBe(200);
      await flushEvents();
      expect(events.filter((e) => e.type === 'reaction.added')).toEqual([
        expect.objectContaining({
          chat_id: ada.chatId,
          payload: expect.objectContaining({ emoji: '👍' }),
        }),
      ]);

      expect((await call(bob, 'POST', path, { emoji: '👎' })).status).toBe(404);
      expect(
        (await call(alice, 'DELETE', `${path}?emoji=${encodeURIComponent('👍')}`)).status,
      ).toBe(204);
      const rows = await t.db
        .select()
        .from(schema.reactions)
        .where(eq(schema.reactions.messageId, message.id));
      expect(rows).toEqual([]);
    });

    it('publishes reaction.removed with the reaction.added payload, once', async () => {
      const message = await post(ada.chatId, { text: 'take it back' });
      const path = `/messages/${message.id}/reactions`;
      expect((await call(alice, 'POST', path, { emoji: '🎉' })).status).toBe(201);
      await flushEvents();
      const added = events.findLast((e) => e.type === 'reaction.added')!;
      events.length = 0;
      const remove = () => call(alice, 'DELETE', `${path}?emoji=${encodeURIComponent('🎉')}`);
      expect((await remove()).status).toBe(204);
      expect((await remove()).status).toBe(204);
      await flushEvents();
      expect(events.filter((e) => e.type === 'reaction.removed')).toEqual([
        expect.objectContaining({
          chat_id: ada.chatId,
          seq: message.seq,
          payload: added.payload,
        }),
      ]);
    });

    it('carries reactions on messages read from a page', async () => {
      const message = await post(ada.chatId, { text: 'chips' });
      const path = `/messages/${message.id}/reactions`;
      await call(alice, 'POST', path, { emoji: '👀' });
      await call(alice, 'POST', path, { emoji: '✅' });
      const plain = await post(ada.chatId, { text: 'no chips' });
      const { messages } = await page(ada.chatId, '?limit=2');
      expect(messages.map((m) => [m.id, m.reactions])).toEqual([
        [plain.id, []],
        [
          message.id,
          [
            { emoji: '👀', reactorType: 'user', reactorId: aliceId },
            { emoji: '✅', reactorType: 'user', reactorId: aliceId },
          ],
        ],
      ]);
    });
  });
});
