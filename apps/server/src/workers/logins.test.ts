import { localEmbedder } from '@openbots/agent';
import { promptText, scriptedModel, type ScriptedTurn } from '@openbots/agent/testing';
import { EVENTS_CHANNEL, type MessagePart, type WsEvent } from '@openbots/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import { approvalTtlMs } from '../services/approvals.js';
import {
  expireDueLoginRequests,
  expireLoginRequest,
  LOGINS_QUEUE,
  registerLoginHooks,
  registrableDomain,
  resumeIfAnswered,
  type LoginExpireJob,
} from '../services/logins.js';
import { registerRunHooks, RUNS_QUEUE, type RunJob } from '../services/runs.js';
import { useTestComputer, type TestComputer } from '../test-computer.js';
import { createTestApp, isGreeting, type TestApp } from '../test-app.js';
import { createRunWorker, type RunModel, type RunWorkerOptions } from './runs.js';
import { inEveryOrganization } from '../workers.js';

// Sign-in requests end to end (K1, K8): a Bot calls request_login and waits.
// Without a main Bot the login_request widget is in its own transcript. With
// one, it is in the main Bot's transcript, authored by the main Bot, which
// starts no run; the asking Bot says so in their bot_to_bot chat (C6); a
// second Bot asking for the same site (by registrable domain) joins the
// request; Done syncs the computer's cookies and resumes every waiting run,
// Can't sign in tells them, and an unanswered request expires on the
// approvals' TTL, telling them too.

interface Bot {
  id: string;
  chatId: string;
  handle: string;
}

