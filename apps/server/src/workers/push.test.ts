import { randomBytes, randomUUID } from 'node:crypto';
import { wsEvent, type NoticeKind, type WsEvent } from '@openbots/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppDeps, RelayPushOutcome, RelayPushRequest } from '../context.js';
import { schema } from '../db/client.js';
import { publishEvent } from '../infra/index.js';
import { encryptSecret, keyringFromConfig } from '../secrets.js';
import { ensureInstanceKey } from '../services/instance-key.js';
import { createTestApp, type TestApp } from '../test-app.js';
import {
  PUSH_AAD,
  decryptPush,
  encryptPush,
  pushPriority,
  startPushWorker,
  type PushWorker,
} from './push.js';

// The push worker over the in-process bus, with a fake relay link that
// records what it would send.

describe('push payload encryption', () => {
  it('seals with ChaCha20-Poly1305 as nonce || ciphertext || tag under the push AAD', () => {
    const key = randomBytes(32);
    const sealed = encryptPush(key, '{"v":1}');
    const bytes = Buffer.from(sealed, 'base64url');
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(bytes.length).toBe(12 + 7 + 16);
    expect(decryptPush(key, sealed)).toBe('{"v":1}');
    // A fresh nonce every time.
    expect(encryptPush(key, '{"v":1}')).not.toBe(sealed);
    expect(PUSH_AAD.toString()).toBe('openbots-push-v1');
    expect(() => decryptPush(randomBytes(32), sealed)).toThrow();
  });

  it('gives what waits on the owner priority 10 and the rest 5', () => {
    const kinds: NoticeKind[] = ['approval', 'question', 'mention', 'routine', 'long_task'];
    expect(kinds.map(pushPriority)).toEqual([10, 10, 5, 5, 5]);
  });
});

