import type { ComputerProvider } from '@openbots/computer';
import { startFakeAgent, type FakeAgent } from '@openbots/computer/testing';
import { EVENTS_CHANNEL, type WsEvent } from '@openbots/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import { computerServices, setComputerProvider } from '../services/computer.js';
import { postMessage } from '../services/messages.js';
import { useTestComputer, type TestComputer } from '../test-computer.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';

// The computer wakes on its own (plan 9.5): the Mac app asks once it signed
// the owner in on This Mac (`POST /computer/wake`), and an owner's message to
// their Bots starts a stopped computer in the background, or marks a running
// one used. One start at a time, in the message's organization only, never
// for Bot, webhook or Routine messages, and never changing the idle settings.

describe('waking the computer (plan 9.5)', () => {
  let t: TestApp;
  let computer: TestComputer;
  /** The agent of the second computer made (Dana's in B); the first one's is `computer.agent`. */
  let agentB: FakeAgent;
  let dana: string;
  let danaInB: string;
  let danaId: string;
  let orgA: string;
  let orgB: string;
  let chatA: string;
  let chatB: string;
  let botA: string;
  /** While set, every machine start waits for it: messages land while one is under way. */
  let hold: Promise<void> | null = null;
  let release = () => {};
  /** While set, a command on the agent waits for it. */
  let execHold: Promise<void> | null = null;
  const events: WsEvent[] = [];

  const call = (cookie: string, method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function signIn(email: string) {
    const res = await t.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, password: 'correct horse battery' }),
    });
    return res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .find((c) => c.includes('session_token='))!;
  }

  async function newBot(cookie: string, name: string) {
    const res = await call(cookie, 'POST', '/bots', { name, modelConfig: null });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; chatId: string };
  }

  async function say(cookie: string, chatId: string, text: string) {
    const res = await call(cookie, 'POST', `/chats/${chatId}/messages`, { text });
    expect(res.status).toBe(201);
  }

  async function computerIn(workspaceId: string) {
    const [row] = await t.db
      .select()
      .from(schema.computers)
      .where(
        and(eq(schema.computers.ownerId, danaId), eq(schema.computers.workspaceId, workspaceId)),
      );
    return row ?? null;
  }

  const starts = () => computer.docker.calls.filter((c) => c.op === 'start').length;
  const until = (fn: () => Promise<unknown> | unknown) =>
    vi.waitFor(fn, { timeout: 5_000, interval: 10 });
  /** Room for a background wake that should not happen to show itself. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  async function stopped(cookie: string, workspaceId: string) {
    expect((await call(cookie, 'POST', '/computer/stop')).status).toBe(200);
    expect((await computerIn(workspaceId))?.status).toBe('stopped');
  }

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    computer = await useTestComputer(t.ownerDeps);
    agentB = await startFakeAgent({ token: 'not-yet-created' });
    const inner = computer.provider;
    const agents = new Map<string, FakeAgent>();
    const slow: ComputerProvider = {
      ...inner,
      // Each computer its own agent, each with its own token.
      async create(spec) {
        const first = computer.agent.token;
        const ref = await inner.create(spec);
        if (!agents.size) agents.set(spec.computerId, computer.agent);
        const agent = agents.get(spec.computerId) ?? agentB;
        agents.set(spec.computerId, agent);
        if (agent === computer.agent) return ref;
        computer.agent.token = first;
        agentB.token = spec.agentToken;
        return { ...ref, agentUrl: agentB.url };
      },
      async start(ref) {
        if (hold) await hold;
        return inner.start(ref);
      },
      agent(ref) {
        const agent = inner.agent(ref);
        return {
          ...agent,
          async exec(request, options) {
            if (execHold) await execHold;
            return agent.exec(request, options);
          },
        };
      },
    };
    setComputerProvider(t.ownerDeps, slow);
    await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));

    orgA = await t.defaultOrganization();
    dana = (await t.signUp('dana@example.com')).cookie!;
    danaId = await t.userId('dana@example.com');
    orgB = await t.createOrganization('Org B');
    await t.addMember(danaId, orgB, 'owner');
    danaInB = await signIn('dana@example.com');
    await t.switchOrganization(danaInB, orgB);

    const bot = await newBot(dana, 'Scout');
    botA = bot.id;
    chatA = bot.chatId;
    chatB = (await newBot(danaInB, 'Ranger')).chatId;
  }, 60_000);
  afterAll(async () => {
    await agentB?.close();
    await computer.close();
    await t.close();
  });
  beforeEach(() => {
    hold = null;
    execHold = null;
  });

  it('creates nothing from a message before the computer was ever used', async () => {
    await say(dana, chatA, 'Hello');
    await settle();
    expect(await computerIn(orgA)).toBeNull();
    expect(starts()).toBe(0);
  });

  it("starts on the Mac app's wake, creating it on first use, and answers at once", async () => {
    hold = new Promise((resolve) => (release = resolve));
    const res = await call(dana, 'POST', '/computer/wake');
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ available: true });
    // The answer did not wait for the start.
    await until(async () => expect((await computerIn(orgA))?.status).toBe('starting'));
    release();
    await until(async () => expect((await computerIn(orgA))?.status).toBe('running'));
    expect(starts()).toBe(1);
    const statuses = events
      .filter((e) => e.type === 'computer.status' && e.workspace_id === orgA)
      .map((e) => (e.payload as { status: string }).status);
    expect(statuses).toEqual(['creating', 'stopped', 'starting', 'running']);
  });

  it('does nothing on a wake while it runs, not even marking it used', async () => {
    const before = (await computerIn(orgA))!.lastUsedAt;
    const res = await call(dana, 'POST', '/computer/wake');
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      available: true,
      computer: { status: 'running' },
    });
    await settle();
    expect(starts()).toBe(1);
    expect((await computerIn(orgA))!.lastUsedAt).toEqual(before);
  });

  it('starts a stopped computer once for three quick messages, keeping its idle settings', async () => {
    expect(
      (await call(dana, 'PATCH', '/computer', { idleTimeoutMin: 45, alwaysOn: false })).status,
    ).toBe(200);
    await stopped(dana, orgA);
    const before = starts();
    hold = new Promise((resolve) => (release = resolve));
    await say(dana, chatA, 'One');
    await until(async () => expect((await computerIn(orgA))?.status).toBe('starting'));
    await say(dana, chatA, 'Two');
    await say(dana, chatA, 'Three');
    // A wake from the Mac app meanwhile joins it too.
    expect((await call(dana, 'POST', '/computer/wake')).status).toBe(202);
    release();
    await until(async () => expect((await computerIn(orgA))?.status).toBe('running'));
    await settle();
    expect(starts() - before).toBe(1);
    expect(await computerIn(orgA)).toMatchObject({ idleTimeoutMin: 45, alwaysOn: false });
  });

  it('marks a running computer used, so a conversation keeps it awake', async () => {
    const long = new Date(Date.now() - 60 * 60_000);
    await t.db
      .update(schema.computers)
      .set({ lastUsedAt: long })
      .where(eq(schema.computers.id, (await computerIn(orgA))!.id));
    const before = starts();
    await say(dana, chatA, 'Still there?');
    await until(async () =>
      expect((await computerIn(orgA))!.lastUsedAt!.getTime()).toBeGreaterThan(long.getTime()),
    );
    expect(starts()).toBe(before);
  });

  it('is not woken by Bot, webhook or Routine messages', async () => {
    await stopped(dana, orgA);
    const before = starts();
    const text = [{ type: 'text' as const, text: 'Automated' }];
    await t.inOrganization(async () => {
      await postMessage(t.deps, chatA, { authorType: 'bot', authorId: botA, parts: text });
      await postMessage(t.deps, chatA, { authorType: 'webhook', parts: text });
      await postMessage(t.deps, chatA, { authorType: 'routine', parts: text });
    }, orgA);
    await settle();
    expect((await computerIn(orgA))?.status).toBe('stopped');
    expect(starts()).toBe(before);
  });

  it("wakes only the message's organization", async () => {
    // Dana's computer in B, used once and stopped; A's is stopped too.
    expect((await call(danaInB, 'POST', '/computer/start')).status).toBe(200);
    await stopped(danaInB, orgB);
    expect((await computerIn(orgA))?.status).toBe('stopped');

    await say(dana, chatA, 'Work in A');
    await until(async () => expect((await computerIn(orgA))?.status).toBe('running'));
    await settle();
    expect((await computerIn(orgB))?.status).toBe('stopped');

    await say(danaInB, chatB, 'Work in B');
    await until(async () => expect((await computerIn(orgB))?.status).toBe('running'));
    const started = events.filter(
      (e) =>
        e.type === 'computer.status' && (e.payload as { status: string }).status === 'starting',
    );
    expect(started.at(-1)).toMatchObject({ user_id: danaId, workspace_id: orgB });
  });

  it('keeps the computer used while a long command runs', async () => {
    const row = (await computerIn(orgA))!;
    const long = new Date(Date.now() - 60 * 60_000);
    await t.db
      .update(schema.computers)
      .set({ lastUsedAt: long })
      .where(eq(schema.computers.id, row.id));
    let finish = () => {};
    execHold = new Promise((resolve) => (finish = resolve));
    const services = computerServices(t.deps, {
      bot: { id: botA, ownerId: danaId, workspaceId: orgA },
      runId: '00000000-0000-4000-8000-000000000001',
      recordStep: async () => {},
      execTouchMs: 20,
    });
    const ran = t.inOrganization(async () => {
      const agent = await services.agent();
      // The start check marked it used; set it back to see the command do it.
      await t.db
        .update(schema.computers)
        .set({ lastUsedAt: long })
        .where(eq(schema.computers.id, row.id));
      return agent.exec({ command: 'sleep 1800' });
    }, orgA);
    await until(async () =>
      expect((await computerIn(orgA))!.lastUsedAt!.getTime()).toBeGreaterThan(long.getTime()),
    );
    finish();
    expect(await ran).toMatchObject({ exitCode: 0 });
  });

  it('does nothing without a computer provider', async () => {
    await stopped(dana, orgA);
    const before = starts();
    setComputerProvider(t.ownerDeps, null);
    try {
      await say(dana, chatA, 'No computer here');
      const res = await call(dana, 'POST', '/computer/wake');
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ available: false });
      await settle();
      expect((await computerIn(orgA))?.status).toBe('stopped');
      expect(starts()).toBe(before);
    } finally {
      setComputerProvider(t.ownerDeps, computer.provider);
    }
  });
});
