import { EVENTS_CHANNEL, type WsEvent } from '@openbots/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextSeq, schema } from '../db/client.js';
import { announceApproval } from '../services/approvals.js';
import { insertRun } from '../services/runs.js';
import { createTestApp, type TestApp } from '../test-app.js';

// `GET /approvals`: the caller's pending requests for the Mac app's tray.
// Deciding is covered end to end in workers/approvals.test.ts.

interface PendingApproval {
  id: string;
  runId: string | null;
  sessionId: string | null;
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

  /** A coding session's request on the owner's own drawer turn, which has no run. */
  async function sessionRequestFor(email: string, cookie: string, name: string) {
    const bot = (await (await call(cookie, 'POST', '/bots', { name })).json()) as {
      id: string;
      chatId: string;
    };
    const [row] = await t.db
      .select({ workspaceId: schema.bots.workspaceId })
      .from(schema.bots)
      .where(eq(schema.bots.id, bot.id));
    const workspaceId = row!.workspaceId;
    const [session] = await t.db
      .insert(schema.codingSessions)
      .values({
        workspaceId,
        ownerId: await t.userId(email),
        botId: bot.id,
        chatId: bot.chatId,
        agent: 'claude',
        mode: 'pr',
        prompt: 'Push it and open a PR',
        status: 'waiting',
      })
      .returning();
    const [approval] = await t.db
      .insert(schema.approvals)
      .values({
        workspaceId,
        sessionId: session!.id,
        toolName: 'open_pull_request',
        args: { branch: 'bot/fix' },
        actionClass: 'pr',
      })
      .returning();
    return { bot, session: session!, approval: approval! };
  }

  it("lists a session's request with no run under its session's Bot and chat", async () => {
    const { bot, session, approval } = await sessionRequestFor('alice@example.com', alice, 'Coder');
    expect(approval.runId).toBeNull();
    const item = (await pendingList(alice)).find((a) => a.id === approval.id);
    expect(item).toMatchObject({
      runId: null,
      sessionId: session.id,
      botId: bot.id,
      chatId: bot.chatId,
      seq: null,
    });
    expect((await pendingList(bob)).map((a) => a.id)).not.toContain(approval.id);
  });

  it('lets only the session owner decide a request with no run', async () => {
    const { approval } = await sessionRequestFor('alice@example.com', alice, 'Coder two');
    expect(
      (await call(bob, 'POST', `/approvals/${approval.id}/decide`, { decision: 'approve' })).status,
    ).toBe(404);
    const res = await call(alice, 'POST', `/approvals/${approval.id}/decide`, {
      decision: 'approve',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      approval: { id: approval.id, runId: null, status: 'approved' },
      resumedRunId: null,
    });
  });

  it("announces a request with no run to its session's Bot and owner", async () => {
    const { bot, session, approval } = await sessionRequestFor(
      'alice@example.com',
      alice,
      'Coder three',
    );
    const { workspaceId } = session;
    const seen: WsEvent[] = [];
    const unsubscribe = await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => {
      if (e.type === 'approval.requested') seen.push(e);
    });
    try {
      await t.inOrganization(() => announceApproval(t.ownerDeps, approval), workspaceId);
      expect(seen).toContainEqual(
        expect.objectContaining({
          bot_id: bot.id,
          chat_id: bot.chatId,
          user_id: session.ownerId,
          workspace_id: workspaceId,
          payload: expect.objectContaining({
            approval: expect.objectContaining({ id: approval.id, runId: null }),
          }),
        }),
      );
    } finally {
      await unsubscribe();
    }
  });

  it('needs a signed-in user', async () => {
    expect((await t.app.request('/api/v1/approvals')).status).toBe(401);
  });
});
