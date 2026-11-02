import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { wsEvent } from '@openbots/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import { publishEvent } from '../infra/index.js';
import { postMessage } from '../services/messages.js';
import { insertRun } from '../services/runs.js';
import { createTestApp, type TestApp } from '../test-app.js';
import {
  deliverEvent,
  EVENT_DELIVERIES_QUEUE,
  eventDeliveryHandler,
  fanOut,
  MAX_ATTEMPTS,
  retryDelayMs,
  signPayload,
  startEventFanOut,
  type EventDeliveryJob,
} from './outbound.js';

// Outbound event subscriptions (plan 11, H6): bus events an owner subscribed
// to are delivered to their URL, signed, and retried with backoff into
// `event_deliveries`; another owner's subscription hears nothing.

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe('outbound event subscriptions', () => {
  let t: TestApp;
  let cookie: string;
  let server: Server;
  let url: string;
  const received: Received[] = [];
  /** Status codes the receiver answers with, in order; 200 once they run out. */
  let replies: number[] = [];
  let stop: () => Promise<void>;
  const net = { allowPrivateNetwork: true };

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    cookie = (await t.signUp('dana@example.com')).cookie!;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.statusCode = replies.shift() ?? 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
    stop = await startEventFanOut(t.deps);
    await t.deps.infra
      .queue<EventDeliveryJob>(EVENT_DELIVERIES_QUEUE)
      .process(eventDeliveryHandler(t.deps, net));
  });
  afterAll(async () => {
    await stop();
    await t.close();
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(async () => {
    // Each test hears only its own subscriptions.
    await t.db.update(schema.eventSubscriptions).set({ enabled: false });
    received.length = 0;
    replies = [];
  });

  function call(method: string, path: string, body?: unknown, as = cookie) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        cookie: as,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /**
   * A subscription to `to`. The managed service lets no receiver be marked
   * local (S-8, plan 21.6), so one on 127.0.0.1 is made for a public address
   * and moved there in the database, as a row from before the rule would be.
   */
  async function subscribe(events: string[], as = cookie, to = url) {
    const res = await call(
      'POST',
      '/event-subscriptions',
      { url: 'https://203.0.113.10/events', events },
      as,
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      subscription: { id: string; local: boolean };
      secret: string;
    };
    const local = to.startsWith('http://127.0.0.1');
    await t.db
      .update(schema.eventSubscriptions)
      .set({ url: to, local })
      .where(eq(schema.eventSubscriptions.id, created.subscription.id));
    return { ...created, subscription: { ...created.subscription, local } };
  }

  async function newBot(name: string, as = cookie) {
    const res = await call('POST', '/bots', { name }, as);
    return (await res.json()) as { id: string; chatId: string };
  }

  const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });

  /** What the receiver got about one message; a new Bot's greeting goes out too. */
  const about = (messageId: string) =>
    received.filter(
      (r) =>
        (JSON.parse(r.body) as { data: { message?: { id: string } } }).data.message?.id ===
        messageId,
    );

  const deliveriesOf = (subscriptionId: string) =>
    t.db
      .select()
      .from(schema.eventDeliveries)
      .where(eq(schema.eventDeliveries.subscriptionId, subscriptionId));

  it('delivers a subscribed event, signed with the subscription secret', async () => {
    const { subscription, secret } = await subscribe(['message.created', 'run.completed']);
    expect(secret).toMatch(/^obs_/);
    const bot = await newBot('Speaker');
    const message = await t.inOrganization(() =>
      postMessage(t.ownerDeps, bot.chatId, {
        authorType: 'system',
        parts: [{ type: 'text', text: 'hello out there' }],
      }),
    );
    await until(() => expect(about(message.id)).toHaveLength(1));
    const [request] = about(message.id);
    const body = JSON.parse(request!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ type: 'message.created', data: { message: { id: message.id } } });
    expect(request!.headers['x-openbots-event']).toBe('message.created');
    expect(request!.headers['x-openbots-delivery']).toBe(body['id']);
    const header = request!.headers['x-openbots-signature'] as string;
    const ts = Number(/t=(\d+)/.exec(header)![1]);
    expect(header).toBe(signPayload(secret, request!.body, ts));
    expect(header).toBe(
      `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${request!.body}`).digest('hex')}`,
    );
    const delivery = async () =>
      (await deliveriesOf(subscription.id)).find((d) => d.id === body['id']);
    await until(async () =>
      expect(await delivery()).toMatchObject({
        event: 'message.created',
        status: 'delivered',
        attempts: 1,
      }),
    );
    // The log through the API, newest first.
    const log = await call('GET', `/event-subscriptions/${subscription.id}/deliveries`);
    expect(await log.json()).toMatchObject({
      items: [{ id: body['id'], status: 'delivered', attempts: 1 }, {}],
    });
  });

  it("sends a webhook's message as metadata and its delivery id, never the payload (H6)", async () => {
    await subscribe(['message.created']);
    const bot = await newBot('Hooked');
    const listed = await call('GET', `/bots/${bot.id}/endpoints`);
    const [inbox] = ((await listed.json()) as { items: { id: string }[] }).items;
    const [delivery] = await t.db
      .insert(schema.webhookDeliveries)
      .values({
        workspaceId: (await t.db.select().from(schema.bots).where(eq(schema.bots.id, bot.id)))[0]!
          .workspaceId,
        endpointId: inbox!.id,
        status: 'queued',
        verified: true,
      })
      .returning();
    // As acceptDelivery posts it: the message takes the delivery's id.
    const message = await t.inOrganization(() =>
      postMessage(t.ownerDeps, bot.chatId, {
        id: delivery!.id,
        authorType: 'webhook',
        authorId: inbox!.id,
        parts: [{ type: 'text', text: '<webhook_event>{"card":"4242 secret"}</webhook_event>' }],
      }),
    );
    await until(() => expect(about(message.id)).toHaveLength(1));
    const { body } = about(message.id)[0]!;
    expect(body).not.toContain('4242 secret');
    const sent = JSON.parse(body) as { data: { message: Record<string, unknown> } };
    expect(sent).toMatchObject({
      type: 'message.created',
      data: {
        message: {
          id: message.id,
          chatId: bot.chatId,
          authorType: 'webhook',
          authorId: inbox!.id,
        },
        deliveryId: delivery!.id,
      },
    });
    expect(sent.data.message).not.toHaveProperty('parts');
  });

  it('maps run status to run.completed, run.failed and routine.ran, each once', async () => {
    const { subscription } = await subscribe(['run.completed', 'run.failed']);
    const bot = await newBot('Runner');
    const run = await insertRun(t.db, {
      botId: bot.id,
      chatId: bot.chatId,
      trigger: 'message',
    });
    await t.db.update(schema.runs).set({ status: 'completed' }).where(eq(schema.runs.id, run.id));
    const event = wsEvent(
      'run.status',
      { runId: run.id, status: 'completed', error: null },
      { bot_id: bot.id },
    );
    // Published twice (two workers both hear it): sent once.
    await fanOut(t.ownerDeps, event);
    await fanOut(t.ownerDeps, event);
    await until(() => expect(received).toHaveLength(1));
    expect(JSON.parse(received[0]!.body)).toMatchObject({
      type: 'run.completed',
      data: { run: { id: run.id, status: 'completed', trigger: 'message' } },
    });
    expect(await deliveriesOf(subscription.id)).toHaveLength(1);
    // Queued and running are not outbound events.
    expect(
      await fanOut(
        t.ownerDeps,
        wsEvent('run.status', { runId: run.id, status: 'running' }, { bot_id: bot.id }),
      ),
    ).toEqual([]);
  });

  it('retries a failed delivery with backoff, then marks it failed after the last attempt', async () => {
    const { subscription } = await subscribe(['approval.requested']);
    const bot = await newBot('Asker');
    const approvalId = randomUUID();
    replies = [500];
    const [row] = await fanOut(
      t.ownerDeps,
      wsEvent(
        'approval.requested',
        {
          approval: {
            id: approvalId,
            runId: randomUUID(),
            toolName: 'bash',
            args: {},
            status: 'pending',
          } as never,
        },
        { bot_id: bot.id },
      ),
    );
    await until(async () =>
      expect((await deliveriesOf(subscription.id))[0]).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastError: 'HTTP 500',
      }),
    );
    const [pending] = await deliveriesOf(subscription.id);
    const wait = pending!.nextAttemptAt!.getTime() - Date.now();
    expect(wait).toBeGreaterThan(retryDelayMs(1) - 2_000);
    expect(wait).toBeLessThanOrEqual(retryDelayMs(1));
    expect(retryDelayMs(2)).toBe(3 * retryDelayMs(1));

    // The retry (here run by hand rather than after 10 s) goes through.
    const retried = await deliverEvent(t.ownerDeps, row!.id, net);
    expect(retried).toMatchObject({ status: 'delivered', attempts: 2, lastError: null });
    expect(received.map((r) => JSON.parse(r.body).data.approval.id)).toEqual([
      approvalId,
      approvalId,
    ]);
    // A delivered row is not sent again.
    await deliverEvent(t.ownerDeps, row!.id, net);
    expect(received).toHaveLength(2);

    // A receiver that always fails: failed after MAX_ATTEMPTS, nothing further queued.
    const [doomed] = await fanOut(
      t.ownerDeps,
      wsEvent(
        'approval.requested',
        { approval: { id: randomUUID(), runId: randomUUID(), status: 'pending' } as never },
        { bot_id: bot.id },
      ),
    );
    replies = Array<number>(MAX_ATTEMPTS + 1).fill(503);
    await until(async () => {
      const [current] = await t.db
        .select()
        .from(schema.eventDeliveries)
        .where(eq(schema.eventDeliveries.id, doomed!.id));
      expect(current!.attempts).toBe(1);
    });
    let last;
    for (let i = 1; i < MAX_ATTEMPTS; i++) last = await deliverEvent(t.ownerDeps, doomed!.id, net);
    expect(last).toMatchObject({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
      lastError: 'HTTP 503',
      nextAttemptAt: null,
    });
  });

  it('sends only what an owner subscribed to, and only their own events', async () => {
    const other = (await t.signUp('eve@example.com')).cookie!;
    // A public address (TEST-NET-3): Eve is not an admin, so she cannot mark one local.
    const theirs = await subscribe(['message.created'], other, 'https://203.0.113.10/events');
    const mine = await subscribe(['artifact.created']);
    const bot = await newBot('Quiet');
    await t.inOrganization(() =>
      postMessage(t.ownerDeps, bot.chatId, {
        authorType: 'system',
        parts: [{ type: 'text', text: 'x' }],
      }),
    );
    // Published in the Bot's organization, as the artifact service would.
    await t.inOrganization(() =>
      publishEvent(
        t.deps.infra.bus,
        wsEvent(
          'artifact.created',
          { artifactId: randomUUID(), title: 'Plan' },
          { bot_id: bot.id },
        ),
      ),
    );
    await until(async () => expect(await deliveriesOf(mine.subscription.id)).toHaveLength(1));
    expect(await deliveriesOf(theirs.subscription.id)).toHaveLength(0);
  });

  it('manages subscriptions: validation, rotation, disable, delete, ownership', async () => {
    expect(
      (await call('POST', '/event-subscriptions', { url: 'ftp://x', events: ['run.failed'] }))
        .status,
    ).toBe(400);
    expect((await call('POST', '/event-subscriptions', { url, events: ['nope'] })).status).toBe(
      400,
    );
    const { subscription, secret } = await subscribe(['run.failed']);
    const list = await (await call('GET', '/event-subscriptions')).text();
    expect(list).not.toContain(secret);
    const rotated = (await (
      await call('PATCH', `/event-subscriptions/${subscription.id}`, {
        rotateSecret: true,
        enabled: false,
      })
    ).json()) as { subscription: { enabled: boolean }; secret: string };
    expect(rotated.subscription.enabled).toBe(false);
    expect(rotated.secret).not.toBe(secret);
    const other = (await t.signUp('mallory@example.com')).cookie!;
    expect(
      (await call('DELETE', `/event-subscriptions/${subscription.id}`, undefined, other)).status,
    ).toBe(404);
    expect((await call('DELETE', `/event-subscriptions/${subscription.id}`)).status).toBe(204);
  });

  it('refuses a private receiver, and any local mark on the managed service (S-8)', async () => {
    const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;
    const unmarked = await call('POST', '/event-subscriptions', { url, events: ['run.failed'] });
    expect(unmarked.status).toBe(400);
    expect(await codeOf(unmarked)).toBe('PRIVATE_HOST');
    const metadata = 'http://169.254.169.254/latest';
    expect(
      await codeOf(
        await call('POST', '/event-subscriptions', { url: metadata, events: ['run.failed'] }),
      ),
    ).toBe('PRIVATE_HOST');
    // The server's network is every organization's: not even an owner marks a receiver local.
    const refused = await call('POST', '/event-subscriptions', {
      url,
      events: ['run.failed'],
      local: true,
    });
    expect(refused.status).toBe(403);
    const { subscription } = await subscribe(['run.failed']);
    const patched = await call('PATCH', `/event-subscriptions/${subscription.id}`, {
      local: true,
    });
    expect(patched.status).toBe(403);

    // Delivery: the worker here is exempt, so each send below is made by hand with no exemption.
    const bot = await newBot('Local');
    const run = await insertRun(t.db, {
      botId: bot.id,
      chatId: bot.chatId,
      trigger: 'message',
    });
    const [row] = await fanOut(
      t.ownerDeps,
      wsEvent('run.status', { runId: run.id, status: 'failed', error: 'x' }, { bot_id: bot.id }),
    );
    await until(async () =>
      expect((await deliveriesOf(subscription.id))[0]).toMatchObject({ status: 'delivered' }),
    );
    const resend = async (local: boolean) => {
      await t.db
        .update(schema.eventSubscriptions)
        .set({ local })
        .where(eq(schema.eventSubscriptions.id, subscription.id));
      await t.db
        .update(schema.eventDeliveries)
        .set({ status: 'pending', attempts: 0 })
        .where(eq(schema.eventDeliveries.id, row!.id));
      return deliverEvent(t.ownerDeps, row!.id, {});
    };
    // Marked local, the guard lets the delivery reach 127.0.0.1.
    expect(await resend(true)).toMatchObject({ status: 'delivered', lastError: null });
    // Unmarked (a row saved before the check), the guard blocks it.
    expect((await resend(false))!.lastError).toMatch(/private or local network/);
  });
});

describe('local receivers on a self-hosted install (S-8)', () => {
  let t: TestApp;
  let cookie: string;
  const url = 'http://127.0.0.1:9/events';

  beforeAll(async () => {
    t = await createTestApp();
    cookie = (await t.signUp('owner@example.com')).cookie!;
  });
  afterAll(() => t.close());

  const call = (method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

  it('lets the owner mark a receiver local, and holds a new URL to public addresses again', async () => {
    const created = await call('POST', '/event-subscriptions', {
      url,
      events: ['run.failed'],
      local: true,
    });
    expect(created.status).toBe(201);
    const { subscription } = (await created.json()) as {
      subscription: { id: string; local: boolean };
    };
    expect(subscription.local).toBe(true);
    const moved = `${url}?v=2`;
    const patch = (body: unknown) => call('PATCH', `/event-subscriptions/${subscription.id}`, body);
    expect(await codeOf(await patch({ url: moved }))).toBe('PRIVATE_HOST');
    expect((await patch({ url: moved, local: true })).status).toBe(200);
    expect(await codeOf(await patch({ local: false }))).toBe('PRIVATE_HOST');
    expect((await patch({ local: true })).status).toBe(200);
  });
});
