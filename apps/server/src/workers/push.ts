import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  EVENTS_CHANNEL,
  createNoticeWatcher,
  ownerHandles,
  type Notice,
  type NoticeKind,
  type Unsubscribe,
  type WsEvent,
} from '@openbots/shared';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { AppDeps, RelayPushRequest } from '../context.js';
import { schema } from '../db/client.js';
import { inWorkspace } from '../db/scope.js';
import { decryptSecret, decryptSecretString, keyringFromConfig } from '../secrets.js';
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
// a revocation, or `device.updated` when a phone registers its push token).
//
// A notice is sent to a device once a day per tag, across worker processes:
// the rate limiter (Redis when REDIS_URL is set) holds a bucket of one per
// `push:<device>:<tag>` that takes a day to refill, which is a SET NX with a
// day's expiry in effect.

export const PUSH_AAD = Buffer.from('openbots-push-v1', 'utf8');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** How long the devices and Bots of an organization are trusted before they are read again. */
export const PUSH_CACHE_MS = 10_000;
const DEDUPE_WINDOW_SECONDS = 24 * 60 * 60;
const EXPIRY_SECONDS = 24 * 60 * 60;
const MAX_COLLAPSE_ID_BYTES = 64;
const MAX_NOTICES_PER_WATCHER = 10_000;

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
  pushKey: Buffer;
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
}

export interface PushWorker {
  stop(): Promise<void>;
  /** Resolves once every event received so far has been handled: for tests. */
  idle(): Promise<void>;
}

export async function startPushWorker(
  deps: AppDeps,
  options: PushWorkerOptions = {},
): Promise<PushWorker> {
  const { db, config, infra } = deps;
  const logger = deps.logger.child({ component: 'push' });
  const cacheMs = options.cacheMs ?? PUSH_CACHE_MS;
  const now = options.now ?? Date.now;
  const keyring = keyringFromConfig(config);
  const { hostId } = await ensureInstanceKey({ db, config });

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
      const devices: PushDevice[] = [];
      for (const row of rows) {
        try {
          devices.push({
            id: row.id,
            ownerId: row.ownerId,
            platform: row.platform,
            token: decryptSecretString(row.pushToken!, keyring).toLowerCase(),
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
    const relay = deps.relay;
    if (!relay) return;
    if (device.platform !== 'ios') return;
    const dedupe = await infra.limiter.consume(`push:${device.id}:${notice.tag}`, {
      window: DEDUPE_WINDOW_SECONDS,
      max: 1,
    });
    if (!dedupe.allowed) return;
    const payload = pushPayload(notice, hostId);
    const request: RelayPushRequest = {
      platform: 'ios',
      token: device.token,
      ciphertext: encryptPush(device.pushKey, JSON.stringify(payload)),
      priority: pushPriority(notice.kind),
      expiresAt: Math.floor(now() / 1000) + EXPIRY_SECONDS,
      threadId: notice.target.botId,
      ...(Buffer.byteLength(notice.tag) <= MAX_COLLAPSE_ID_BYTES ? { collapseId: notice.tag } : {}),
    };
    const outcome = await relay.push(request);
    if (outcome.ok) {
      logger.debug({ deviceId: device.id, kind: notice.kind }, 'push sent');
      return;
    }
    if (outcome.reason === 'unregistered') {
      logger.info({ deviceId: device.id }, 'the push token is no longer registered; forgetting it');
      await forgetToken(workspaceId, device.id);
      return;
    }
    logger.warn(
      { deviceId: device.id, reason: outcome.reason, status: outcome.status },
      'push refused',
    );
  }

  /** APNs said the token is gone (410): the device keeps its pairing, but gets no more pushes. */
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

  const unsubscribe: Unsubscribe = await infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (event) => {
    if (stopped) return;
    const workspaceId = event.workspace_id;
    if (!workspaceId) return;
    const previous = queues.get(workspaceId) ?? Promise.resolve();
    const next = previous
      .then(() => handle(workspaceId, event))
      .catch((err: unknown) => logger.warn({ err, type: event.type }, 'push worker event failed'));
    queues.set(workspaceId, next);
    void next.then(() => {
      if (queues.get(workspaceId) === next) queues.delete(workspaceId);
    });
  });
  logger.info('push worker started');

  return {
    async stop() {
      stopped = true;
      await unsubscribe();
      await Promise.allSettled([...queues.values()]);
    },
    async idle() {
      while (queues.size) await Promise.allSettled([...queues.values()]);
    },
  };
}
