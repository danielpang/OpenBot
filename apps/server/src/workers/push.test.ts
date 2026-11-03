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
        status: () => ({ hostId, relayUrl: null, status: 'linked', since: null }),
        wake: () => {},
        stop: async () => {},
        push: async (request) => {
          sent.push(request);
          return outcome;
        },
      },
    };
    worker = await startPushWorker(deps);
  });

  afterEach(() => {
    sent.length = 0;
    outcome = { ok: true };
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
});