describe('request_login', () => {
  let t: TestApp;
  let computer: TestComputer;
  let cookie: string;
  const unhook: (() => void)[] = [];
  const events: WsEvent[] = [];
  const models = new Map<string, RunModel>();
  const options: RunWorkerOptions = {
    resolveModel: async (_config, bot) => models.get(bot.id)!,
    smallModel: async () => null,
    embedder: localEmbedder,
  };

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    computer = await useTestComputer(t.ownerDeps);
    cookie = (await t.signUp('dana@example.com')).cookie!;
    unhook.push(registerRunHooks(), registerLoginHooks());
    await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
    await t.deps.infra.queue<RunJob>(RUNS_QUEUE).process(createRunWorker(t.deps, options), {
      concurrency: 4,
    });
    // Running, so Done has a computer to sync.
    expect((await call('POST', '/computer/start')).status).toBe(200);
  });
  afterAll(async () => {
    for (const off of unhook) off();
    await computer.close();
    await t.close();
  });

  function call(method: string, path: string, body?: unknown) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });

  async function newBot(name: string, turns: ScriptedTurn[] = []) {
    const res = await call('POST', '/bots', {
      name,
      modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
    });
    expect(res.status).toBe(201);
    const bot = (await res.json()) as Bot & { isMain: boolean };
    // A Bot made while the owner has no main Bot becomes it (K8). These tests
    // start without one, until one marks it.
    if (bot.isMain) {
      expect((await call('PATCH', `/bots/${bot.id}`, { isMain: false })).status).toBe(200);
    }
    const model = scriptedModel(turns);
    models.set(bot.id, { model, info: null, providerOptions: {} });
    return { bot, model };
  }

  /** A Bot that asks for a sign-in to `site`, then says it carried on. */
  async function asker(name: string, site: string, reason = `Read ${site} for the owner`) {
    const made = await newBot(name, [
      [{ tool: 'request_login', args: { site, reason }, id: `login-${name}` }],
      [{ text: `${name} carried on.` }],
    ]);
    const res = await call('POST', `/chats/${made.bot.chatId}/messages`, { text: 'Go' });
    expect(res.status).toBe(201);
    const run = await runOf(made.bot.id, 'waiting');
    return { ...made, run };
  }

  const runsOf = (botId: string) =>
    t.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.botId, botId))
      .orderBy(asc(schema.runs.createdAt));

  const runOf = (botId: string, status: string) =>
    until(async () => {
      const [row] = await runsOf(botId);
      expect(row?.status).toBe(status);
      return row!;
    });

  const messagesIn = (chatId: string) =>
    t.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.chatId, chatId))
      .orderBy(asc(schema.messages.seq));

  /** The login_request widgets in a chat, with where they are. */
  async function requestsIn(chatId: string) {
    return (await messagesIn(chatId)).flatMap((m) =>
      (m.parts as MessagePart[]).flatMap((p, partIndex) =>
        p.type === 'widget' && p.kind === 'login_request'
          ? [{ message: m, partIndex, part: p }]
          : [],
      ),
    );
  }

  const widgetState = async (messageId: string, partIndex: number) =>
    (
      await t.db
        .select()
        .from(schema.widgetStates)
        .where(
          and(
            eq(schema.widgetStates.messageId, messageId),
            eq(schema.widgetStates.partIndex, partIndex),
          ),
        )
    )[0];

  const answer = (messageId: string, partIndex: number, type: 'done' | 'cant') =>
    call('POST', `/messages/${messageId}/widgets/${partIndex}/action`, { action: { type } });

  const lastState = (botId: string) => {
    const states = events
      .filter((e) => e.type === 'bot.state' && e.bot_id === botId)
      .map((e) => e.payload as { state: string; currentAction: string | null });
    return states.at(-1);
  };

  async function pairChat(a: Bot, b: Bot) {
    const chats = await t.db.select().from(schema.chats).where(eq(schema.chats.type, 'bot_to_bot'));
    return chats.find(
      (c) => [c.botId, c.peerBotId].includes(a.id) && [c.botId, c.peerBotId].includes(b.id),
    );
  }

  it('asks in its own transcript without a main Bot, and Done resumes it', async () => {
    const { bot, model, run } = await asker('Solo', 'GitHub.com');

    const [request] = await requestsIn(bot.chatId);
    expect(request!.message.authorId).toBe(bot.id);
    expect(request!.part).toMatchObject({
      props: {
        site: 'github.com',
        // Named by the bare domain: Take over opens it, not a blank page.
        url: 'https://github.com/',
        reason: 'Read GitHub.com for the owner',
        requester: { bot_id: bot.id, handle: bot.handle, name: 'Solo' },
        screen_bot_id: bot.id,
      },
    });
    expect(await widgetState(request!.message.id, request!.partIndex)).toMatchObject({
      state: { status: 'pending' },
      pendingRunId: run.id,
    });
    await until(() =>
      expect(lastState(bot.id)).toEqual(
        expect.objectContaining({
          state: 'waiting',
          currentAction: 'Waiting for sign-in: github.com',
        }),
      ),
    );

    const syncs = computer.agent.cookieSyncs.length;
    const res = await answer(request!.message.id, request!.partIndex, 'done');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resumedRunId: run.id, startedRunId: null });
    await runOf(bot.id, 'completed');
    expect(computer.agent.cookieSyncs.slice(syncs), 'every screen').toEqual([null]);
    expect(promptText(model.calls[1]!)).toContain('The owner signed in');
  });

  it('asks in its own transcript from a group chat, pointing there, and another run joins (plan 9.7)', async () => {
    // The model's turns in call order: each run asks, then each resumed run carries on.
    const { bot, model } = await newBot('Grouped', [
      [{ tool: 'request_login', args: { site: 'sentry.io', reason: 'Read the errors' }, id: 'g1' }],
      [{ tool: 'request_login', args: { site: 'sentry.io', reason: 'Fix one' }, id: 'g2' }],
      [{ text: 'Grouped carried on.' }],
      [{ text: 'Grouped carried on again.' }],
    ]);
    const { bot: other } = await newBot('Bystander', [[{ text: 'Hello.' }]]);
    const created = await call('POST', '/chats', { botIds: [bot.id, other.id] });
    expect(created.status).toBe(201);
    const group = (await created.json()) as { id: string };
    await call('POST', `/chats/${group.id}/messages`, { text: `@${bot.handle} read the errors` });
    const run = await runOf(bot.id, 'waiting');
    expect(run.chatId).toBe(group.id);

    // The widget is in the Bot's transcript, posted for it there, not in the group.
    expect(await requestsIn(group.id)).toEqual([]);
    const [request] = await requestsIn(bot.chatId);
    expect(request!.message).toMatchObject({ authorType: 'bot', authorId: bot.id, runId: null });
    expect(request!.part).toMatchObject({ props: { site: 'sentry.io', screen_bot_id: bot.id } });
    expect(await widgetState(request!.message.id, request!.partIndex)).toMatchObject({
      state: { status: 'pending', waiting: [{ run_id: run.id, reason: 'Read the errors' }] },
      pendingRunId: null,
    });
    // The group keeps a pointer: the Bot's "Asked for a sign-in" row.
    const groupParts = (await messagesIn(group.id))
      .filter((m) => m.authorId === bot.id)
      .flatMap((m) => m.parts as MessagePart[]);
    expect(groupParts.find((p) => p.type === 'tool_result')).toMatchObject({
      label: 'Asked for a sign-in to sentry.io',
    });
    // No handoff: the Bot asked for itself.
    expect(await pairChat(bot, bot)).toBeUndefined();

    // A run in its transcript asking for the same site joins the request.
    await call('POST', `/chats/${bot.chatId}/messages`, { text: 'Fix one' });
    const second = await until(async () => {
      const rows = await runsOf(bot.id);
      expect(rows[1]?.status).toBe('waiting');
      return rows[1]!;
    });
    expect(await requestsIn(bot.chatId)).toHaveLength(1);
    expect(await widgetState(request!.message.id, request!.partIndex)).toMatchObject({
      state: { waiting: [{ run_id: run.id }, { run_id: second.id }] },
    });

    const res = await answer(request!.message.id, request!.partIndex, 'done');
    expect(await res.json()).toMatchObject({ resumedRunId: null, startedRunId: null });
    await until(async () =>
      expect((await runsOf(bot.id)).map((r) => r.status)).toEqual(['completed', 'completed']),
    );
    expect(model.calls.slice(2).map((c) => promptText(c))).toEqual([
      expect.stringContaining('The owner signed in'),
      expect.stringContaining('The owner signed in'),
    ]);
  });

  it("expires a request in the Bot's own transcript, and one from before expiry was kept", async () => {
    const { bot, model, run } = await asker('Lapsed', 'gitea.com');
    const [request] = await requestsIn(bot.chatId);
    const target = { messageId: request!.message.id, partIndex: request!.partIndex };
    const stored = await widgetState(target.messageId, target.partIndex);
    const expiresAt = Date.parse((stored!.state as { expires_at: string }).expires_at);
    expect(Math.abs(expiresAt - (Date.now() + approvalTtlMs(t.deps.config)))).toBeLessThan(60_000);
    // Not due yet: nothing happens.
    expect(await expireLoginRequest(t.ownerDeps, target)).toBe(false);
    expect(await inEveryOrganization(t.deps, () => expireDueLoginRequests(t.deps))).toBe(0);

    // A request stored before expiry was recorded falls due a TTL after its message.
    await t.db
      .update(schema.widgetStates)
      .set({ state: { status: 'pending' } })
      .where(eq(schema.widgetStates.id, stored!.id));
    expect(await inEveryOrganization(t.deps, () => expireDueLoginRequests(t.deps))).toBe(0);
    await t.db
      .update(schema.messages)
      .set({ createdAt: new Date(Date.now() - approvalTtlMs(t.deps.config) - 1_000) })
      .where(eq(schema.messages.id, target.messageId));
    expect(await inEveryOrganization(t.deps, () => expireDueLoginRequests(t.deps))).toBe(1);

    await runOf(bot.id, 'completed');
    expect(promptText(model.calls[1]!)).toContain('expired before the owner answered');
    expect(await widgetState(target.messageId, target.partIndex)).toMatchObject({
      state: { status: 'expired' },
      pendingRunId: null,
    });
    await until(() => expect(lastState(bot.id)?.state).not.toBe('waiting'));
    expect((await answer(target.messageId, target.partIndex, 'done')).status).toBe(409);
    expect(await expireLoginRequest(t.ownerDeps, target), 'once').toBe(false);
    expect((await runsOf(bot.id)).map((r) => r.id)).toEqual([run.id]);
  });

  it('routes to the main Bot, which asks once for two Bots, and Done resumes both', async () => {
    const { bot: main } = await newBot('Main');
    expect((await call('PATCH', `/bots/${main.id}`, { isMain: true })).status).toBe(200);

    const first = await asker('Scout', 'gitlab.com', 'Open the merge request.');
    // The widget is the main Bot's, in its transcript; the asker posts none.
    const [request] = await requestsIn(main.chatId);
    expect(request!.message).toMatchObject({ authorType: 'bot', authorId: main.id, runId: null });
    expect(request!.part).toMatchObject({
      props: {
        site: 'gitlab.com',
        requester: { bot_id: first.bot.id, handle: first.bot.handle },
        screen_bot_id: main.id,
      },
    });
    expect(await requestsIn(first.bot.chatId)).toEqual([]);
    const askerParts = (await messagesIn(first.bot.chatId))
      .filter((m) => m.authorType === 'bot' && !isGreeting(m))
      .flatMap((m) => m.parts as MessagePart[]);
    expect(askerParts.map((p) => p.type)).toEqual(['tool_call', 'tool_result']);
    expect(askerParts[1]).toMatchObject({ label: 'Asked for a sign-in to gitlab.com' });
    expect(first.run.state).toMatchObject({
      pending: { toolName: 'request_login', messageId: request!.message.id, partIndex: 0 },
    });
    await until(() =>
      expect(lastState(first.bot.id)).toEqual(
        expect.objectContaining({
          state: 'waiting',
          currentAction: 'Waiting for sign-in: gitlab.com',
        }),
      ),
    );

    // The handoff, in the pair's chat, as the asker's message (C6).
    const pair = await pairChat(first.bot, main);
    expect(pair).toBeDefined();
    const [handoff] = await messagesIn(pair!.id);
    expect(handoff).toMatchObject({ authorType: 'bot', authorId: first.bot.id });
    expect((handoff!.parts as MessagePart[])[0]).toEqual({
      type: 'text',
      text: 'I need a sign-in to gitlab.com. Open the merge request. I asked our owner in your transcript, and I am waiting for their answer.',
    });

    // A second Bot asking for the same site joins the request.
    const second = await asker('Writer', 'https://www.gitlab.com/users/sign_in');
    expect(await requestsIn(main.chatId)).toHaveLength(1);
    expect(await widgetState(request!.message.id, 0)).toMatchObject({
      state: {
        status: 'pending',
        waiting: [
          {
            run_id: first.run.id,
            bot_id: first.bot.id,
            handle: first.bot.handle,
            reason: 'Open the merge request.',
          },
          {
            run_id: second.run.id,
            bot_id: second.bot.id,
            handle: second.bot.handle,
            reason: 'Read https://www.gitlab.com/users/sign_in for the owner',
          },
        ],
      },
      pendingRunId: null,
    });
    expect(await messagesIn((await pairChat(second.bot, main))!.id)).toHaveLength(1);
    expect(
      events.some(
        (e) =>
          e.type === 'widget.updated' &&
          (e.payload.widget as { messageId: string }).messageId === request!.message.id,
      ),
    ).toBe(true);

    const syncs = computer.agent.cookieSyncs.length;
    const res = await answer(request!.message.id, 0, 'done');
    expect(res.status).toBe(200);
    // Settled by its hook: no run for the main Bot.
    expect(await res.json()).toMatchObject({ resumedRunId: null, startedRunId: null });
    await runOf(first.bot.id, 'completed');
    await runOf(second.bot.id, 'completed');
    expect(computer.agent.cookieSyncs.slice(syncs)).toEqual([null]);
    expect(promptText(first.model.calls[1]!)).toContain('The owner signed in');
    expect(promptText(second.model.calls[1]!)).toContain('The owner signed in');
    expect(await runsOf(main.id)).toEqual([]);
    expect((await answer(request!.message.id, 0, 'done')).status, 'answered once').toBe(409);

    // Answered, it is no longer joined: the next request asks again.
    await asker('Later', 'gitlab.com');
    expect(await requestsIn(main.chatId)).toHaveLength(2);
  });

  it("tells every waiting Bot when the owner can't sign in, without a cookie sync", async () => {
    const main = (
      (await (await call('GET', '/bots')).json()) as { items: (Bot & { isMain: boolean })[] }
    ).items.find((b) => b.isMain)!;
    const { bot, model } = await asker('Blocked', 'bitbucket.org');
    const request = (await requestsIn(main.chatId)).find(
      (r) => (r.part as { props: { site: string } }).props.site === 'bitbucket.org',
    )!;

    const syncs = computer.agent.cookieSyncs.length;
    expect((await answer(request.message.id, request.partIndex, 'cant')).status).toBe(200);
    await runOf(bot.id, 'completed');
    expect(computer.agent.cookieSyncs).toHaveLength(syncs);
    expect(promptText(model.calls[1]!)).toContain('The owner could not sign in');
  });

  it("puts the main Bot's own request in its transcript, and others join it", async () => {
    const main = (
      (await (await call('GET', '/bots')).json()) as { items: (Bot & { isMain: boolean })[] }
    ).items.find((b) => b.isMain)!;
    const script: ScriptedTurn[] = [
      [{ tool: 'request_login', args: { site: 'notion.so', reason: 'Read the wiki' }, id: 'own' }],
      [{ text: 'Main carried on.' }],
    ];
    const model = scriptedModel(script);
    models.set(main.id, { model, info: null, providerOptions: {} });
    await call('POST', `/chats/${main.chatId}/messages`, { text: 'Go' });
    const own = await runOf(main.id, 'waiting');
    const request = (await requestsIn(main.chatId)).find(
      (r) => (r.part as { props: { site: string } }).props.site === 'notion.so',
    )!;
    expect(request.message.runId).toBe(own.id);
    expect(request.part).toMatchObject({ props: { screen_bot_id: main.id } });

    const other = await asker('Reader', 'notion.so');
    expect(
      (await requestsIn(main.chatId)).filter(
        (r) => (r.part as { props: { site: string } }).props.site === 'notion.so',
      ),
    ).toHaveLength(1);
    expect(await widgetState(request.message.id, request.partIndex)).toMatchObject({
      pendingRunId: own.id,
      state: { status: 'pending', waiting: [{ run_id: other.run.id }] },
    });

    const res = await answer(request.message.id, request.partIndex, 'done');
    expect(await res.json()).toMatchObject({ resumedRunId: own.id });
    await runOf(other.bot.id, 'completed');
    await until(async () => expect((await runsOf(main.id)).at(-1)?.status).toBe('completed'));
  });

  it('expires an unanswered request for every waiting Bot, on the approvals TTL', async () => {
    const main = (
      (await (await call('GET', '/bots')).json()) as { items: (Bot & { isMain: boolean })[] }
    ).items.find((b) => b.isMain)!;
    const enqueue = vi.spyOn(t.deps.infra.queue<LoginExpireJob>(LOGINS_QUEUE), 'enqueue');
    try {
      const first = await asker('Early', 'linear.app', 'Read the roadmap');
      const second = await asker('Late', 'linear.app', 'File the bug');
      const request = (await requestsIn(main.chatId)).find(
        (r) => (r.part as { props: { site: string } }).props.site === 'linear.app',
      )!;
      const target = { messageId: request.message.id, partIndex: request.partIndex };
      // One expiry job, due a TTL from the request.
      const jobs = enqueue.mock.calls.filter(([, job]) => job.messageId === target.messageId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]![1]).toEqual(target);
      expect(jobs[0]![2]!.delayMs).toBeGreaterThan(approvalTtlMs(t.deps.config) - 60_000);
      expect(jobs[0]![2]!.delayMs).toBeLessThanOrEqual(approvalTtlMs(t.deps.config));

      const stored = await widgetState(target.messageId, target.partIndex);
      await t.db
        .update(schema.widgetStates)
        .set({ state: { ...(stored!.state as object), expires_at: new Date(0).toISOString() } })
        .where(eq(schema.widgetStates.id, stored!.id));
      const seen = events.length;
      expect(await inEveryOrganization(t.deps, () => expireDueLoginRequests(t.deps))).toBe(1);

      for (const { bot, model } of [first, second]) {
        await runOf(bot.id, 'completed');
        expect(promptText(model.calls[1]!)).toContain('expired before the owner answered');
        await until(() => expect(lastState(bot.id)?.state).not.toBe('waiting'));
      }
      expect(await widgetState(target.messageId, target.partIndex)).toMatchObject({
        state: {
          status: 'expired',
          waiting: [{ reason: 'Read the roadmap' }, { reason: 'File the bug' }],
        },
      });
      expect(
        events
          .slice(seen)
          .find(
            (e) =>
              e.type === 'widget.updated' &&
              (e.payload.widget as { messageId: string }).messageId === target.messageId,
          )?.payload.widget,
      ).toMatchObject({ state: { status: 'expired' }, pendingRunId: null });
      expect(await runsOf(main.id)).toHaveLength(1);
      const res = await answer(target.messageId, target.partIndex, 'done');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ title: 'This sign-in request expired' });
    } finally {
      enqueue.mockRestore();
    }
  });

  it('merges sign-ins to one registrable domain, opening the screen on the host asked for', async () => {
    const main = (
      (await (await call('GET', '/bots')).json()) as { items: (Bot & { isMain: boolean })[] }
    ).items.find((b) => b.isMain)!;
    const first = await asker('Calendar', 'accounts.google.com', 'Read the calendar');
    const second = await asker('Mail', 'https://mail.google.com/mail/u/0', 'Read the inbox');
    const requests = (await requestsIn(main.chatId)).filter(
      (r) => (r.part as { props: { site: string } }).props.site === 'google.com',
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.part).toMatchObject({
      props: { site: 'google.com', url: 'https://accounts.google.com/' },
    });
    expect(
      (await widgetState(requests[0]!.message.id, requests[0]!.partIndex))!.state,
    ).toMatchObject({ waiting: [{ run_id: first.run.id }, { run_id: second.run.id }] });
    await until(() =>
      expect(lastState(second.bot.id)?.currentAction).toBe('Waiting for sign-in: google.com'),
    );
  });

  it('reduces a host to its registrable domain by a small rule', () => {
    expect(registrableDomain('accounts.google.com')).toBe('google.com');
    expect(registrableDomain('github.com')).toBe('github.com');
    expect(registrableDomain('a.b.example.org')).toBe('example.org');
    // A country code's public second level, and shared hosting, keep three labels.
    expect(registrableDomain('login.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableDomain('my.bank.com.au')).toBe('bank.com.au');
    expect(registrableDomain('docs.dana.github.io')).toBe('dana.github.io');
    expect(registrableDomain('app.vercel.app')).toBe('app.vercel.app');
    expect(registrableDomain('co.uk')).toBe('co.uk');
    // Hosts that have no registrable domain stay whole.
    expect(registrableDomain('localhost')).toBe('localhost');
    expect(registrableDomain('192.168.1.20')).toBe('192.168.1.20');
  });

  it('resumes a run whose request was answered before it paused', async () => {
    const main = (
      (await (await call('GET', '/bots')).json()) as { items: (Bot & { isMain: boolean })[] }
    ).items.find((b) => b.isMain)!;
    const { bot, run } = await asker('Racer', 'figma.com');
    const request = (await requestsIn(main.chatId)).find(
      (r) => (r.part as { props: { site: string } }).props.site === 'figma.com',
    )!;
    const posted = { messageId: request.message.id, partIndex: request.partIndex };
    // Still pending: nothing to do.
    await resumeIfAnswered(t.ownerDeps, run.id, posted);
    expect((await runsOf(bot.id))[0]!.status).toBe('waiting');

    // Done landed while the run was still running, so it resumed nobody.
    await t.db
      .update(schema.widgetStates)
      .set({ state: { status: 'signed_in', waiting: [] } })
      .where(eq(schema.widgetStates.messageId, request.message.id));
    await resumeIfAnswered(t.ownerDeps, run.id, posted);
    await runOf(bot.id, 'completed');
  });

  it('refuses a site it cannot name', async () => {
    const { bot } = await newBot('Vague', [
      [{ tool: 'request_login', args: { site: 'the bank', reason: 'Pay a bill' }, id: 'v1' }],
      [{ text: 'Could not ask.' }],
    ]);
    await call('POST', `/chats/${bot.chatId}/messages`, { text: 'Go' });
    await runOf(bot.id, 'completed');
    const parts = (await messagesIn(bot.chatId)).flatMap((m) => m.parts as MessagePart[]);
    expect(parts.find((p) => p.type === 'tool_result')).toMatchObject({
      is_error: true,
      result: { error: expect.stringContaining('host name') },
    });
  });
});