describe('push worker', () => {
  let t: TestApp;
  let deps: AppDeps;
  let worker: PushWorker;
  let workspaceId: string;
  let ownerId: string;
  let botId: string;
  let deviceId: string;
  let hostId: string;
  const pushKey = randomBytes(32);
  const token = 'a1b2c3d4e5f6';
  const sent: RelayPushRequest[] = [];
  let outcome: RelayPushOutcome = { ok: true };
  /** Answers each push in turn, before `outcome`; a thrown error is a timeout. */
  let answers: (RelayPushOutcome | Error)[] = [];
  /** The link's `onLinked` listeners: every worker started here. */
  const linked = new Set<() => void>();

  const approval = (id = randomUUID()) =>
    wsEvent(
      'approval.requested',
      {
        approval: {
          id,
          runId: randomUUID(),
          toolName: 'bash',
          summary: 'bash: rm -rf build',
          args: {},
          reason: null,
          status: 'pending',
        },
      },
      { bot_id: botId, chat_id: randomUUID(), seq: 412, workspace_id: workspaceId },
    ) as WsEvent;

  /** What `PUT /devices/{id}/push` publishes: the worker reads the organization again. */
  const deviceUpdated = (org: string) =>
    wsEvent(
      'device.updated',
      {
        device: {
          id: deviceId,
          name: 'Phone',
          platform: 'ios',
          createdAt: new Date().toISOString(),
          revokedAt: null,
          pushRegistered: true,
        },
      },
      { user_id: ownerId, workspace_id: org },
    ) as WsEvent;

  async function publish(event: WsEvent) {
    await publishEvent(t.deps.infra.bus, event);
    // The bus delivers on a microtask; then wait for the worker's queue.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await worker.idle();
  }

  beforeAll(async () => {
    t = await createTestApp();
    await t.signUp('ada@example.com', { name: 'Ada Lovelace' });
    ownerId = await t.userId('ada@example.com');
    workspaceId = await t.defaultOrganization();
    const [bot] = await t.db
      .insert(schema.bots)
      .values({ workspaceId, ownerId, handle: 'researcher', name: 'Researcher' })
      .returning();
    botId = bot!.id;
    const keyring = keyringFromConfig(t.deps.config);
    const [device] = await t.db
      .insert(schema.devices)
      .values({
        workspaceId,
        ownerId,
        name: 'Phone',
        platform: 'ios',
        publicKey: randomBytes(32),
        pushKey: encryptSecret(pushKey, keyring),
        pushToken: encryptSecret(token, keyring),
        pushEnvironment: 'production',
      })
      .returning();
    deviceId = device!.id;
    hostId = (await ensureInstanceKey({ db: t.deps.db, config: t.deps.config })).hostId;
    deps = {
      ...t.deps,
      config: { ...t.deps.config, relayUrl: 'ws://127.0.0.1:1' },
      relay: {
        status: () => ({ hostId, relayUrl: null, status: 'linked', since: null, error: null }),
        wake: () => {},
        stop: async () => {},
        push: async (request) => {
          sent.push(request);
          const answer = answers.shift() ?? outcome;
          if (answer instanceof Error) throw answer;
          return answer;
        },
        onLinked: (handler) => {
          linked.add(handler);
          return () => linked.delete(handler);
        },
      },
    };
    worker = await startPushWorker(deps, { retryDelaysMs: [5, 5] });
  });

  afterEach(async () => {
    // The phone's token as it registered it, whatever a test did to it.
    await t.db
      .update(schema.devices)
      .set({
        pushToken: encryptSecret(token, keyringFromConfig(t.deps.config)),
        pushEnvironment: 'production',
      })
      .where(eq(schema.devices.id, deviceId));
    await publish(deviceUpdated(workspaceId));
    sent.length = 0;
    outcome = { ok: true };
    answers = [];
  });

  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  it('sends an approval to the owner’s device, encrypted to the spec 7 payload', async () => {
    const event = approval();
    const approvalId = (event.payload as { approval: { id: string } }).approval.id;
    const before = Math.floor(Date.now() / 1000);
    await publish(event);
    expect(sent).toHaveLength(1);
    const [push] = sent;
    expect(push).toMatchObject({
      platform: 'ios',
      token,
      environment: 'production',
      collapseId: `approval:${approvalId}`,
      priority: 10,
      threadId: botId,
    });
    expect(push!.expiresAt).toBeGreaterThanOrEqual(before + 86_400);
    expect(push!.expiresAt).toBeLessThanOrEqual(before + 86_401);
    expect(JSON.parse(decryptPush(pushKey, push!.ciphertext))).toEqual({
      v: 1,
      kind: 'approval',
      tag: `approval:${approvalId}`,
      title: 'Researcher needs your approval',
      body: 'bash: rm -rf build',
      target: { botId, chatId: event.chat_id, seq: 412, threadRootId: null },
      host: hostId,
    });
  });

  it('sends a notice once per device and tag', async () => {
    const event = approval();
    await publish(event);
    await publish({ ...event, ts: Date.now() } as WsEvent);
    expect(sent).toHaveLength(1);
  });

  it('dedupes across workers through the shared limiter', async () => {
    const id = randomUUID();
    const second = await startPushWorker(deps);
    try {
      await publish(approval(id));
      await second.idle();
      expect(sent).toHaveLength(1);
    } finally {
      await second.stop();
    }
  });

  it('sends a mention as priority 5', async () => {
    const messageId = randomUUID();
    await publish(
      wsEvent(
        'message.created',
        {
          message: {
            id: messageId,
            chatId: randomUUID(),
            seq: 7,
            authorType: 'bot',
            authorId: botId,
            status: 'complete',
            parts: [{ type: 'text', text: 'Done, @ada, have a look' }],
            threadRootId: null,
          },
        } as never,
        { bot_id: botId, workspace_id: workspaceId },
      ) as WsEvent,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.priority).toBe(5);
    expect(JSON.parse(decryptPush(pushKey, sent[0]!.ciphertext))).toMatchObject({
      kind: 'mention',
      tag: `mention:${messageId}`,
      title: 'Researcher mentioned you',
    });
  });

  it('ignores events of another owner’s Bot and of organizations with no push device', async () => {
    const other = await t.createOrganization('Elsewhere');
    await publish({ ...approval(), workspace_id: other } as WsEvent);
    await publish({ ...approval(), bot_id: randomUUID(), chat_id: undefined } as WsEvent);
    expect(sent).toEqual([]);
  });

  it('reads the organization again on device.updated, so a token registered just after pairing is used', async () => {
    const cached = await startPushWorker(deps, { cacheMs: 3_600_000 });
    try {
      const org = await t.createOrganization('Fresh pairing');
      await t.addMember(ownerId, org, 'owner');
      const [bot] = await t.db
        .insert(schema.bots)
        .values({ workspaceId: org, ownerId, handle: 'fresh', name: 'Fresh' })
        .returning();
      const keyring = keyringFromConfig(t.deps.config);
      const [phone] = await t.db
        .insert(schema.devices)
        .values({
          workspaceId: org,
          ownerId,
          name: 'New phone',
          platform: 'ios',
          publicKey: randomBytes(32),
          pushKey: encryptSecret(pushKey, keyring),
        })
        .returning();
      const inOrg = () => ({ ...approval(), bot_id: bot!.id, workspace_id: org }) as WsEvent;
      // Paired, no token yet: both workers cache an organization with nobody to push to.
      await publish(inOrg());
      await cached.idle();
      expect(sent).toEqual([]);
      // The phone registers its token; nothing is published, so the caches still say nobody.
      await t.db
        .update(schema.devices)
        .set({ pushToken: encryptSecret(token, keyring), pushEnvironment: 'production' })
        .where(eq(schema.devices.id, phone!.id));
      await publish(inOrg());
      await cached.idle();
      expect(sent).toEqual([]);
      // registerPush publishes device.updated: the next notice goes out.
      await publish(
        wsEvent(
          'device.updated',
          {
            device: {
              id: phone!.id,
              name: 'New phone',
              platform: 'ios',
              createdAt: new Date().toISOString(),
              revokedAt: null,
              pushRegistered: true,
            },
          },
          { user_id: ownerId, workspace_id: org },
        ),
      );
      await publish(inOrg());
      await cached.idle();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.token).toBe(token);
    } finally {
      await cached.stop();
    }
  });

  it('forgets the token when the relay says it is unregistered', async () => {
    outcome = { ok: false, reason: 'unregistered', status: 410 };
    await publish(approval());
    expect(sent).toHaveLength(1);
    const [row] = await t.db.select().from(schema.devices).where(eq(schema.devices.id, deviceId));
    expect(row!.pushToken).toBeNull();
    expect(row!.revokedAt).toBeNull();
    // With no token left, nothing more goes out.
    await publish(approval());
    expect(sent).toHaveLength(1);
  });

  it('tries an error, an unavailable relay and a timeout again, and spends the dedupe only on ok', async () => {
    answers = [
      // A relay that drains answers 503.
      { ok: false, reason: 'error', status: 503 },
      new Error('the relay did not answer the push in time'),
      { ok: true },
    ];
    const event = approval();
    await publish(event);
    expect(sent).toHaveLength(3);
    // Sent: a second worker, or the same event again, does not send it twice.
    const other = await startPushWorker(deps, { retryDelaysMs: [5, 5] });
    try {
      await publish({ ...event, ts: Date.now() } as WsEvent);
      await other.idle();
      expect(sent).toHaveLength(3);
    } finally {
      await other.stop();
    }
  });

  it('gives up after three tries, and gives the dedupe back so the notice can go later', async () => {
    outcome = { ok: false, reason: 'unavailable', status: null };
    const id = randomUUID();
    await publish(approval(id));
    expect(sent).toHaveLength(3);
    // Not spent: another worker that sees it sends it.
    outcome = { ok: true };
    const other = await startPushWorker(deps, { retryDelaysMs: [5, 5] });
    try {
      await publish(approval(id));
      await other.idle();
      expect(sent.filter((p) => p.collapseId === `approval:${id}`)).toHaveLength(4);
    } finally {
      await other.stop();
    }
  });

  it('does not try an invalid push again, and forgets a token APNs calls bad (400)', async () => {
    outcome = { ok: false, reason: 'invalid', status: null };
    await publish(approval());
    expect(sent).toHaveLength(1);
    let [row] = await t.db.select().from(schema.devices).where(eq(schema.devices.id, deviceId));
    expect(row!.pushToken).not.toBeNull();

    outcome = { ok: false, reason: 'invalid', status: 400 };
    await publish(approval());
    expect(sent).toHaveLength(2);
    [row] = await t.db.select().from(schema.devices).where(eq(schema.devices.id, deviceId));
    expect(row!.pushToken).toBeNull();
    expect(row!.revokedAt).toBeNull();
    // The phone registers again, sandbox this time: each push names its environment.
    const keyring = keyringFromConfig(t.deps.config);
    await t.db
      .update(schema.devices)
      .set({ pushToken: encryptSecret(token, keyring), pushEnvironment: 'sandbox' })
      .where(eq(schema.devices.id, deviceId));
    outcome = { ok: true };
    await publish(deviceUpdated(workspaceId));
    await publish(approval());
    expect(sent).toHaveLength(3);
    expect(sent[2]!.environment).toBe('sandbox');
    await t.db
      .update(schema.devices)
      .set({ pushEnvironment: null })
      .where(eq(schema.devices.id, deviceId));
    await publish(deviceUpdated(workspaceId));
    await publish(approval());
    expect(sent[3]!.environment).toBe('production');
  });

  it('catches up on approvals, questions and sign-in requests still waiting, once each', async () => {
    const [chat] = await t.db
      .insert(schema.chats)
      .values({ workspaceId, ownerId, type: 'bot_dm', botId })
      .returning();
    const [run] = await t.db
      .insert(schema.runs)
      .values({ workspaceId, botId, chatId: chat!.id, trigger: 'message', status: 'waiting' })
      .returning();
    const message = async (seq: number, part: object) =>
      (
        await t.db
          .insert(schema.messages)
          .values({
            workspaceId,
            chatId: chat!.id,
            seq,
            authorType: 'bot',
            authorId: botId,
            parts: [{ type: 'text', text: 'one moment' }, part],
          })
          .returning()
      )[0]!;
    const approvalMessage = await message(1, {
      type: 'widget',
      kind: 'approval',
      props: { toolName: 'bash' },
    });
    const [pending] = await t.db
      .insert(schema.approvals)
      .values({
        workspaceId,
        runId: run!.id,
        messageId: approvalMessage.id,
        toolName: 'bash',
        args: { command: 'rm -rf build' },
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    const question = await message(2, {
      type: 'widget',
      kind: 'question',
      props: { question: 'Which branch?' },
    });
    const login = await message(3, {
      type: 'widget',
      kind: 'login_request',
      props: { site: 'github.com', reason: 'To open the PR' },
    });
    const answered = await message(4, {
      type: 'widget',
      kind: 'question',
      props: { question: 'Answered already' },
    });
    await t.db.insert(schema.widgetStates).values([
      { workspaceId, messageId: question.id, partIndex: 1, pendingRunId: run!.id },
      { workspaceId, messageId: login.id, partIndex: 1, state: { status: 'pending' } },
      { workspaceId, messageId: answered.id, partIndex: 1, state: { answer: 'main' } },
    ]);
    // A decided approval is not waiting.
    await t.db.insert(schema.approvals).values({
      workspaceId,
      runId: run!.id,
      toolName: 'bash',
      status: 'approved',
    });

    // The link comes up: what waited goes out.
    expect(linked.size).toBe(1);
    for (const handler of linked) handler();
    await worker.idle();
    const tags = sent.map((p) => p.collapseId);
    expect(tags).toEqual([
      `approval:${pending!.id}`,
      `question:${question.id}`,
      `question:${login.id}`,
    ]);
    expect(JSON.parse(decryptPush(pushKey, sent[1]!.ciphertext))).toMatchObject({
      kind: 'question',
      title: 'Researcher has a question',
      body: 'Which branch?',
      target: { botId, chatId: chat!.id, seq: 2 },
    });
    // Again (a relink, or a worker starting): nothing goes twice.
    await worker.catchUp();
    await worker.idle();
    expect(sent).toHaveLength(3);
    await t.db.delete(schema.chats).where(eq(schema.chats.id, chat!.id));
  });

  it('sends nothing for an owner suspended in the organization', async () => {
    await t.db
      .update(schema.workspaceMembers)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.workspaceMembers.userId, ownerId));
    try {
      await publish(deviceUpdated(workspaceId));
      await publish(approval());
      expect(sent).toEqual([]);
    } finally {
      await t.db
        .update(schema.workspaceMembers)
        .set({ suspendedAt: null })
        .where(eq(schema.workspaceMembers.userId, ownerId));
      await publish(deviceUpdated(workspaceId));
    }
  });
});
