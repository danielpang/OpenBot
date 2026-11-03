import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  EVENTS_CHANNEL,
  OWNER_INPUT_WIDGETS,
  createNoticeWatcher,
  ownerHandles,
  wsEvent,
  type Notice,
  type NoticeKind,
  type Unsubscribe,
  type WsEvent,
} from '@openbots/shared';
import { and, desc, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { AppDeps, RelayPushOutcome, RelayPushRequest } from '../context.js';
import { schema } from '../db/client.js';
import { forEachWorkspace, inWorkspace, outsideScope } from '../db/scope.js';
import { MEMBERSHIP_ENDED_CHANNEL, type MembershipEnded } from '../membership.js';
import { decryptSecret, decryptSecretString, keyringFromConfig } from '../secrets.js';
import { toApproval } from '../services/approvals.js';
import { ensureInstanceKey } from '../services/instance-key.js';

// Push notifications (docs/RELAY_PROTOCOL.md section 7; MOBILE_AND_VM_PLAN.md
// section 6). The worker listens to the event bus like the WS gateway does
// and runs the same notice watcher the Mac app runs (packages/shared
// notices.ts), one per owner who has a device with a push token. Each notice
// is encrypted for each of that owner's devices under the device's push key
// and sent as a `push` frame over the relay link; the relay and Apple see
// only a generic alert and ciphertext.
//
// Which owner an event is for: its `user_id` when it names one, else the
// owner of its Bot, else the owner of its chat, as the gateway would deliver
// it to that owner's sockets. Events of organizations with no push device
// are dropped before they reach a watcher; the answer is cached for ten
// seconds per organization and forgotten on any `device.*` event (a pairing,
// a revocation, or `device.updated` when a phone registers its push token)
// and when a member's access ends. An owner suspended or removed in the
// organization gets nothing there.
//
// A notice is sent to a device once a day per tag, across worker processes:
// the rate limiter (Redis when REDIS_URL is set) holds a bucket of one per
// `push:<device>:<tag>` that takes a day to refill, which is a SET NX with a
// day's expiry in effect. The bucket is taken before the push, so two
// workers never both send, and given back unless the relay answers `ok`:
// a push that never reached Apple can go again. `error`, `unavailable`, a
// timeout and a link that is not up are tried again, three tries in all over
// about five minutes (`error` with status 503, a relay that drains, included);
// `invalid` and `unregistered` are not. `unregistered` (APNs 410), and
// `invalid` with APNs status 400 (BadDeviceToken, DeviceTokenNotForTopic),
// forget the token; `invalid` with no status is a malformed frame, a bug
// logged as one, and the token is kept. Each push names the token's APNs environment (`production` or
// `sandbox`, as the phone registered it).
//
// A notice whose event came while the relay link was down is not lost: at
// start, and each time the link becomes `linked`, the worker reads what
// still waits on each owner with a push device (pending approvals, questions
// and sign-in requests) and sends each as its event would have, through the
// same dedupe, so what already went out does not go again.

export const PUSH_AAD = Buffer.from('openbots-push-v1', 'utf8');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** How long the devices and Bots of an organization are trusted before they are read again. */
export const PUSH_CACHE_MS = 10_000;
const DEDUPE_WINDOW_SECONDS = 24 * 60 * 60;
const EXPIRY_SECONDS = 24 * 60 * 60;
const MAX_COLLAPSE_ID_BYTES = 64;
const MAX_NOTICES_PER_WATCHER = 10_000;
/** The waits before the second and third try of a push that failed for now. */
export const PUSH_RETRY_DELAYS_MS: readonly number[] = [60_000, 240_000];
/** The most pending requests read per organization when catching up. */
const CATCH_UP_LIMIT = 200;

/** The plaintext of spec section 7. */
export interface PushPayload {
  v: 1;
  kind: NoticeKind;
  tag: string;
  title: string;
  body: string;
  target: { botId: string; chatId: string | null; seq: number | null; threadRootId: string | null };
  host: string;
}

/** ChaCha20-Poly1305 under the push key: base64url(nonce || ciphertext || tag). */
export function encryptPush(pushKey: Uint8Array, plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('chacha20-poly1305', pushKey, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(PUSH_AAD, { plaintextLength: Buffer.byteLength(plaintext) });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64url');
}

/** The inverse of `encryptPush`, as the phone's notification extension does it. */
export function decryptPush(pushKey: Uint8Array, sealed: string): string {
  const bytes = Buffer.from(sealed, 'base64url');
  const nonce = bytes.subarray(0, NONCE_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const ciphertext = bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES);
  const decipher = createDecipheriv('chacha20-poly1305', pushKey, nonce, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(PUSH_AAD, { plaintextLength: ciphertext.length });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** APNs priority (spec 7): at once for what waits on the owner, else when convenient. */
export function pushPriority(kind: NoticeKind): 10 | 5 {
  return kind === 'approval' || kind === 'question' ? 10 : 5;
}

export function pushPayload(notice: Notice, host: string): PushPayload {
  return {
    v: 1,
    kind: notice.kind,
    tag: notice.tag,
    title: notice.title,
    body: notice.body,
    target: {
      botId: notice.target.botId,
      chatId: notice.target.chatId ?? null,
      seq: notice.target.seq ?? null,
      threadRootId: notice.target.threadRootId ?? null,
    },
    host,
  };
}

interface PushDevice {
  id: string;
  ownerId: string;
  platform: string;
  token: string;
  environment: RelayPushRequest['environment'];
  pushKey: Buffer;
}

/** Whether an answer of the relay is worth another try later. */
function retryable(outcome: RelayPushOutcome | null): boolean {
  return (
    outcome === null ||
    (!outcome.ok && (outcome.reason === 'error' || outcome.reason === 'unavailable'))
  );
}

/** Whether the relay said the token is no good: forget it. */
function tokenGone(outcome: RelayPushOutcome): boolean {
  return (
    !outcome.ok &&
    (outcome.reason === 'unregistered' || (outcome.reason === 'invalid' && outcome.status === 400))
  );
}

interface WorkspaceState {
  loadedAt: number;
  devices: PushDevice[];
  bots: Map<string, { name: string; ownerId: string }>;
  chats: Map<string, string | null>;
  owners: Map<string, readonly string[]>;
}

export interface PushWorkerOptions {
  cacheMs?: number;
  now?: () => number;
  /** The waits before each try after the first; PUSH_RETRY_DELAYS_MS. */
  retryDelaysMs?: readonly number[];
}

export interface PushWorker {
  stop(): Promise<void>;
  /** Resolves once every event received so far has been handled, retries included: for tests. */
  idle(): Promise<void>;
  /** Reads what waits on each owner and sends it (at start and on `linked`): for tests. */
  catchUp(): Promise<void>;
}

export async function startPushWorker(
  deps: AppDeps,
  options: PushWorkerOptions = {},
): Promise<PushWorker> {
  const { db, config, infra } = deps;
  const logger = deps.logger.child({ component: 'push' });
  const cacheMs = options.cacheMs ?? PUSH_CACHE_MS;
  const now = options.now ?? Date.now;
  const retryDelays = options.retryDelaysMs ?? PUSH_RETRY_DELAYS_MS;
  const keyring = keyringFromConfig(config);
  const { hostId } = await ensureInstanceKey({ db, config });
  /** Pushes waiting for their next try, and the dedupe key each holds. */
  const retries = new Map<NodeJS.Timeout, { key: string; done: () => void }>();
  const retrying = new Set<Promise<void>>();

  const workspaces = new Map<string, Promise<WorkspaceState>>();
  const watchers = new Map<string, ReturnType<typeof createNoticeWatcher>>();
  const noticeCounts = new Map<string, number>();
  /** Events of one organization are handled in order, one at a time. */
  const queues = new Map<string, Promise<void>>();
  let stopped = false;

  async function load(workspaceId: string): Promise<WorkspaceState> {
    return inWorkspace(workspaceId, async () => {
      const rows = await db
        .select()
        .from(schema.devices)
        .where(
          and(
            eq(schema.devices.workspaceId, workspaceId),
            isNull(schema.devices.revokedAt),
            isNotNull(schema.devices.pushToken),
            isNotNull(schema.devices.pushKey),
          ),
        );
      // Only owners still working here: a member, not suspended.
      const active = new Set<string>();
      const candidates = [...new Set(rows.map((r) => r.ownerId))];
      if (candidates.length) {
        const members = await db
          .select({ userId: schema.workspaceMembers.userId })
          .from(schema.workspaceMembers)
          .where(
            and(
              eq(schema.workspaceMembers.workspaceId, workspaceId),
              inArray(schema.workspaceMembers.userId, candidates),
              isNull(schema.workspaceMembers.suspendedAt),
            ),
          );
        for (const member of members) active.add(member.userId);
      }
      const devices: PushDevice[] = [];
      for (const row of rows) {
        if (!active.has(row.ownerId)) continue;
        try {
          devices.push({
            id: row.id,
            ownerId: row.ownerId,
            platform: row.platform,
            token: decryptSecretString(row.pushToken!, keyring).toLowerCase(),
            environment: row.pushEnvironment === 'sandbox' ? 'sandbox' : 'production',
            pushKey: decryptSecret(row.pushKey!, keyring),
          });
        } catch (err) {
          logger.warn({ err, deviceId: row.id }, 'a device’s push token or key does not open');
        }
      }
      const state: WorkspaceState = {
        loadedAt: now(),
        devices,
        bots: new Map(),
        chats: new Map(),
        owners: new Map(),
      };
      if (!devices.length) return state;
      const bots = await db
        .select({ id: schema.bots.id, name: schema.bots.name, ownerId: schema.bots.ownerId })
        .from(schema.bots)
        .where(eq(schema.bots.workspaceId, workspaceId));
      for (const bot of bots) state.bots.set(bot.id, { name: bot.name, ownerId: bot.ownerId });
      const ownerIds = [...new Set(devices.map((d) => d.ownerId))];
      const users = await db
        .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .where(inArray(schema.users.id, ownerIds));
      for (const user of users) state.owners.set(user.id, ownerHandles(user));
      return state;
    });
  }

  function stateOf(workspaceId: string): Promise<WorkspaceState> {
    const cached = workspaces.get(workspaceId);
    if (cached) return cached;
    const pending = load(workspaceId);
    workspaces.set(workspaceId, pending);
    pending.then(
      (state) => {
        // Forget it after `cacheMs`, so a change no event told of is found.
        const timer = setTimeout(
          () => {
            if (workspaces.get(workspaceId) === pending) workspaces.delete(workspaceId);
          },
          Math.max(0, state.loadedAt + cacheMs - now()),
        );
        timer.unref();
      },
      () => workspaces.delete(workspaceId),
    );
    return pending;
  }

  async function chatOwner(state: WorkspaceState, workspaceId: string, chatId: string) {
    if (state.chats.has(chatId)) return state.chats.get(chatId) ?? null;
    const [chat] = await inWorkspace(workspaceId, () =>
      db
        .select({ ownerId: schema.chats.ownerId })
        .from(schema.chats)
        .where(eq(schema.chats.id, chatId)),
    );
    state.chats.set(chatId, chat?.ownerId ?? null);
    return chat?.ownerId ?? null;
  }

  async function ownerOf(state: WorkspaceState, workspaceId: string, event: WsEvent) {
    if (event.user_id) return event.user_id;
    if (event.bot_id) {
      const bot = state.bots.get(event.bot_id);
      if (bot) return bot.ownerId;
    }
    if (event.type === 'message.created') {
      const author = event.payload.message;
      if (author.authorType === 'bot' && author.authorId) {
        const bot = state.bots.get(author.authorId);
        if (bot) return bot.ownerId;
      }
    }
    if (event.chat_id) return chatOwner(state, workspaceId, event.chat_id);
    return null;
  }

  /** The state the watchers of an organization read their context from, set before each event. */
  const current = new Map<string, WorkspaceState>();

  function watcherFor(workspaceId: string, ownerId: string) {
    const key = `${workspaceId}:${ownerId}`;
    let watcher = watchers.get(key);
    if (!watcher) {
      watcher = createNoticeWatcher(() => {
        const state = current.get(workspaceId);
        return {
          botName: (botId) => state?.bots.get(botId)?.name,
          ownerHandles: state?.owners.get(ownerId) ?? [],
        };
      });
      watchers.set(key, watcher);
    }
    return watcher;
  }

  async function send(workspaceId: string, device: PushDevice, notice: Notice): Promise<void> {
    if (!deps.relay) return;
    if (device.platform !== 'ios') return;
    // Taken now so no other worker sends it meanwhile; given back unless the relay says ok.
    const key = `push:${device.id}:${notice.tag}`;
    const dedupe = await infra.limiter.consume(key, { window: DEDUPE_WINDOW_SECONDS, max: 1 });
    if (!dedupe.allowed) return;
    await attempt(workspaceId, device, notice, key, 0);
  }

  async function attempt(
    workspaceId: string,
    device: PushDevice,
    notice: Notice,
    key: string,
    tries: number,
  ): Promise<void> {
    const relay = deps.relay;
    let outcome: RelayPushOutcome | null = null;
    if (relay) {
      const payload = pushPayload(notice, hostId);
      const request: RelayPushRequest = {
        platform: 'ios',
        token: device.token,
        environment: device.environment,
        ciphertext: encryptPush(device.pushKey, JSON.stringify(payload)),
        priority: pushPriority(notice.kind),
        expiresAt: Math.floor(now() / 1000) + EXPIRY_SECONDS,
        threadId: notice.target.botId,
        ...(Buffer.byteLength(notice.tag) <= MAX_COLLAPSE_ID_BYTES
          ? { collapseId: notice.tag }
          : {}),
      };
      try {
        outcome = await relay.push(request);
      } catch (err) {
        // A timeout, or a link that is not up: worth another try.
        logger.warn(
          { err: { message: (err as Error).message }, deviceId: device.id, tries: tries + 1 },
          'push failed',
        );
      }
    }
    if (outcome?.ok) {
      logger.debug({ deviceId: device.id, kind: notice.kind }, 'push sent');
      return;
    }
    if (outcome && tokenGone(outcome)) {
      logger.info(
        { deviceId: device.id, reason: outcome.reason, status: outcome.status },
        'the push token is no longer good; forgetting it',
      );
      await forgetToken(workspaceId, device.id);
      await release(key);
      return;
    }
    if (outcome && !outcome.ok && outcome.reason === 'invalid' && outcome.status === null) {
      // The relay found the frame itself malformed: a bug here, not the token's fault.
      logger.error(
        { deviceId: device.id, kind: notice.kind },
        'the relay refused a push frame as malformed; the token is kept',
      );
    } else if (outcome && !outcome.ok) {
      logger.warn(
        { deviceId: device.id, reason: outcome.reason, status: outcome.status, tries: tries + 1 },
        'push refused',
      );
    }
    const delay = retryDelays[tries];
    if (stopped || !retryable(outcome) || delay === undefined) {
      await release(key);
      return;
    }
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    retrying.add(finished);
    void finished.then(() => retrying.delete(finished));
    const timer = outsideScope(() =>
      setTimeout(() => {
        retries.delete(timer);
        void retry(workspaceId, device, notice, key, tries + 1).finally(done);
      }, delay),
    );
    timer.unref();
    retries.set(timer, { key, done });
  }

  /** The next try, to the device as the organization has it now: a revoked one gets nothing. */
  async function retry(
    workspaceId: string,
    device: PushDevice,
    notice: Notice,
    key: string,
    tries: number,
  ): Promise<void> {
    try {
      const state = await stateOf(workspaceId);
      const fresh = state.devices.find((d) => d.id === device.id);
      if (!fresh || stopped) {
        await release(key);
        return;
      }
      await attempt(workspaceId, fresh, notice, key, tries);
    } catch (err) {
      logger.warn({ err, deviceId: device.id }, 'push retry failed');
      await release(key);
    }
  }

  /** Gives a dedupe key back, so the notice may go out later (catch-up, or its event again). */
  async function release(key: string): Promise<void> {
    await infra.limiter.reset(key).catch((err: unknown) => {
      logger.warn({ err }, 'could not release a push dedupe key');
    });
  }

  /** APNs said the token is gone (410, or 400 BadDeviceToken): the device keeps its pairing, but gets no more pushes. */
  async function forgetToken(workspaceId: string, deviceId: string) {
    await inWorkspace(workspaceId, () =>
      db
        .update(schema.devices)
        .set({ pushToken: null, pushEnvironment: null })
        .where(eq(schema.devices.id, deviceId)),
    );
    workspaces.delete(workspaceId);
  }

  async function handle(workspaceId: string, event: WsEvent): Promise<void> {
    if (event.type.startsWith('device.')) workspaces.delete(workspaceId);
    const state = await stateOf(workspaceId);
    if (!state.devices.length) return;
    let ownerId = await ownerOf(state, workspaceId, event);
    if (!ownerId) {
      // A Bot made since the cache was filled: read the organization again once.
      if (event.bot_id && !state.bots.has(event.bot_id)) {
        workspaces.delete(workspaceId);
        const fresh = await stateOf(workspaceId);
        ownerId = await ownerOf(fresh, workspaceId, event);
      }
      if (!ownerId) return;
    }
    const latest = await stateOf(workspaceId);
    const devices = latest.devices.filter((d) => d.ownerId === ownerId);
    if (!devices.length) return;
    current.set(workspaceId, latest);
    const notice = watcherFor(workspaceId, ownerId).onEvent(event);
    if (!notice) return;
    // A watcher remembers every tag it showed; past a bound it starts afresh,
    // and the day's dedupe below still holds a repeat back.
    const key = `${workspaceId}:${ownerId}`;
    const shown = (noticeCounts.get(key) ?? 0) + 1;
    if (shown >= MAX_NOTICES_PER_WATCHER) {
      watchers.delete(key);
      noticeCounts.delete(key);
    } else noticeCounts.set(key, shown);
    for (const device of devices) {
      try {
        await send(workspaceId, device, notice);
      } catch (err) {
        logger.warn(
          { err: { message: (err as Error).message }, deviceId: device.id },
          'push failed',
        );
      }
    }
  }

  function enqueue(workspaceId: string, work: () => Promise<void>, what: string): Promise<void> {
    const previous = queues.get(workspaceId) ?? Promise.resolve();
    const next = previous
      .then(work)
      .catch((err: unknown) => logger.warn({ err, what }, 'push worker task failed'));
    queues.set(workspaceId, next);
    void next.then(() => {
      if (queues.get(workspaceId) === next) queues.delete(workspaceId);
    });
    return next;
  }

  /**
   * What still waits on each owner with a push device in one organization,
   * as the events that asked for it: pending approvals, and questions and
   * sign-in requests no one answered yet. Each becomes its notice through a
   * watcher of its own and goes to that owner's devices, through the dedupe.
   */
  async function catchUpIn(workspaceId: string): Promise<void> {
    workspaces.delete(workspaceId);
    const state = await stateOf(workspaceId);
    if (!state.devices.length) return;
    const events = await inWorkspace(workspaceId, () => waitingEvents(workspaceId));
    const watchers = new Map<string, ReturnType<typeof createNoticeWatcher>>();
    for (const event of events) {
      const ownerId = await ownerOf(state, workspaceId, event);
      if (!ownerId) continue;
      const devices = state.devices.filter((d) => d.ownerId === ownerId);
      if (!devices.length) continue;
      let watcher = watchers.get(ownerId);
      if (!watcher) {
        watcher = createNoticeWatcher(() => ({
          botName: (botId) => state.bots.get(botId)?.name,
          ownerHandles: state.owners.get(ownerId) ?? [],
        }));
        watchers.set(ownerId, watcher);
      }
      const notice = watcher.onEvent(event);
      if (!notice) continue;
      for (const device of devices) {
        try {
          await send(workspaceId, device, notice);
        } catch (err) {
          logger.warn(
            { err: { message: (err as Error).message }, deviceId: device.id },
            'push failed',
          );
        }
      }
    }
  }

  /** The events of what still waits on an owner in the organization in scope, oldest first. */
  async function waitingEvents(workspaceId: string): Promise<WsEvent[]> {
    const at = new Date(now());
    const approvals = await db
      .select({
        approval: schema.approvals,
        botId: schema.runs.botId,
        chatId: schema.runs.chatId,
        seq: schema.messages.seq,
        threadRootId: schema.messages.threadRootId,
      })
      .from(schema.approvals)
      .innerJoin(schema.runs, eq(schema.runs.id, schema.approvals.runId))
      .leftJoin(schema.messages, eq(schema.messages.id, schema.approvals.messageId))
      .where(
        and(
          eq(schema.approvals.workspaceId, workspaceId),
          eq(schema.approvals.status, 'pending'),
          or(isNull(schema.approvals.expiresAt), gt(schema.approvals.expiresAt, at)),
        ),
      )
      .orderBy(desc(schema.approvals.createdAt))
      .limit(CATCH_UP_LIMIT);
    const widgets = await db
      .select({
        partIndex: schema.widgetStates.partIndex,
        state: schema.widgetStates.state,
        pendingRunId: schema.widgetStates.pendingRunId,
        message: {
          id: schema.messages.id,
          chatId: schema.messages.chatId,
          seq: schema.messages.seq,
          authorId: schema.messages.authorId,
          parts: schema.messages.parts,
          threadRootId: schema.messages.threadRootId,
          createdAt: schema.messages.createdAt,
        },
      })
      .from(schema.widgetStates)
      .innerJoin(schema.messages, eq(schema.messages.id, schema.widgetStates.messageId))
      .where(
        and(
          eq(schema.widgetStates.workspaceId, workspaceId),
          eq(schema.messages.authorType, 'bot'),
          isNotNull(schema.messages.authorId),
        ),
      )
      .orderBy(desc(schema.widgetStates.updatedAt))
      .limit(CATCH_UP_LIMIT * 5);

    const events: { at: number; event: WsEvent }[] = [];
    for (const row of approvals) {
      events.push({
        at: new Date(row.approval.createdAt).getTime(),
        event: wsEvent(
          'approval.requested',
          {
            approval: toApproval(row.approval),
            ...(row.threadRootId ? { threadRootId: row.threadRootId } : {}),
          },
          {
            bot_id: row.botId,
            ...(row.chatId ? { chat_id: row.chatId } : {}),
            ...(row.seq != null ? { seq: row.seq } : {}),
            workspace_id: workspaceId,
          },
        ) as WsEvent,
      });
    }
    for (const row of widgets) {
      const part = (row.message.parts as { type?: string; kind?: string }[])[row.partIndex];
      if (part?.type !== 'widget' || !part.kind || !OWNER_INPUT_WIDGETS[part.kind]) continue;
      const state = (row.state ?? {}) as { status?: unknown; expires_at?: unknown };
      // A question waits while a run waits on it; a sign-in request while it is pending.
      const waiting =
        part.kind === 'login_request'
          ? state.status === 'pending' &&
            (typeof state.expires_at !== 'string' || Date.parse(state.expires_at) > at.getTime())
          : row.pendingRunId !== null;
      if (!waiting) continue;
      events.push({
        at: new Date(row.message.createdAt).getTime(),
        event: wsEvent(
          'message.created',
          {
            message: {
              id: row.message.id,
              chatId: row.message.chatId,
              seq: row.message.seq,
              authorType: 'bot',
              authorId: row.message.authorId,
              status: 'complete',
              parts: [part],
              threadRootId: row.message.threadRootId,
            },
          } as never,
          { bot_id: row.message.authorId!, chat_id: row.message.chatId, workspace_id: workspaceId },
        ) as WsEvent,
      });
    }
    return events.sort((a, b) => a.at - b.at).map((e) => e.event);
  }

  let catching: Promise<void> | null = null;
  /** Every organization's waiting notices, one pass at a time. */
  function catchUp(): Promise<void> {
    if (stopped || !deps.relay) return Promise.resolve();
    catching ??= outsideScope(async () => {
      try {
        const ids = await forEachWorkspace(db, async (workspaceId) => workspaceId);
        await Promise.all(ids.map((id) => enqueue(id, () => catchUpIn(id), 'catch-up')));
      } catch (err) {
        logger.warn({ err }, 'push catch-up failed');
      } finally {
        catching = null;
      }
    });
    return catching;
  }

  const unsubscribe: Unsubscribe = await infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (event) => {
    if (stopped) return;
    const workspaceId = event.workspace_id;
    if (!workspaceId) return;
    void enqueue(workspaceId, () => handle(workspaceId, event), event.type);
  });
  // A suspended or removed owner gets nothing from now on, not after the cache's ten seconds.
  const unsubscribeMembers: Unsubscribe = await infra.bus.subscribe<MembershipEnded>(
    MEMBERSHIP_ENDED_CHANNEL,
    ({ workspaceId }) => {
      workspaces.delete(workspaceId);
    },
  );
  const offLinked = deps.relay?.onLinked?.(() => void catchUp()) ?? (() => {});
  logger.info('push worker started');
  // What waited while no worker ran; the link calls again whenever it links.
  if (deps.relay?.status().status === 'linked') void catchUp();

  return {
    async stop() {
      stopped = true;
      offLinked();
      await unsubscribe();
      await unsubscribeMembers();
      await catching;
      await Promise.allSettled([...queues.values()]);
      // A push waiting for its next try never went: its dedupe key goes back.
      for (const [timer, pending] of retries) {
        clearTimeout(timer);
        await release(pending.key);
        pending.done();
      }
      retries.clear();
    },
    async idle() {
      while (queues.size || retrying.size || catching) {
        await Promise.allSettled([...queues.values(), ...retrying, catching]);
      }
    },
    catchUp,
  };
}
