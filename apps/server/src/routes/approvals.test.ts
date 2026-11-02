import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextSeq, schema } from '../db/client.js';
import { insertRun } from '../services/runs.js';
import { createTestApp, type TestApp } from '../test-app.js';

// `GET /approvals`: the caller's pending requests for the Mac app's tray.
// Deciding is covered end to end in workers/approvals.test.ts.

interface PendingApproval {
  id: string;
  botId: string;
  chatId: string | null;
  seq: number | null;
  toolName: string;
  summary: string;
  status: string;
  createdAt: string;
}

describe('approvals API', () => {
  let t: TestApp;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    alice = (await t.signUp('alice@example.com')).cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
  });
  afterAll(() => t.close());

  function call(cookie: string, method: string, path: string, body?: unknown) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function pendingList(cookie: string) {
    const res = await call(cookie, 'GET', '/approvals?status=pending');
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: PendingApproval[] }).items;
  }

  /** A paused run with an approval message in the Bot's chat. */
  async function requestFor(cookie: string, name: string, toolName: string, status = 'pending') {
    const bot = (await (await call(cookie, 'POST', '/bots', { name })).json()) as {
      id: string;
      chatId: string;
      workspaceId: string;
    };
    const { db } = t;
    const run = await insertRun(db, { botId: bot.id, chatId: bot.chatId, trigger: 'message' });
    const [message] = await db.transaction(async (tx) =>
      tx
        .insert(schema.messages)
        .values({
          workspaceId: run.workspaceId,
          chatId: bot.chatId,
          seq: await nextSeq(tx, bot.chatId),
          authorType: 'bot',
          authorId: bot.id,
          parts: [],
        })
        .returning(),
    );
    const [approval] = await db
      .insert(schema.approvals)
      .values({
        workspaceId: run.workspaceId,
        runId: run.id,
        messageId: message!.id,
        toolName,
        args: { command: 'ls' },
        status: status as 'pending',
      })
      .returning();
    return { bot, message: message!, approval: approval! };
  }

  it("lists the caller's pending approvals with their Bot, chat and seq", async () => {
    const first = await requestFor(alice, 'Ops', 'bash');
    const second = await requestFor(alice, 'Mailer', 'send_email');
    await requestFor(alice, 'Done', 'bash', 'approved');

    const items = await pendingList(alice);
    expect(items.map((a) => a.id)).toEqual([first.approval.id, second.approval.id]);
    expect(items[0]).toMatchObject({
      id: first.approval.id,
      botId: first.bot.id,
      chatId: first.bot.chatId,
      seq: first.message.seq,
      toolName: 'bash',
      summary: expect.any(String),
      status: 'pending',
      createdAt: expect.any(String),
    });
    // `status` defaults to pending, the only value it takes.
    expect((await call(alice, 'GET', '/approvals')).status).toBe(200);
    expect((await call(alice, 'GET', '/approvals?status=approved')).status).toBe(400);
  });

  it("never shows one user another user's approvals", async () => {
    const own = await requestFor(alice, 'Private', 'bash');
    expect((await pendingList(alice)).map((a) => a.id)).toContain(own.approval.id);
    expect(await pendingList(bob)).toEqual([]);

    const bobs = await requestFor(bob, 'Bobs', 'bash');
    expect((await pendingList(bob)).map((a) => a.id)).toEqual([bobs.approval.id]);
    expect((await pendingList(alice)).map((a) => a.id)).not.toContain(bobs.approval.id);
  });

  it('needs a signed-in user', async () => {
    expect((await t.app.request('/api/v1/approvals')).status).toBe(401);
  });
});
