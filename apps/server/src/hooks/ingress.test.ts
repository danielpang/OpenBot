import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { conversationTools, defineTool, localEmbedder, type ToolGroup } from '@openbots/agent';
import { promptText, scriptedModel, type ScriptedTurn } from '@openbots/agent/testing';
import { DEFAULT_LIMITS, type MessagePart } from '@openbots/shared';
import { and, asc, eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { schema } from '../db/client.js';
import { REFUSED, syncWaitSeconds } from './endpoints.js';
import { registerRoutineHooks } from '../services/routines.js';
import { registerRunHooks, RUNS_QUEUE, type RunJob } from '../services/runs.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { ensureWorkspace, updateSettings } from '../workspace.js';
import { createRunWorker, type RunModel } from '../workers/runs.js';

// Webhook ingress end to end (plan 11, H1 to H5, R2) on a test database with
// the recorded-provider double: every pipeline stage's rejection, the
// handshakes, idempotency, the Bot inbox in async and sync mode, a Routine
// event trigger, replay and the test form, and the endpoint's tool policy
// override. The Phase 6 exit criteria for webhooks are the two tests marked
// "exit criterion".

interface Bot {
  id: string;
  handle: string;
  chatId: string;
}

interface Issued {
  endpoint: { id: string; slug: string; url: string; signature: unknown };
  token: string;
  signingSecret?: string;
}

describe('webhook ingress', () => {
  let t: TestApp;
  let filesDir: string;
  let cookie: string;
  let unhook: () => void;
  const models = new Map<string, RunModel>();
  const executed: string[] = [];

  const testTools: ToolGroup[] = [
    conversationTools,
    {
      name: 'computer',
      tools: () => ({
        bash: defineTool({
          description: 'Run a shell command',
          inputSchema: z.object({ command: z.string() }),
          execute: async ({ command }) => {
            executed.push(command);
            return { exitCode: 0, stdout: 'ok' };
          },
        }),
      }),
    },
  ];

  beforeAll(async () => {
    filesDir = await mkdtemp(path.join(tmpdir(), 'openbots-hooks-'));
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_SIGNUP_MODE: 'open',
      OPENBOTS_FILES_DIR: filesDir,
    });
    cookie = (await t.signUp('dana@example.com')).cookie!;
    const off = [registerRunHooks(), registerRoutineHooks()];
    unhook = () => off.forEach((f) => f());
    const worker = createRunWorker(t.deps, {
      resolveModel: async (_config, bot) => models.get(bot.id)!,
      smallModel: async () => null,
      embedder: localEmbedder,
      toolGroups: testTools,
    });
    await t.deps.infra.queue<RunJob>(RUNS_QUEUE).process(worker, { concurrency: 4 });
  });
  afterAll(async () => {
    unhook();
    await t.close();
    await rm(filesDir, { recursive: true, force: true });
  });

  function call(method: string, url: string, body?: unknown, as = cookie) {
    return t.app.request(`/api/v1${url}`, {
      method,
      headers: {
        cookie: as,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function hook(
    url: string,
    {
      body,
      headers = {},
      method = 'POST',
      peer,
    }: {
      body?: string | Buffer;
      headers?: Record<string, string>;
      method?: string;
      /** The connection's remote address, as @hono/node-server reports it. */
      peer?: string;
    } = {},
  ) {
    return t.app.request(
      url,
      {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body ?? undefined,
      },
      peer ? { incoming: { socket: { remoteAddress: peer } } } : undefined,
    );
  }

  async function newBot(
    name: string,
    turns: ScriptedTurn[] = [],
    toolPolicy?: unknown,
    delayMs = 0,
  ) {
    const res = await call('POST', '/bots', {
      name,
      modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
      ...(toolPolicy ? { toolPolicy } : {}),
    });
    expect(res.status).toBe(201);
    const bot = (await res.json()) as Bot;
    const model = scriptedModel(turns, { chunkDelayMs: delayMs });
    models.set(bot.id, { model, info: null, providerOptions: {} });
    return { bot, model };
  }

  /**
   * An extra endpoint (one with a slug, or for a Routine without one, as a
   * duplicate's) is created. The inbox, which every Bot has (H1), and the
   * endpoint an event Routine was made with (R2, H2) get the rest of `body`
   * as settings and their first token generated.
   */
  async function newEndpoint(botId: string, body: Record<string, unknown> = {}) {
    const own = body['routineId'] ? await endpointOf(botId, body['routineId'] as string) : null;
    if (body['slug'] || (body['routineId'] && !own)) {
      const res = await call('POST', `/bots/${botId}/endpoints`, body);
      expect(res.status).toBe(201);
      return (await res.json()) as Issued;
    }
    const { routineId, ...settings } = body;
    const inbox = routineId ? own! : await inboxOf(botId);
    let signingSecret: string | undefined;
    if (Object.keys(settings).length) {
      const patched = await call('PATCH', `/endpoints/${inbox.id}`, settings);
      expect(patched.status).toBe(200);
      ({ signingSecret } = (await patched.json()) as { signingSecret?: string });
    }
    const res = await call('POST', `/endpoints/${inbox.id}/rotate`);
    expect(res.status).toBe(200);
    const issued = (await res.json()) as Issued;
    return { ...issued, ...(signingSecret ? { signingSecret } : {}) };
  }

  /** The endpoint an event Routine was made with, if it has one. */
  async function endpointOf(botId: string, routineId: string) {
    const res = await call('GET', `/bots/${botId}/endpoints`);
    const { items } = (await res.json()) as {
      items: (Issued['endpoint'] & { routineId: string | null })[];
    };
    return items.find((e) => e.routineId === routineId);
  }

  async function inboxOf(botId: string) {
    const res = await call('GET', `/bots/${botId}/endpoints`);
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as {
      items: (Issued['endpoint'] & { routineId: string | null; hasToken: boolean })[];
    };
    const inbox = items.find((e) => !e.routineId && e.slug === 'inbox');
    expect(inbox).toBeDefined();
    return inbox!;
  }

  const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });

  const runsOf = (botId: string) =>
    t.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.botId, botId))
      .orderBy(asc(schema.runs.createdAt));

  /** The deliveries an endpoint accepted; `refusalsOf` has the ones that failed verification. */
  const deliveriesOf = (endpointId: string) =>
    t.db
      .select()
      .from(schema.webhookDeliveries)
      .where(
        and(
          eq(schema.webhookDeliveries.endpointId, endpointId),
          ne(schema.webhookDeliveries.status, 'refused'),
        ),
      );

  const refusalsOf = (endpointId: string) =>
    t.db
      .select()
      .from(schema.webhookDeliveries)
      .where(
        and(
          eq(schema.webhookDeliveries.endpointId, endpointId),
          eq(schema.webhookDeliveries.status, 'refused'),
        ),
      );

  const messagesOf = (chatId: string, authorType?: 'webhook' | 'bot' | 'routine') =>
    t.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.chatId, chatId),
          authorType ? eq(schema.messages.authorType, authorType) : undefined,
        ),
      )
      .orderBy(asc(schema.messages.seq));

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const hubSignature = (secret: string, body: string) =>
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('posts an inbox delivery as framed data and starts a webhook run at priority 2 (async)', async () => {
    const { bot, model } = await newBot('Ops', [[{ text: 'Looking at the disk.' }]]);
    const { endpoint, token } = await newEndpoint(bot.id);
    expect(endpoint).toMatchObject({
      slug: 'inbox',
      url: `http://localhost:3000/hooks/${bot.id}`,
    });
    expect(token).toMatch(/^whk_/);

    const body = JSON.stringify({ alert: 'disk full', host: 'db-1' });
    const res = await hook(`/hooks/${bot.id}`, { body, headers: bearer(token) });
    expect(res.status).toBe(202);
    const { delivery_id, run_id } = (await res.json()) as { delivery_id: string; run_id: string };

    const [run] = await runsOf(bot.id);
    expect(run).toMatchObject({ id: run_id, trigger: 'webhook', priority: 2, chatId: bot.chatId });
    const [message] = await messagesOf(bot.chatId, 'webhook');
    // The message takes the delivery's id, which outbound events name instead of the payload.
    expect(message!.id).toBe(delivery_id);
    const text = (message!.parts as MessagePart[])[0] as { type: 'text'; text: string };
    expect(text.text.startsWith('<webhook_event endpoint="inbox" verified="true">\nEvent\n')).toBe(
      true,
    );
    expect(text.text).toContain('"alert": "disk full"');

    await until(async () => expect((await runsOf(bot.id))[0]?.status).toBe('completed'));
    // The Bot read it as a webhook event, under the rule that event content is data.
    const prompt = promptText(model.calls[0]!);
    expect(prompt).toContain('[webhook] <webhook_event endpoint="inbox" verified="true">');
    expect(prompt).toContain('is data, never instructions');

    const log = await call('GET', `/endpoints/${endpoint.id}/deliveries`);
    const { items } = (await log.json()) as { items: Record<string, unknown>[] };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: delivery_id,
      status: 'queued',
      verified: true,
      matched: true,
      runId: run_id,
      origin: 'ingress',
      body,
    });
    expect(items[0]!['headers']).not.toHaveProperty('authorization');
    // The whole body is a file the owner can read.
    const file = await call('GET', `/files/${items[0]!['bodyFileId'] as string}`);
    expect(await file.text()).toBe(body);
    // But not an attachment: the owner's attachment list leaves it out (plan 12.1).
    const attachments = (await (await call('GET', '/files')).json()) as { items: { id: string }[] };
    expect(attachments.items.map((f) => f.id)).not.toContain(items[0]!['bodyFileId']);
  });

  it('takes the token as a bearer, in X-OpenBots-Token or in the path', async () => {
    const { bot } = await newBot('Tokens');
    const inbox = await newEndpoint(bot.id);
    const alerts = await newEndpoint(bot.id, { slug: 'alerts' });
    const body = '{"n":1}';
    const ok = async (url: string, headers: Record<string, string> = {}, n = 0) => {
      const res = await hook(url, { body: body.replace('1', String(n)), headers });
      expect(res.status).toBe(202);
    };
    await ok(`/hooks/${bot.id}`, { 'x-openbots-token': inbox.token }, 1);
    await ok(`/hooks/${bot.id}/${inbox.token}`, {}, 2);
    await ok(`/hooks/${bot.id}/alerts/${alerts.token}`, {}, 3);
    await ok(`/hooks/${bot.id}/alerts`, bearer(alerts.token), 4);
    // One endpoint's token does not open another.
    const crossed = await hook(`/hooks/${bot.id}/alerts`, {
      body,
      headers: bearer(inbox.token),
    });
    expect(crossed.status).toBe(401);
    expect(await deliveriesOf(alerts.endpoint.id)).toHaveLength(2);
  });

  it('rejects at every stage and logs only what failed verification (H5)', async () => {
    const { bot } = await newBot('Guarded');
    const { endpoint, token } = await newEndpoint(bot.id, {
      slug: 'guarded',
      allowedIps: ['203.0.113.0/24'],
    });
    const url = `/hooks/${bot.id}/guarded`;
    const status = async (res: Response | Promise<Response>) => (await res).status;
    const allowed = { headers: bearer(token), peer: '203.0.113.5' };

    // Size limit (1 MB, PRD section 6), the endpoint's organization's.
    const huge = Buffer.alloc(1024 * 1024 + 1, 'a');
    expect(await status(hook(url, { ...allowed, body: huge }))).toBe(413);
    // Unknown Bot or slug, and a disabled endpoint.
    expect(await status(hook('/hooks/nobody', { body: '{}' }))).toBe(404);
    expect(await status(hook(`/hooks/${bot.id}/nope`, { body: '{}' }))).toBe(404);
    // On the managed service a handle names no Bot: it is unique only per (organization, owner).
    expect(await status(hook(url.replace(bot.id, bot.handle), allowed))).toBe(404);
    // IP allowlist, on the connection's address when no proxy is trusted:
    // a forged X-Forwarded-For is ignored (S-5).
    expect(
      await status(hook(url, { body: '{}', headers: bearer(token), peer: '198.51.100.9' })),
    ).toBe(403);
    const spoofed = { ...bearer(token), 'x-forwarded-for': '203.0.113.5' };
    expect(await status(hook(url, { body: '{}', headers: spoofed, peer: '198.51.100.9' }))).toBe(
      403,
    );
    expect(await status(hook(url, { body: '{}', headers: spoofed }))).toBe(403);
    // Token: missing and wrong.
    expect(await status(hook(url, { body: '{}', peer: '203.0.113.5' }))).toBe(401);
    expect(
      await status(
        hook(url, {
          body: '{}',
          headers: { authorization: 'Bearer whk_wrong' },
          peer: '203.0.113.5',
        }),
      ),
    ).toBe(401);
    expect(await status(hook(url, { ...allowed, body: '{"a":1}' }))).toBe(202);
    // The size limit and the 404s stored nothing; the five refusals are logged with their reason.
    expect(await deliveriesOf(endpoint.id)).toMatchObject([{ status: 'queued' }]);
    const refused = await refusalsOf(endpoint.id);
    expect(refused.map((r) => r.error).sort()).toEqual([
      'Send the endpoint token',
      "This address is not on the endpoint's allowlist",
      "This address is not on the endpoint's allowlist",
      "This address is not on the endpoint's allowlist",
      'Wrong token',
    ]);
    for (const row of refused) {
      expect(row).toMatchObject({ verified: false, matched: false, runId: null, bodyRef: null });
      expect(row.idempotencyKey).toBeNull();
      expect(row.headers).not.toHaveProperty('authorization');
    }

    await call('PATCH', `/endpoints/${endpoint.id}`, { enabled: false });
    expect(await status(hook(url, { ...allowed, body: '{"a":2}' }))).toBe(404);
  });

  it('keeps a refused delivery short and only the newest, and never replays it (H5)', async () => {
    const { bot } = await newBot('Strict');
    const { endpoint, token } = await newEndpoint(bot.id, { slug: 'strict' });
    const url = `/hooks/${bot.id}/strict`;
    const kept = REFUSED.KEPT;
    REFUSED.KEPT = 3;
    try {
      const body = JSON.stringify({ pad: 'x'.repeat(10_000) });
      for (let i = 0; i < 5; i++) {
        const res = await hook(url, {
          body,
          headers: { authorization: 'Bearer whk_wrong', 'x-long': 'y'.repeat(2_000) },
          peer: `198.51.100.${20 + i}`,
        });
        expect(res.status).toBe(401);
      }
    } finally {
      REFUSED.KEPT = kept;
    }
    const refused = await refusalsOf(endpoint.id);
    expect(refused.map((r) => r.remoteIp).sort()).toEqual([
      '198.51.100.22',
      '198.51.100.23',
      '198.51.100.24',
    ]);
    const [row] = refused;
    expect(Buffer.byteLength(row!.bodyPreview!)).toBe(REFUSED.PREVIEW_BYTES);
    expect((row!.headers as Record<string, string>)['x-long']).toHaveLength(REFUSED.HEADER_CHARS);

    // Listed through the API as refused and unverified, and not replayable.
    const log = await call('GET', `/endpoints/${endpoint.id}/deliveries`);
    expect(((await log.json()) as { items: unknown[] }).items[0]).toMatchObject({
      status: 'refused',
      verified: false,
      error: 'Wrong token',
    });
    const replay = await call('POST', `/endpoints/${endpoint.id}/deliveries/${row!.id}/replay`);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: 'NOT_REPLAYABLE' });

    // The sender's corrected retry of the same body is a new delivery, not a repeat.
    const retried = await hook(url, { body: '{"pad":"x"}', headers: bearer(token) });
    const first = await hook(url, { body: '{"pad":"y"}', headers: bearer('whk_wrong') });
    expect(first.status).toBe(401);
    const corrected = await hook(url, { body: '{"pad":"y"}', headers: bearer(token) });
    expect(retried.status).toBe(202);
    expect(await corrected.json()).not.toHaveProperty('duplicate');
  });

  it('believes X-Forwarded-For from a trusted proxy, right to left', async () => {
    const { bot } = await newBot('Proxied');
    const { endpoint, token } = await newEndpoint(bot.id, {
      slug: 'proxied',
      allowedIps: ['203.0.113.0/24'],
    });
    const url = `/hooks/${bot.id}/proxied`;
    const send = async (forwardedFor: string, peer: string) => {
      const res = await hook(url, {
        body: JSON.stringify({ forwardedFor, peer }),
        headers: { ...bearer(token), 'x-forwarded-for': forwardedFor },
        peer,
      });
      return res.status;
    };
    const { config } = t.ownerDeps;
    config.trustedProxies = ['172.16.0.0/12'];
    try {
      // The tunnel appended the client's real address; the left hop is forged.
      expect(await send('203.0.113.5, 198.51.100.9', '172.18.0.4')).toBe(403);
      expect(await send('198.51.100.9, 203.0.113.5', '172.18.0.4')).toBe(202);
      // Trusted hops are skipped.
      expect(await send('203.0.113.6, 172.18.0.9', '172.18.0.4')).toBe(202);
      // From a peer that is not a trusted proxy the header means nothing.
      expect(await send('203.0.113.5', '198.51.100.9')).toBe(403);
    } finally {
      config.trustedProxies = [];
    }
    const stored = (await deliveriesOf(endpoint.id)).map((d) => d.remoteIp).sort();
    expect(stored).toEqual(['203.0.113.5', '203.0.113.6']);
  });

  it('rate-limits verified deliveries per endpoint, failures per endpoint and address, with Retry-After', async () => {
    const { bot } = await newBot('Limited');
    const { endpoint, token } = await newEndpoint(bot.id, { slug: 'limited', rateLimitPerMin: 2 });
    const url = `/hooks/${bot.id}/limited`;
    const send = (
      body: string,
      headers: Record<string, string> = bearer(token),
      peer = '192.0.2.10',
    ) => hook(url, { body, headers, peer });
    const wrong = { authorization: 'Bearer whk_wrong' };

    // Failed verifications have their own bucket per endpoint and address.
    for (let i = 0; i < DEFAULT_LIMITS.webhookFailedAuthPerMin; i++) {
      expect((await send(`{"bad":${i}}`, wrong)).status).toBe(401);
    }
    const locked = await send('{"bad":"more"}', wrong);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await send('{"bad":"elsewhere"}', wrong, '192.0.2.13')).status).toBe(401);

    // They did not spend the endpoint's two a minute, which only verified requests use.
    expect((await send('{"a":1}')).status).toBe(202);
    expect((await send('{"a":2}')).status).toBe(202);
    const limited = await send('{"a":3}');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await limited.json()) as unknown).toMatchObject({ code: 'RATE_LIMITED' });
    expect(await deliveriesOf(endpoint.id)).toHaveLength(2);

    // An address that used up its bucket is refused before any lookup, even
    // for a Bot that does not exist. The bucket refills a token every 100ms,
    // so drain it until refused rather than a fixed count: on a loaded
    // machine the drain itself outlasts a refill.
    const rule = { window: 60, max: DEFAULT_LIMITS.webhookIpRatePerMin };
    while ((await t.deps.infra.limiter.consume('hook-ip:192.0.2.11', rule)).allowed);
    const flood = await hook('/hooks/nobody', { body: '{}', peer: '192.0.2.11' });
    expect(flood.status).toBe(429);
    expect((await hook('/hooks/nobody', { body: '{}', peer: '192.0.2.12' })).status).toBe(404);
  });

  it("takes the webhook rates from the limits, the admin's over the environment's", async () => {
    const { bot } = await newBot('Tuned');
    const { token } = await newEndpoint(bot.id, { slug: 'tuned' });
    const url = `/hooks/${bot.id}/tuned`;
    const { config } = t.ownerDeps;
    const limits = config.limits;
    config.limits = { ...limits, webhookEndpointRatePerMin: 1, webhookIpRatePerMin: 3 };
    const workspace = await ensureWorkspace(t.db);
    await updateSettings(t.db, workspace, { limits: { webhookFailedAuthPerMin: 2 } });
    try {
      // An endpoint without its own rate limit gets webhookEndpointRatePerMin.
      expect((await hook(url, { body: '{"t":1}', headers: bearer(token) })).status).toBe(202);
      expect((await hook(url, { body: '{"t":2}', headers: bearer(token) })).status).toBe(429);
      // The admin's webhookFailedAuthPerMin.
      const wrong = { body: '{}', headers: bearer('whk_wrong'), peer: '192.0.2.40' };
      expect((await hook(url, wrong)).status).toBe(401);
      expect((await hook(url, wrong)).status).toBe(401);
      expect((await hook(url, wrong)).status).toBe(429);
      // webhookIpRatePerMin, before any lookup.
      const stranger = { body: '{}', peer: '192.0.2.41' };
      for (let i = 0; i < 3; i++) expect((await hook('/hooks/nobody', stranger)).status).toBe(404);
      expect((await hook('/hooks/nobody', stranger)).status).toBe(429);
    } finally {
      config.limits = limits;
      await t.db
        .update(schema.workspaces)
        .set({ settings: workspace.settings })
        .where(eq(schema.workspaces.id, workspace.id));
    }
  });

  it('verifies the HMAC preset and rejects a bad or missing signature', async () => {
    const { bot } = await newBot('Signed');
    const { endpoint, signingSecret } = await newEndpoint(bot.id, {
      slug: 'gh',
      signature: { preset: 'github' },
    });
    expect(signingSecret).toMatch(/^[0-9a-f]{64}$/);
    const url = `/hooks/${bot.id}/gh`;
    const body = JSON.stringify({ action: 'opened', zen: 'x' });
    const headers = { 'x-github-event': 'issues' };
    expect((await hook(url, { body, headers })).status).toBe(401);
    expect(
      (
        await hook(url, {
          body,
          headers: { ...headers, 'x-hub-signature-256': hubSignature('nope', body) },
        })
      ).status,
    ).toBe(401);
    const res = await hook(url, {
      body,
      headers: { ...headers, 'x-hub-signature-256': hubSignature(signingSecret!, body) },
    });
    expect(res.status).toBe(202);
    expect(await deliveriesOf(endpoint.id)).toHaveLength(1);
    // Both failures are in the log, with the signature that was sent, so a wrong secret shows (H5).
    const refused = await refusalsOf(endpoint.id);
    expect(refused).toHaveLength(2);
    const signed = refused.find(
      (r) => (r.headers as Record<string, string>)['x-hub-signature-256'],
    );
    expect(signed).toMatchObject({ verified: false, bodyPreview: body });
    expect(signed!.error).toBeTruthy();
    // The listing shows the preset and that a secret is set, never the secret.
    const list = await (await call('GET', `/bots/${bot.id}/endpoints`)).text();
    expect(list).toContain('"hasSecret":true');
    expect(list).not.toContain(signingSecret!);
  });

  it('answers handshakes without storing a delivery or starting a run', async () => {
    const { bot } = await newBot('Shaker');
    const slackSecret = 'slack-signing-secret';
    const slack = await newEndpoint(bot.id, {
      slug: 'slack',
      signature: { preset: 'slack', secret: slackSecret },
    });
    const body = JSON.stringify({ type: 'url_verification', challenge: 'c-123', token: 'x' });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac('sha256', slackSecret).update(`v0:${ts}:${body}`).digest('hex')}`;
    const res = await hook(`/hooks/${bot.id}/slack`, {
      body,
      headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'c-123' });

    const inbox = await newEndpoint(bot.id);
    const echo = await hook(`/hooks/${bot.id}`, {
      body: '{"challenge":"abc"}',
      headers: bearer(inbox.token),
    });
    expect(await echo.json()).toEqual({ challenge: 'abc' });
    const get = await hook(`/hooks/${bot.id}/${inbox.token}?challenge=xyz`, { method: 'GET' });
    expect(await get.text()).toBe('xyz');
    const ping = await hook(`/hooks/${bot.id}`, {
      body: '{"zen":"Keep it logically awesome."}',
      headers: { ...bearer(inbox.token), 'x-github-event': 'ping' },
    });
    expect(await ping.json()).toEqual({ ok: true });

    expect(await deliveriesOf(slack.endpoint.id)).toHaveLength(0);
    expect(await deliveriesOf(inbox.endpoint.id)).toHaveLength(0);
    expect(await runsOf(bot.id)).toHaveLength(0);
  });

  it('answers a repeat within 10 minutes once, by Idempotency-Key or body', async () => {
    const { bot } = await newBot('Idem');
    const { endpoint, token } = await newEndpoint(bot.id);
    const url = `/hooks/${bot.id}`;
    const first = await hook(url, {
      body: '{"order":1}',
      headers: { ...bearer(token), 'idempotency-key': 'order-1' },
    });
    expect(first.status).toBe(202);
    const { delivery_id, run_id } = (await first.json()) as Record<string, string>;
    // Same key, different body (a sender's retry may re-serialize): the same delivery.
    const again = await hook(url, {
      body: '{"order": 1}',
      headers: { ...bearer(token), 'idempotency-key': 'order-1' },
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ delivery_id, run_id, duplicate: true });
    // No key: the body hash is the key.
    const a = (await (
      await hook(url, { body: '{"x":1}', headers: bearer(token) })
    ).json()) as Record<string, unknown>;
    const b = (await (
      await hook(url, { body: '{"x":1}', headers: bearer(token) })
    ).json()) as Record<string, unknown>;
    expect(b).toMatchObject({ delivery_id: a['delivery_id'], duplicate: true });
    const c = await hook(url, { body: '{"x":2}', headers: bearer(token) });
    expect(c.status).toBe(202);
    expect(await deliveriesOf(endpoint.id)).toHaveLength(3);
    expect(await runsOf(bot.id)).toHaveLength(3);
  });

  it('exit criterion: a script hits the inbox and gets a sync reply', async () => {
    const { bot, model } = await newBot('Oracle', [[{ text: 'The build is green.' }]]);
    const { token } = await newEndpoint(bot.id, { responseMode: 'sync', syncTimeoutS: 10 });
    const res = await hook(`/hooks/${bot.id}`, {
      body: JSON.stringify({ question: 'Is the build green?' }),
      headers: bearer(token),
    });
    expect(res.status).toBe(200);
    const reply = (await res.json()) as Record<string, unknown>;
    expect(reply).toMatchObject({ status: 'completed', text: 'The build is green.' });
    const [run] = await runsOf(bot.id);
    expect(reply['run_id']).toBe(run!.id);
    expect(promptText(model.calls[0]!)).toContain('Is the build green?');
  });

  it('times out a sync delivery cleanly and lets the run finish', async () => {
    // Every chunk of the reply is held back, so it takes a few seconds in all.
    const { bot } = await newBot('Slowpoke', [[{ text: 'Done eventually.' }]], undefined, 500);
    const { token } = await newEndpoint(bot.id, { responseMode: 'sync', syncTimeoutS: 1 });
    const started = Date.now();
    const res = await hook(`/hooks/${bot.id}`, { body: '{"q":1}', headers: bearer(token) });
    expect(res.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(2_500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'running', text: null, timed_out: true });
    await vi.waitFor(async () => expect((await runsOf(bot.id))[0]?.status).toBe('completed'), {
      timeout: 10_000,
      interval: 50,
    });
  }, 15_000);

  it('waits up to 60 seconds by default and reports the wait it uses (H4)', async () => {
    const { bot } = await newBot('Patient');
    const inbox = await inboxOf(bot.id);
    const waitOf = async (body: Record<string, unknown>) => {
      const res = await call('PATCH', `/endpoints/${inbox.id}`, body);
      expect(res.status).toBe(200);
      return ((await res.json()) as { endpoint: { syncWaitS: number } }).endpoint.syncWaitS;
    };
    expect(syncWaitSeconds({ syncTimeoutS: null }, DEFAULT_LIMITS.syncWebhookWaitSeconds)).toBe(60);
    expect(await waitOf({ responseMode: 'sync', syncTimeoutS: null })).toBe(60);
    expect(await waitOf({ syncTimeoutS: 15 })).toBe(15);
    // The admin's sync webhook wait caps every endpoint's.
    const workspace = await ensureWorkspace(t.db);
    await updateSettings(t.db, workspace, { limits: { syncWebhookWaitSeconds: 10 } });
    try {
      expect(await waitOf({ syncTimeoutS: null })).toBe(10);
      const listed = await call('GET', `/bots/${bot.id}/endpoints`);
      expect(await listed.json()).toMatchObject({ items: [{ syncWaitS: 10 }] });
    } finally {
      await t.db
        .update(schema.workspaces)
        .set({ settings: workspace.settings })
        .where(eq(schema.workspaces.id, workspace.id));
    }
  });

  it('runs under the endpoint override and the stricter webhook default', async () => {
    const turns: ScriptedTurn[] = [
      [{ tool: 'bash', args: { command: 'rm -rf build' } }],
      [{ text: 'Could not.' }],
    ];
    // The Bot lifts the webhook default and allows bash; the endpoint denies it again.
    const { bot, model } = await newBot('Locked', turns, {
      tools: { bash: 'auto' },
      triggers: { webhook: { default: 'auto' } },
    });
    const { token } = await newEndpoint(bot.id, {
      toolPolicyOverride: { tools: { bash: 'deny' } },
    });
    await hook(`/hooks/${bot.id}`, { body: '{"cmd":"clean"}', headers: bearer(token) });
    await until(async () => expect((await runsOf(bot.id))[0]?.status).toBe('completed'));
    expect(executed).not.toContain('rm -rf build');
    expect(promptText(model.calls[1]!)).toContain('Denied by Bot policy');

    // Without lifting the default, a webhook run asks before bash; a sync caller hears "waiting".
    const asks = await newBot('Careful', [[{ tool: 'bash', args: { command: 'make' } }]], {
      tools: { bash: 'auto' },
    });
    const sync = await newEndpoint(asks.bot.id, { responseMode: 'sync', syncTimeoutS: 10 });
    const res = await hook(`/hooks/${asks.bot.id}`, {
      body: '{"cmd":"make"}',
      headers: bearer(sync.token),
    });
    expect(await res.json()).toMatchObject({ status: 'waiting' });
    expect(executed).not.toContain('make');
  });

  it('holds a Routine run a webhook started to the webhook default too', async () => {
    const { bot } = await newBot('Routed', [[{ tool: 'bash', args: { command: 'deploy' } }]], {
      tools: { bash: 'auto' },
    });
    const routineRes = await call('POST', `/bots/${bot.id}/routines`, {
      name: 'On deploy hook',
      prompt: 'Deploy what the payload names.',
      trigger: { type: 'event', source: 'webhook' },
    });
    const routine = (await routineRes.json()) as { id: string; slug: string };
    const { token } = await newEndpoint(bot.id, { routineId: routine.id });
    const res = await hook(`/hooks/${bot.id}/${routine.slug}`, {
      body: '{"target":"prod"}',
      headers: bearer(token),
    });
    expect(res.status).toBe(202);
    // The run is a Routine run, but it acts on webhook data: bash asks first.
    await until(async () => expect((await runsOf(bot.id))[0]?.status).toBe('waiting'));
    expect((await runsOf(bot.id))[0]).toMatchObject({ trigger: 'routine' });
    expect(executed).not.toContain('deploy');
  });

  it('makes an event Routine with its own endpoint, without a token until generated (R2, H2)', async () => {
    const { bot } = await newBot('Listener', [[{ text: 'heard' }]]);
    const routine = async (name: string, trigger: unknown) => {
      const res = await call('POST', `/bots/${bot.id}/routines`, {
        name,
        prompt: 'Handle it.',
        trigger,
      });
      expect(res.status).toBe(201);
      return (await res.json()) as {
        id: string;
        slug: string;
        trigger: { type: string; endpoint_id?: string | null };
      };
    };
    const listed = async () =>
      (
        (await (await call('GET', `/bots/${bot.id}/endpoints`)).json()) as {
          items: { id: string; slug: string; routineId: string | null; hasToken: boolean }[];
        }
      ).items;

    const created = await routine('On order', { type: 'event', source: 'webhook' });
    const endpoint = (await listed()).find((e) => e.routineId === created.id)!;
    expect(endpoint).toMatchObject({ slug: created.slug, hasToken: false });
    expect(created.trigger.endpoint_id).toBe(endpoint.id);
    const url = `/hooks/${bot.id}/${created.slug}`;
    // Like the inbox, it refuses deliveries until the owner generates its token.
    expect((await hook(url, { body: '{"n":1}', headers: bearer('whk_guess') })).status).toBe(401);
    const { token } = (await (await call('POST', `/endpoints/${endpoint.id}/rotate`)).json()) as {
      token: string;
    };
    expect((await hook(url, { body: '{"n":2}', headers: bearer(token) })).status).toBe(202);
    const [audited] = await t.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'webhook.create'),
          eq(schema.auditLog.targetId, endpoint.id),
        ),
      );
    expect(audited?.metadata).toMatchObject({ routineId: created.id });

    // A Routine whose slug another endpoint has gets the next free one.
    const inboxNamed = await routine('Inbox', { type: 'event', source: 'webhook' });
    expect((await listed()).find((e) => e.routineId === inboxNamed.id)!.slug).toBe('inbox-2');

    // A schedule Routine has none until it switches to an event, then it gets one, once.
    const daily = { type: 'schedule', preset: { kind: 'daily', time: '09:00' } };
    const switched = await routine('Later', daily);
    expect((await listed()).some((e) => e.routineId === switched.id)).toBe(false);
    const toEvent = async () =>
      expect(
        (
          await call('PATCH', `/routines/${switched.id}`, {
            trigger: { type: 'event', source: 'webhook' },
          })
        ).status,
      ).toBe(200);
    await toEvent();
    const own = (await listed()).filter((e) => e.routineId === switched.id);
    expect(own).toHaveLength(1);
    await call('PATCH', `/routines/${switched.id}`, { trigger: daily });
    await toEvent();
    expect((await listed()).filter((e) => e.routineId === switched.id)).toEqual(own);
  });

  it('starts no run for an event when the Routine’s Skill was turned off for the Bot (S2)', async () => {
    const { bot, model } = await newBot('Drafty', [[{ text: 'ran' }]]);
    const res = await call('POST', '/skills', { name: 'Triage', content: 'Alerts.\n\n1. Look' });
    const skill = (await res.json()) as { id: string };
    await call('PUT', `/bots/${bot.id}/skills`, { skillIds: [skill.id] });
    const created = await call('POST', `/bots/${bot.id}/routines`, {
      name: 'On alert',
      skillId: skill.id,
      trigger: { type: 'event', source: 'webhook' },
    });
    expect(created.status).toBe(201);
    const routine = (await created.json()) as { id: string; slug: string };
    const { endpoint, token } = await newEndpoint(bot.id, { routineId: routine.id });
    await call('PUT', `/bots/${bot.id}/skills`, { skillIds: [] });
    const sent = await hook(`/hooks/${bot.id}/${routine.slug}`, {
      body: '{"alert":1}',
      headers: bearer(token),
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ run_id: null });
    expect(await deliveriesOf(endpoint.id)).toMatchObject([
      {
        status: 'ignored',
        matched: true,
        error: expect.stringContaining('is not enabled for this Bot'),
      },
    ]);
    expect(await runsOf(bot.id)).toHaveLength(0);
    expect(model.calls).toHaveLength(0);
    const events = (await messagesOf(bot.chatId)).flatMap((m) =>
      (m.parts as MessagePart[]).filter((p) => p.type === 'event'),
    );
    expect(events).toMatchObject([{ kind: 'routine_skipped' }]);
  });

  it('turns a Routine endpoint off when the trigger stops being an event, and refuses stale ones', async () => {
    const { bot } = await newBot('Switcher', [[{ text: 'one' }], [{ text: 'two' }]]);
    const created = await call('POST', `/bots/${bot.id}/routines`, {
      name: 'On deploy',
      prompt: 'Summarize the deploy.',
      trigger: { type: 'event', source: 'webhook' },
    });
    const routine = (await created.json()) as { id: string; slug: string };
    const { endpoint, token } = await newEndpoint(bot.id, { routineId: routine.id });
    let n = 0;
    const send = () =>
      hook(`/hooks/${bot.id}/${routine.slug}`, {
        body: JSON.stringify({ n: ++n }),
        headers: bearer(token),
      });
    const edit = async (body: unknown) =>
      expect((await call('PATCH', `/routines/${routine.id}`, body)).status).toBe(200);
    const stored = async () => {
      const [row] = await t.db
        .select()
        .from(schema.webhookEndpoints)
        .where(eq(schema.webhookEndpoints.id, endpoint.id));
      const [r] = await t.db
        .select()
        .from(schema.routines)
        .where(eq(schema.routines.id, routine.id));
      return { enabled: row!.enabled, trigger: r!.trigger };
    };
    const daily = { type: 'schedule', preset: { kind: 'daily', time: '09:00' } };
    expect((await send()).status).toBe(202);

    // A schedule turns the endpoint off: its URL is gone.
    await edit({ trigger: daily });
    expect(await stored()).toMatchObject({ enabled: false });
    expect((await send()).status).toBe(404);

    // Back to an event: on again, and the trigger points at it.
    await edit({ trigger: { type: 'event', source: 'webhook' } });
    expect(await stored()).toMatchObject({
      enabled: true,
      trigger: { type: 'event', endpoint_id: endpoint.id },
    });
    expect((await send()).status).toBe(202);
    await until(async () => expect(await runsOf(bot.id)).toHaveLength(2));

    // A paused Routine refuses, and so does an endpoint left on for a schedule Routine.
    await edit({ enabled: false });
    const paused = await send();
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ run_id: null, matched: false });
    await edit({ enabled: true, trigger: daily });
    await t.db
      .update(schema.webhookEndpoints)
      .set({ enabled: true })
      .where(eq(schema.webhookEndpoints.id, endpoint.id));
    expect((await send()).status).toBe(200);
    const refused = (await deliveriesOf(endpoint.id))
      .filter((d) => d.status === 'ignored')
      .map((d) => d.error)
      .sort();
    expect(refused).toEqual([
      'The Routine is paused',
      'The Routine no longer has an event trigger',
    ]);
    expect(await runsOf(bot.id)).toHaveLength(2);
  });

  it('turns back on only what a trigger switch turned off, scoped to the named endpoint', async () => {
    const { bot } = await newBot('Picky', [[{ text: 'ok' }]]);
    const created = await call('POST', `/bots/${bot.id}/routines`, {
      name: 'On alert',
      prompt: 'Triage the alert.',
      trigger: { type: 'event', source: 'webhook' },
    });
    const routine = (await created.json()) as { id: string; slug: string };
    const a = await newEndpoint(bot.id, { routineId: routine.id });
    const b = await newEndpoint(bot.id, { routineId: routine.id, slug: 'second' });
    const edit = async (path: string, body: unknown) =>
      expect((await call('PATCH', path, body)).status).toBe(200);
    const states = async () =>
      Object.fromEntries(
        (
          await t.db
            .select()
            .from(schema.webhookEndpoints)
            .where(eq(schema.webhookEndpoints.routineId, routine.id))
        ).map((e) => [e.id === a.endpoint.id ? 'a' : 'b', [e.enabled, e.disabledReason]]),
      );
    const daily = { type: 'schedule', preset: { kind: 'daily', time: '09:00' } };
    const event = { type: 'event', source: 'webhook' };

    // The owner turns A off; a switch to a schedule and back leaves it off.
    await edit(`/endpoints/${a.endpoint.id}`, { enabled: false });
    await edit(`/routines/${routine.id}`, { trigger: daily });
    expect(await states()).toEqual({ a: [false, 'owner'], b: [false, 'trigger_switch'] });
    await edit(`/routines/${routine.id}`, { trigger: event });
    expect(await states()).toEqual({ a: [false, 'owner'], b: [true, null] });
    const [linked] = await t.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, routine.id));
    expect(linked!.trigger).toMatchObject({ endpoint_id: b.endpoint.id });

    // The trigger names B, so a delivery to A (turned on again) is refused.
    await edit(`/endpoints/${a.endpoint.id}`, { enabled: true });
    const other = await hook(`/hooks/${bot.id}/${routine.slug}`, {
      body: '{"x":1}',
      headers: bearer(a.token),
    });
    expect(await other.json()).toMatchObject({ run_id: null, matched: false });
    const [refused] = await deliveriesOf(a.endpoint.id);
    expect(refused).toMatchObject({
      status: 'ignored',
      error: 'The Routine waits on another endpoint',
    });
    expect(
      (await hook(`/hooks/${bot.id}/second`, { body: '{"x":2}', headers: bearer(b.token) })).status,
    ).toBe(202);

    // Switching back with a named endpoint turns on only that one.
    await edit(`/routines/${routine.id}`, { trigger: daily });
    expect(await states()).toEqual({ a: [false, 'trigger_switch'], b: [false, 'trigger_switch'] });
    await edit(`/routines/${routine.id}`, { trigger: { ...event, endpoint_id: a.endpoint.id } });
    expect(await states()).toEqual({ a: [true, null], b: [false, 'trigger_switch'] });

    // Each automatic change is audited as the owner's, with the reason.
    const switches = await t.db
      .select({ targetId: schema.auditLog.targetId, metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'webhook.update'));
    const reasons = switches
      .filter(
        (r) =>
          [a.endpoint.id, b.endpoint.id].includes(r.targetId!) &&
          (r.metadata as { reason?: string }).reason === 'trigger_switch',
      )
      .map((r) => [
        r.targetId === a.endpoint.id ? 'a' : 'b',
        (r.metadata as { enabled: boolean }).enabled,
      ]);
    expect(reasons.sort()).toEqual(
      [
        ['a', false],
        ['a', true],
        ['b', false],
        ['b', false],
        ['b', true],
      ].sort(),
    );
  });

  it("gives a duplicated event Routine no endpoint, not the source Bot's (B5)", async () => {
    const { bot } = await newBot('Forked', [[{ text: 'source' }]]);
    const created = await call('POST', `/bots/${bot.id}/routines`, {
      name: 'On alert',
      prompt: 'Look at the alert.',
      trigger: { type: 'event', source: 'webhook' },
    });
    const routine = (await created.json()) as { id: string; slug: string };
    const { endpoint, token } = await newEndpoint(bot.id, { routineId: routine.id });

    const copy = (await (await call('POST', `/bots/${bot.id}/duplicate`)).json()) as Bot;
    models.set(copy.id, {
      model: scriptedModel([[{ text: 'copy' }]]),
      info: null,
      providerOptions: {},
    });
    const [copied] = await t.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.botId, copy.id));
    expect(copied).toMatchObject({
      slug: routine.slug,
      trigger: { type: 'event', source: 'webhook', endpoint_id: null },
    });
    // The copy has only its own inbox; the source's endpoint still starts the source's Routine.
    const listed = (await (await call('GET', `/bots/${copy.id}/endpoints`)).json()) as {
      items: { slug: string; routineId: string | null }[];
    };
    expect(listed.items.map((e) => [e.slug, e.routineId])).toEqual([['inbox', null]]);
    expect(
      (
        await hook(`/hooks/${copy.id}/${routine.slug}`, {
          body: '{"n":1}',
          headers: bearer(token),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await hook(`/hooks/${bot.id}/${routine.slug}`, {
          body: '{"n":2}',
          headers: bearer(token),
        })
      ).status,
    ).toBe(202);
    await until(async () => expect((await runsOf(bot.id))[0]?.status).toBe('completed'));

    // Saving the copy's trigger as stored works (a source endpoint id would be 404).
    expect(
      (await call('PATCH', `/routines/${copied!.id}`, { trigger: copied!.trigger })).status,
    ).toBe(200);
    // Its own endpoint, once added, starts the copy's Routine and not the source's.
    const own = await newEndpoint(copy.id, { routineId: copied!.id });
    expect(own.endpoint.id).not.toBe(endpoint.id);
    expect(
      (
        await hook(`/hooks/${copy.id}/${routine.slug}`, {
          body: '{"n":3}',
          headers: bearer(own.token),
        })
      ).status,
    ).toBe(202);
    await until(async () => expect((await runsOf(copy.id))[0]?.status).toBe('completed'));
    expect(await runsOf(bot.id)).toHaveLength(1);
    expect(await runsOf(copy.id)).toMatchObject([{ trigger: 'routine' }]);
  });

  it('exit criterion: a GitHub PR event triggers a review Routine run', async () => {
    const { bot, model } = await newBot('Reviewer', [[{ text: 'Reviewed: looks good.' }]]);
    const routineRes = await call('POST', `/bots/${bot.id}/routines`, {
      name: 'PR review',
      prompt: 'Review the pull request and comment on risky changes.',
      trigger: { type: 'event', source: 'github' },
    });
    expect(routineRes.status).toBe(201);
    const routine = (await routineRes.json()) as { id: string; slug: string };
    const { endpoint, signingSecret } = await newEndpoint(bot.id, {
      routineId: routine.id,
      signature: { preset: 'github' },
      match: { source: 'github', event: 'pr_opened', repo: 'acme/*' },
      template:
        'PR #{{number}} "{{pull_request.title}}" opened in {{repository.full_name}}\n\n{{json}}',
    });
    expect(endpoint.slug).toBe(routine.slug);
    // The Routine's trigger now points at its endpoint.
    const [stored] = await t.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, routine.id));
    expect(stored!.trigger).toMatchObject({
      type: 'event',
      source: 'github',
      endpoint_id: endpoint.id,
    });

    const send = (event: string, payload: unknown) => {
      const body = JSON.stringify(payload);
      return hook(`/hooks/${bot.id}/${routine.slug}`, {
        body,
        headers: {
          'x-github-event': event,
          'x-github-delivery': randomUUID(),
          'x-hub-signature-256': hubSignature(signingSecret!, body),
        },
      });
    };
    const pr = {
      action: 'opened',
      number: 42,
      pull_request: { title: 'Add retries', merged: false },
      repository: { full_name: 'acme/api' },
    };
    // A push, or a PR in another owner's repository, is not what the Routine waits for.
    const push = await send('push', {
      ref: 'refs/heads/main',
      repository: { full_name: 'acme/api' },
    });
    expect(push.status).toBe(200);
    expect(await push.json()).toMatchObject({ run_id: null, matched: false });
    expect(
      (await send('pull_request', { ...pr, repository: { full_name: 'evil/api' } })).status,
    ).toBe(200);
    expect(await runsOf(bot.id)).toHaveLength(0);

    const res = await send('pull_request', pr);
    expect(res.status).toBe(202);
    const { run_id } = (await res.json()) as { run_id: string };
    const [run] = await runsOf(bot.id);
    expect(run).toMatchObject({ id: run_id, trigger: 'routine', priority: 3 });
    const [record] = await t.db
      .select()
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.routineId, routine.id));
    expect(record).toMatchObject({ runId: run_id, reason: 'event' });

    await until(async () => expect((await runsOf(bot.id))[0]?.status).toBe('completed'));
    const prompt = promptText(model.calls[0]!);
    expect(prompt).toContain('PR #42 "Add retries" opened in acme/api');
    expect(prompt).toContain('Review the pull request and comment on risky changes.');
    await until(async () => {
      const [done] = await t.db
        .select()
        .from(schema.routineRuns)
        .where(eq(schema.routineRuns.id, record!.id));
      expect(done).toMatchObject({ status: 'completed' });
    });
    const posted = await messagesOf(bot.chatId, 'routine');
    expect((posted.at(-1)!.parts as MessagePart[])[0]).toMatchObject({ kind: 'routine_run' });

    const deliveries = await deliveriesOf(endpoint.id);
    expect(deliveries.map((d) => d.status).sort()).toEqual(['ignored', 'ignored', 'queued']);
  });

  it('matches nothing on a corrupt stored trigger rule and records it on the delivery', async () => {
    const { bot } = await newBot('Corrupt', [[{ text: 'ran' }]]);
    const routineRes = await call('POST', `/bots/${bot.id}/routines`, {
      name: 'Deploys',
      prompt: 'Report the deploy.',
      trigger: {
        type: 'event',
        source: 'webhook',
        match: { conditions: [{ path: 'kind', op: 'equals', value: 'deploy' }] },
      },
    });
    expect(routineRes.status).toBe(201);
    const routine = (await routineRes.json()) as { id: string; slug: string };
    const { endpoint, token } = await newEndpoint(bot.id, { routineId: routine.id });
    const [stored] = await t.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, routine.id));
    const setMatch = (match: unknown) =>
      t.db
        .update(schema.routines)
        .set({ trigger: { ...(stored!.trigger as object), match } })
        .where(eq(schema.routines.id, routine.id));
    const send = (n: number) =>
      hook(`/hooks/${bot.id}/${routine.slug}`, {
        body: JSON.stringify({ kind: 'deploy', n }),
        headers: bearer(token),
      });

    // A rule that no longer parses matches nothing, rather than everything.
    await setMatch({ conditions: 'kind is deploy' });
    const res = await send(1);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ run_id: null, matched: false });
    expect(await runsOf(bot.id)).toHaveLength(0);
    const [delivery] = await deliveriesOf(endpoint.id);
    expect(delivery).toMatchObject({ status: 'ignored', matched: false, runId: null });
    expect(delivery!.error).toContain('matching rule is invalid');

    // No rule at all still matches every delivery.
    await setMatch(undefined);
    const open = await send(2);
    expect(open.status).toBe(202);
    await until(async () => expect((await runsOf(bot.id))[0]?.status).toBe('completed'));
  });

  it('replays a logged delivery and runs the test form through matching', async () => {
    const { bot } = await newBot('Replayer', [
      [{ text: 'one' }],
      [{ text: 'two' }],
      [{ text: 'three' }],
    ]);
    const { endpoint, token } = await newEndpoint(bot.id, {
      match: { source: 'webhook', conditions: [{ path: 'kind', op: 'equals', value: 'deploy' }] },
    });
    const first = await hook(`/hooks/${bot.id}`, {
      body: '{"kind":"deploy","sha":"abc"}',
      headers: bearer(token),
    });
    const { delivery_id } = (await first.json()) as { delivery_id: string };
    await until(async () => expect((await runsOf(bot.id))[0]?.status).toBe('completed'));

    const replay = await call('POST', `/endpoints/${endpoint.id}/deliveries/${delivery_id}/replay`);
    expect(replay.status).toBe(201);
    const replayed = (await replay.json()) as { delivery: Record<string, unknown>; runId: string };
    expect(replayed.delivery).toMatchObject({
      origin: 'replay',
      replayOf: delivery_id,
      verified: true,
      status: 'queued',
    });
    expect(replayed.runId).toBeTruthy();
    await until(async () =>
      expect((await runsOf(bot.id)).map((r) => r.status)).toEqual(['completed', 'completed']),
    );

    const miss = await call('POST', `/endpoints/${endpoint.id}/test`, {
      payload: { kind: 'other' },
    });
    expect(await miss.json()).toMatchObject({
      delivery: { origin: 'test', verified: false, matched: false, status: 'ignored' },
      runId: null,
    });
    const hit = await call('POST', `/endpoints/${endpoint.id}/test`, {
      payload: { kind: 'deploy' },
    });
    const tested = (await hit.json()) as { delivery: { id: string }; runId: string };
    expect(tested.runId).toBeTruthy();
    // The test event is framed as unverified.
    await until(async () => expect(await runsOf(bot.id)).toHaveLength(3));
    const webhookMessages = await messagesOf(bot.chatId, 'webhook');
    expect(JSON.stringify(webhookMessages.at(-1)!.parts)).toContain('verified=\\"false\\"');

    const log = (await (await call('GET', `/endpoints/${endpoint.id}/deliveries`)).json()) as {
      items: { origin: string }[];
    };
    expect(log.items.map((d) => d.origin)).toEqual(['test', 'test', 'replay', 'ingress']);
  });

  it('gives every Bot an inbox that refuses deliveries until its token is generated (H1)', async () => {
    const { bot } = await newBot('Fresh');
    const inbox = await inboxOf(bot.id);
    expect(inbox).toMatchObject({
      url: `http://localhost:3000/hooks/${bot.id}`,
      hasToken: false,
    });
    const before = await hook(`/hooks/${bot.id}`, {
      body: '{"a":1}',
      headers: bearer('whk_guess'),
    });
    expect(before.status).toBe(401);
    expect(await before.json()).toMatchObject({ title: 'This endpoint has no token yet' });
    // Without a token, a signature preset does not open it either.
    const signed = await call('PATCH', `/endpoints/${inbox.id}`, {
      signature: { preset: 'github' },
    });
    const { signingSecret } = (await signed.json()) as { signingSecret: string };
    expect(
      (
        await hook(`/hooks/${bot.id}`, {
          body: '{"a":2}',
          headers: { 'x-hub-signature-256': hubSignature(signingSecret, '{"a":2}') },
        })
      ).status,
    ).toBe(401);
    expect(await deliveriesOf(inbox.id)).toHaveLength(0);

    const { token, endpoint } = await newEndpoint(bot.id);
    expect(endpoint).toMatchObject({ id: inbox.id, hasToken: true });
    expect(
      (
        await hook(`/hooks/${bot.id}`, {
          body: '{"a":3}',
          headers: {
            ...bearer(token),
            'x-hub-signature-256': hubSignature(signingSecret, '{"a":3}'),
          },
        })
      ).status,
    ).toBe(202);

    // A duplicate has its own inbox, without the source's token.
    const copy = (await (await call('POST', `/bots/${bot.id}/duplicate`)).json()) as Bot;
    const copied = await inboxOf(copy.id);
    expect(copied).toMatchObject({ hasToken: false });
    expect(copied.id).not.toBe(inbox.id);

    // A Bot from before inboxes came with it gets one when its endpoints are listed.
    await t.db.delete(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.botId, copy.id));
    expect(await inboxOf(copy.id)).toMatchObject({ hasToken: false });
  });

  it('manages endpoints: rotate, edit, delete, slugs and ownership', async () => {
    const { bot } = await newBot('Managed');
    const { endpoint, token } = await newEndpoint(bot.id);
    // A second inbox is a slug clash.
    expect((await call('POST', `/bots/${bot.id}/endpoints`, {})).status).toBe(409);
    expect((await call('POST', `/bots/${bot.id}/endpoints`, { slug: 'whk_x' })).status).toBe(400);
    expect(
      (
        await call('POST', `/bots/${bot.id}/endpoints`, {
          slug: 's',
          signature: { preset: 'stripe' },
        })
      ).status,
    ).toBe(400);
    // A Routine endpoint needs an event Routine of this Bot.
    expect(
      (await call('POST', `/bots/${bot.id}/endpoints`, { slug: 'r', routineId: randomUUID() }))
        .status,
    ).toBe(404);

    const rotated = await call('POST', `/endpoints/${endpoint.id}/rotate`);
    const { token: fresh } = (await rotated.json()) as { token: string };
    expect(fresh).not.toBe(token);
    expect(
      (await hook(`/hooks/${bot.id}`, { body: '{"r":1}', headers: bearer(token) })).status,
    ).toBe(401);
    expect(
      (await hook(`/hooks/${bot.id}`, { body: '{"r":2}', headers: bearer(fresh) })).status,
    ).toBe(202);

    const patched = await call('PATCH', `/endpoints/${endpoint.id}`, {
      responseMode: 'sync',
      syncTimeoutS: 5,
      rateLimitPerMin: 10,
    });
    expect(await patched.json()).toMatchObject({
      endpoint: { responseMode: 'sync', syncTimeoutS: 5, rateLimitPerMin: 10 },
    });
    expect((await call('PATCH', `/endpoints/${endpoint.id}`, { syncTimeoutS: 61 })).status).toBe(
      400,
    );
    // The inbox keeps its slug and cannot be deleted, only turned off.
    expect((await call('PATCH', `/endpoints/${endpoint.id}`, { slug: 'moved' })).status).toBe(409);
    const kept = await call('DELETE', `/endpoints/${endpoint.id}`);
    expect(kept.status).toBe(409);
    expect(await kept.json()).toMatchObject({ code: 'INBOX_REQUIRED' });

    const other = (await t.signUp('eve@example.com')).cookie!;
    expect((await call('GET', `/bots/${bot.id}/endpoints`, undefined, other)).status).toBe(404);
    expect(
      (await call('PATCH', `/endpoints/${endpoint.id}`, { enabled: false }, other)).status,
    ).toBe(404);
    expect(
      (await call('GET', `/endpoints/${endpoint.id}/deliveries`, undefined, other)).status,
    ).toBe(404);

    expect((await call('PATCH', `/endpoints/${endpoint.id}`, { enabled: false })).status).toBe(200);
    expect(
      (await hook(`/hooks/${bot.id}`, { body: '{"r":3}', headers: bearer(fresh) })).status,
    ).toBe(404);

    const extra = await newEndpoint(bot.id, { slug: 'extra' });
    expect((await call('DELETE', `/endpoints/${extra.endpoint.id}`)).status).toBe(204);
    expect(
      (await hook(`/hooks/${bot.id}/extra`, { body: '{"r":4}', headers: bearer(extra.token) }))
        .status,
    ).toBe(404);
    const actions = async (id: string) =>
      (
        await t.db
          .select({ action: schema.auditLog.action })
          .from(schema.auditLog)
          .where(eq(schema.auditLog.targetId, id))
      )
        .map((a) => a.action)
        .sort();
    expect(await actions(endpoint.id)).toEqual([
      'webhook.rotate',
      'webhook.rotate',
      'webhook.update',
      'webhook.update',
    ]);
    expect(await actions(extra.endpoint.id)).toEqual(['webhook.create', 'webhook.delete']);
  });
});
