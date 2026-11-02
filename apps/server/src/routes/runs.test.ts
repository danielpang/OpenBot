import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { enqueueRun } from '../services/runs.js';
import { createTestApp, type TestApp } from '../test-app.js';

// Run reads, cancel and SSE; the worker itself is covered in workers/runs.test.ts.

describe('runs API', () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  let bot: { id: string; chatId: string };

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    alice = (await t.signUp('alice@example.com')).cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
    bot = (await (await call(alice, 'POST', '/bots', { name: 'Runner' })).json()) as typeof bot;
  });
  afterAll(() => t.close());

  function call(cookie: string, method: string, path: string, body?: unknown) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("answers 404 for another user's run and for unknown ids", async () => {
    const run = await enqueueRun(t.ownerDeps, {
      botId: bot.id,
      chatId: bot.chatId,
      trigger: 'routine',
    });
    expect(run).toMatchObject({ status: 'queued', priority: 3 });
    expect((await call(alice, 'GET', `/runs/${run.id}`)).status).toBe(200);
    expect((await call(bob, 'GET', `/runs/${run.id}`)).status).toBe(404);
    expect((await call(bob, 'GET', `/runs/${run.id}/steps`)).status).toBe(404);
    expect((await call(bob, 'POST', `/runs/${run.id}/cancel`)).status).toBe(404);
    expect((await call(alice, 'GET', `/runs/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it('cancels a queued run, which its job then skips', async () => {
    const run = await enqueueRun(t.ownerDeps, {
      botId: bot.id,
      chatId: bot.chatId,
      trigger: 'webhook',
    });
    const res = await call(alice, 'POST', `/runs/${run.id}/cancel`);
    expect(await res.json()).toMatchObject({
      status: 'cancelled',
      error: 'Cancelled by the owner',
      finishedAt: expect.any(String),
    });
  });

  it('streams run events as SSE and ends when the run finishes', async () => {
    const run = await enqueueRun(t.ownerDeps, {
      botId: bot.id,
      chatId: bot.chatId,
      trigger: 'message',
    });
    const res = await call(alice, 'GET', `/runs/${run.id}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // Finish the run from "the worker" while the client listens.
    setTimeout(() => {
      void (async () => {
        await t.db.insert(schema.runSteps).values({
          workspaceId: (await t.db.select().from(schema.workspaces))[0]!.id,
          runId: run.id,
          idx: 0,
          type: 'llm',
          label: 'Thought briefly',
        });
        await call(alice, 'POST', `/runs/${run.id}/cancel`);
      })();
    }, 20);
    const body = await res.text();
    const events = body
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)) as { type: string; payload: { status?: string } });
    expect(events[0]).toMatchObject({ type: 'run.status', payload: { status: 'queued' } });
    expect(events.at(-1)).toMatchObject({ type: 'run.status', payload: { status: 'cancelled' } });
  });

  it('ends at once for a finished run', async () => {
    const run = await enqueueRun(t.ownerDeps, {
      botId: bot.id,
      chatId: bot.chatId,
      trigger: 'message',
    });
    await call(alice, 'POST', `/runs/${run.id}/cancel`);
    const body = await (await call(alice, 'GET', `/runs/${run.id}/events`)).text();
    expect(body.match(/^data: /gm)).toHaveLength(1);
  });
});
