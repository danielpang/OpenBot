import { createHmac, randomBytes } from 'node:crypto';
import {
  EVENTS_CHANNEL,
  type EventDeliveryStatus,
  type JobHandler,
  type OutboundEvent,
  type WsEvent,
} from '@openbots/shared';
import { and, arrayContains, desc, eq } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import {
  BlockedAddressError,
  checkedAddresses,
  guardedFetch,
  type NetOptions,
} from '../builtins/net.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, forbidden, notFound } from '../errors.js';
import { observeWebhook } from '../metrics.js';
import { toRun } from '../routes/runs.js';
import { toMessage, type Message } from '../schemas.js';
import { decryptSecretString, encryptSecret, keyringFromConfig } from '../secrets.js';
import { recordAudit, userActor } from '../services/audit.js';
import { isOrgAdmin } from '../workspace.js';
import { inWorkspace } from '../db/scope.js';

// Outbound event subscriptions (plan 11, H6). A worker listens to the event
// bus and turns the events an owner subscribed to into `event_deliveries`
// rows, one per (subscription, event, the event's own id), so several
// workers listening at once still send each event once. Each row is POSTed
// as JSON with `X-OpenBots-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
// "<t>.<body>">` under the subscription's secret, and retried with backoff
// until it gets a 2xx or runs out of attempts.
//
// What goes out: `message.created` once a message is complete (a streamed
// Bot reply when it finishes), `run.completed` and `run.failed`,
// `approval.requested`, `routine.ran` when a Routine's run ends, and
// `artifact.created`. A message a webhook posted goes out without its parts:
// they are a third party's payload, which subscribers should not all get.
//
// Deliveries go through the outbound guard (S-8), so a receiver must be on a
// public address. A URL on a private, loopback or unresolvable host is
// refused when the subscription is saved, not after six failed attempts. An
// admin can mark a subscription `local` when its receiver runs on their own
// network (n8n on the compose network, a LAN host); its deliveries may then
// reach private addresses, still through the guard's pinned lookup. Changing
// the URL clears the mark unless the same request sets it again.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'> & { role?: CurrentUser['role'] };
type OutboundDeps = Pick<AppDeps, 'config' | 'db' | 'infra' | 'logger' | 'net'>;
type SubscriptionDeps = Pick<AppDeps, 'config' | 'db' | 'net'>;

export type SubscriptionRow = typeof schema.eventSubscriptions.$inferSelect;
export type EventDeliveryRow = typeof schema.eventDeliveries.$inferSelect;

export const EVENT_DELIVERIES_QUEUE = 'event-deliveries';
export const SIGNATURE_HEADER = 'X-OpenBots-Signature';
/**
 * Attempts before a delivery is marked failed. Internal: with `retryDelayMs`
 * it spans about 20 minutes, which the delivery log and docs describe.
 */
export const MAX_ATTEMPTS = 6;
/** Delay before retry n (1-based): 10 s, 30 s, 90 s, 4.5 min, 13.5 min. */
export const retryDelayMs = (attempt: number) => 10_000 * 3 ** (attempt - 1);
const RESPONSE_BYTES = 64 * 1024;

export interface EventDeliveryJob {
  deliveryId: string;
  /** Its organization, where it runs (infra/index.ts). */
  workspaceId?: string;
}

const keyring = (deps: Pick<AppDeps, 'config'>) => keyringFromConfig(deps.config);

const invalidUrl = () =>
  new DomainError(400, 'INVALID_URL', 'Subscriptions deliver to an http or https URL');

function parseUrl(url: string): URL {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw invalidUrl();
    return parsed;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw invalidUrl();
  }
}

/**
 * Refuses a URL the guard would block at delivery time (S-8): a private,
 * loopback or unresolvable host, unless the subscription is marked local.
 */
async function checkUrl(deps: Pick<AppDeps, 'net' | 'config'>, url: string, local: boolean) {
  const parsed = parseUrl(url);
  if (local) return;
  try {
    await checkedAddresses(parsed.hostname, deps.net);
  } catch (error) {
    if (!(error instanceof BlockedAddressError)) throw error;
    throw new DomainError(
      400,
      'PRIVATE_HOST',
      deps.config.deployment === 'managed'
        ? `${error.message}. If the receiver is on your network, an admin can mark it local.`
        : `${error.message}. If the receiver is on your network, tick "Runs on my network".`,
    );
  }
}

/** Only an admin marks a receiver as on their own network (S-8). */
function checkLocal(
  deps: { config: Pick<AppDeps['config'], 'localEndpoints'> },
  owner: Owner,
  local: boolean | undefined,
) {
  if (local !== true) return;
  // The hosted service's private network is every organization's (S-8, plan 21.6).
  if (!deps.config.localEndpoints) {
    throw forbidden('Subscriptions cannot reach private addresses on the hosted service');
  }
  if (!isOrgAdmin(owner.role)) throw forbidden('Only an admin can mark a subscription as local');
}

/** The owner's subscriptions in one organization (plan 21.3). */
const subscriptionsOf = (owner: Pick<Owner, 'id' | 'workspaceId'>) =>
  and(
    eq(schema.eventSubscriptions.ownerId, owner.id),
    eq(schema.eventSubscriptions.workspaceId, owner.workspaceId),
  );

export const generateSubscriptionSecret = () => `obs_${randomBytes(32).toString('base64url')}`;

/** The signature header value for `body` at `timestamp` (seconds). */
export function signPayload(secret: string, body: string, timestamp: number): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

// CRUD

export interface SubscriptionInput {
  url: string;
  events: OutboundEvent[];
  enabled?: boolean;
  /** The receiver is on the owner's own network (S-8). Admins only. */
  local?: boolean;
}

export async function listSubscriptions(db: Db, owner: Owner): Promise<SubscriptionRow[]> {
  return db
    .select()
    .from(schema.eventSubscriptions)
    .where(subscriptionsOf(owner))
    .orderBy(schema.eventSubscriptions.createdAt);
}

export async function getSubscription(db: Db, owner: Owner, id: string): Promise<SubscriptionRow> {
  const [row] = await db
    .select()
    .from(schema.eventSubscriptions)
    .where(and(eq(schema.eventSubscriptions.id, id), subscriptionsOf(owner)));
  if (!row) throw notFound('Subscription not found');
  return row;
}

/** Creates a subscription; its signing secret is returned once. */
export async function createSubscription(
  deps: SubscriptionDeps,
  owner: Owner,
  input: SubscriptionInput,
): Promise<{ subscription: SubscriptionRow; secret: string }> {
  checkLocal(deps, owner, input.local);
  const local = input.local ?? false;
  await checkUrl(deps, input.url, local);
  const secret = generateSubscriptionSecret();
  const [subscription] = await deps.db
    .insert(schema.eventSubscriptions)
    .values({
      workspaceId: owner.workspaceId,
      ownerId: owner.id,
      url: input.url,
      events: [...new Set(input.events)],
      secret: encryptSecret(secret, keyring(deps)),
      enabled: input.enabled ?? true,
      local,
    })
    .returning();
  await auditSubscription(deps.db, owner, 'event_subscription.create', subscription!.id, {
    // The origin only: a query string may carry the receiver's token.
    origin: new URL(input.url).origin,
    events: subscription!.events,
    ...(local ? { local } : {}),
  });
  return { subscription: subscription!, secret };
}

export async function updateSubscription(
  deps: SubscriptionDeps,
  owner: Owner,
  id: string,
  patch: Partial<SubscriptionInput> & { rotateSecret?: boolean },
): Promise<{ subscription: SubscriptionRow; secret?: string }> {
  const row = await getSubscription(deps.db, owner, id);
  checkLocal(deps, owner, patch.local);
  // The mark was given to the receiver as it was: a new URL is held to public addresses again.
  const changedUrl = patch.url !== undefined && patch.url !== row.url;
  const local = patch.local ?? (changedUrl ? false : row.local);
  if (changedUrl || (row.local && !local)) await checkUrl(deps, patch.url ?? row.url, local);
  const secret = patch.rotateSecret ? generateSubscriptionSecret() : undefined;
  const [subscription] = await deps.db
    .update(schema.eventSubscriptions)
    .set({
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.events !== undefined ? { events: [...new Set(patch.events)] } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      // Always set, so a patch that changes nothing is still a valid update.
      local,
      ...(secret ? { secret: encryptSecret(secret, keyring(deps)) } : {}),
    })
    .where(eq(schema.eventSubscriptions.id, id))
    .returning();
  await auditSubscription(deps.db, owner, 'event_subscription.update', id, {
    ...(patch.url !== undefined ? { origin: new URL(patch.url).origin } : {}),
    ...(patch.events !== undefined ? { events: patch.events } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(local !== row.local ? { local } : {}),
    ...(secret ? { rotatedSecret: true } : {}),
  });
  return { subscription: subscription!, ...(secret ? { secret } : {}) };
}

export async function deleteSubscription(db: Db, owner: Owner, id: string): Promise<void> {
  await getSubscription(db, owner, id);
  await db.delete(schema.eventSubscriptions).where(eq(schema.eventSubscriptions.id, id));
  await auditSubscription(db, owner, 'event_subscription.delete', id, {});
}

function auditSubscription(
  db: Db,
  owner: Owner,
  action: 'event_subscription.create' | 'event_subscription.update' | 'event_subscription.delete',
  id: string,
  metadata: Record<string, unknown>,
) {
  return recordAudit(db, {
    workspaceId: owner.workspaceId,
    actor: userActor(owner),
    action,
    targetType: 'event_subscription',
    targetId: id,
    metadata,
  });
}

/** The subscription's delivery log, newest first. */
export async function listEventDeliveries(
  db: Db,
  owner: Owner,
  id: string,
  limit = 50,
): Promise<EventDeliveryRow[]> {
  await getSubscription(db, owner, id);
  return db
    .select()
    .from(schema.eventDeliveries)
    .where(eq(schema.eventDeliveries.subscriptionId, id))
    .orderBy(desc(schema.eventDeliveries.createdAt), desc(schema.eventDeliveries.id))
    .limit(limit);
}

// Fan-out: bus events to deliveries

interface Outbound {
  type: OutboundEvent;
  /** The event's own id, so a repeat is sent once. */
  key: string;
  data: unknown;
}

/**
 * A `message.created` event's data. A webhook's message carries the payload
 * of whoever POSTed it, so it goes out as metadata only: its ids, chat and
 * author, and the id of the delivery that posted it (the message has the
 * delivery's id), whose log keeps the body (H5). Other messages go out whole.
 */
async function messageData(
  db: Db,
  message: Pick<Message, 'id' | 'authorType'> & { parts: unknown[] },
): Promise<unknown> {
  if (message.authorType !== 'webhook') return { message };
  const { parts: _parts, ...metadata } = message;
  const [delivery] = await db
    .select({ id: schema.webhookDeliveries.id })
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.id, message.id));
  return { message: metadata, deliveryId: delivery?.id ?? null };
}

/** The outbound events one bus event stands for (none for most). */
async function outboundFor(db: Db, event: WsEvent): Promise<Outbound[]> {
  switch (event.type) {
    case 'message.created': {
      const { message } = event.payload;
      if (message.status !== 'complete') return [];
      return [{ type: 'message.created', key: message.id, data: await messageData(db, message) }];
    }
    case 'message.completed': {
      if (event.payload.status !== 'complete') return [];
      const [row] = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, event.payload.messageId));
      if (!row) return [];
      return [
        { type: 'message.created', key: row.id, data: await messageData(db, toMessage(row)) },
      ];
    }
    case 'run.status': {
      const { status, runId } = event.payload;
      if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') return [];
      const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
      if (!run) return [];
      const out: Outbound[] = [];
      if (status === 'completed' || status === 'failed') {
        out.push({ type: `run.${status}`, key: run.id, data: { run: toRun(run) } });
      }
      if (run.trigger === 'routine') {
        const [record] = await db
          .select()
          .from(schema.routineRuns)
          .where(eq(schema.routineRuns.runId, run.id));
        if (record) {
          out.push({
            type: 'routine.ran',
            key: run.id,
            data: {
              routineId: record.routineId,
              routineRunId: record.id,
              reason: record.reason,
              run: toRun(run),
            },
          });
        }
      }
      return out;
    }
    case 'approval.requested':
      return [
        {
          type: 'approval.requested',
          key: event.payload.approval.id,
          data: { approval: event.payload.approval },
        },
      ];
    case 'artifact.created':
      return [{ type: 'artifact.created', key: event.payload.artifactId, data: event.payload }];
    default:
      return [];
  }
}

/** The owner an event belongs to, and in which organization, through its Bot or chat. */
async function ownerOf(
  db: Db,
  event: WsEvent,
): Promise<{ id: string; workspaceId: string } | null> {
  if (event.bot_id) {
    const [bot] = await db
      .select({ id: schema.bots.ownerId, workspaceId: schema.bots.workspaceId })
      .from(schema.bots)
      .where(eq(schema.bots.id, event.bot_id));
    if (bot) return bot;
  }
  if (event.chat_id) {
    const [chat] = await db
      .select({ id: schema.chats.ownerId, workspaceId: schema.chats.workspaceId })
      .from(schema.chats)
      .where(eq(schema.chats.id, event.chat_id));
    if (chat) return chat;
  }
  return event.user_id && event.workspace_id
    ? { id: event.user_id, workspaceId: event.workspace_id }
    : null;
}

/**
 * Records one delivery per enabled subscription of the event's owner that
 * asked for it, and queues each. Returns the rows created.
 */
export async function fanOut(deps: OutboundDeps, event: WsEvent): Promise<EventDeliveryRow[]> {
  const outbound = await outboundFor(deps.db, event);
  if (!outbound.length) return [];
  const owner = await ownerOf(deps.db, event);
  if (!owner) return [];
  const created: EventDeliveryRow[] = [];
  for (const item of outbound) {
    const subscriptions = await deps.db
      .select()
      .from(schema.eventSubscriptions)
      .where(
        and(
          subscriptionsOf(owner),
          eq(schema.eventSubscriptions.enabled, true),
          arrayContains(schema.eventSubscriptions.events, [item.type]),
        ),
      );
    for (const subscription of subscriptions) {
      const [row] = await deps.db
        .insert(schema.eventDeliveries)
        .values({
          workspaceId: subscription.workspaceId,
          subscriptionId: subscription.id,
          event: item.type,
          payload: item.data as object,
          status: 'pending' satisfies EventDeliveryStatus,
          dedupeKey: item.key,
          nextAttemptAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();
      if (!row) continue;
      created.push(row);
      await deps.infra
        .queue<EventDeliveryJob>(EVENT_DELIVERIES_QUEUE)
        .enqueue('deliver', { deliveryId: row.id, workspaceId: row.workspaceId });
    }
  }
  return created;
}

/** Listens to the bus in a worker process; stop with the returned function. */
export async function startEventFanOut(deps: OutboundDeps): Promise<() => Promise<void>> {
  return deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (event) => {
    // The event's organization first, then the work in it (db/scope.ts).
    const workspaceId = event.workspace_id;
    if (!workspaceId) return;
    inWorkspace(workspaceId, () => fanOut(deps, event)).catch((err: unknown) =>
      deps.logger.error({ err, type: event.type }, 'outbound event fan-out failed'),
    );
  });
}

// Delivery

/** The JSON body a subscriber receives. */
export function deliveryBody(row: EventDeliveryRow): string {
  return JSON.stringify({
    id: row.id,
    type: row.event,
    createdAt: new Date(row.createdAt).toISOString(),
    data: row.payload,
  });
}

/**
 * Sends one delivery. A 2xx marks it delivered; anything else counts an
 * attempt and queues a retry after `retryDelayMs`, until `MAX_ATTEMPTS`.
 * A subscription marked local may reach private addresses.
 */
export async function deliverEvent(
  deps: OutboundDeps,
  deliveryId: string,
  net: NetOptions = deps.net ?? {},
): Promise<EventDeliveryRow | null> {
  const [found] = await deps.db
    .select({ delivery: schema.eventDeliveries, subscription: schema.eventSubscriptions })
    .from(schema.eventDeliveries)
    .innerJoin(
      schema.eventSubscriptions,
      eq(schema.eventSubscriptions.id, schema.eventDeliveries.subscriptionId),
    )
    .where(eq(schema.eventDeliveries.id, deliveryId));
  if (!found || found.delivery.status !== 'pending') return found?.delivery ?? null;
  const { delivery, subscription } = found;
  const attempts = delivery.attempts + 1;
  let error: string | null = null;
  if (!subscription.enabled) {
    error = 'The subscription is disabled';
  } else {
    const body = deliveryBody(delivery);
    const secret = subscription.secret
      ? decryptSecretString(subscription.secret, keyring(deps))
      : '';
    try {
      const res = await guardedFetch(
        subscription.url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'OpenBots-Webhooks',
            'x-openbots-event': delivery.event,
            'x-openbots-delivery': delivery.id,
            [SIGNATURE_HEADER]: signPayload(secret, body, Math.floor(Date.now() / 1000)),
          },
          body,
        },
        RESPONSE_BYTES,
        {
          timeoutMs: 10_000,
          maxRedirects: 0,
          ...net,
          ...(subscription.local ? { allowPrivateNetwork: true } : {}),
        },
      );
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  const retry = error !== null && subscription.enabled && attempts < MAX_ATTEMPTS;
  const status: EventDeliveryStatus = error === null ? 'delivered' : retry ? 'pending' : 'failed';
  const delayMs = retryDelayMs(attempts);
  const [row] = await deps.db
    .update(schema.eventDeliveries)
    .set({
      attempts,
      status,
      lastError: error?.slice(0, 1_000) ?? null,
      nextAttemptAt: retry ? new Date(Date.now() + delayMs) : null,
    })
    .where(eq(schema.eventDeliveries.id, delivery.id))
    .returning();
  observeWebhook('outbound', error === null ? 'delivered' : retry ? 'retrying' : 'failed');
  if (retry) {
    await deps.infra
      .queue<EventDeliveryJob>(EVENT_DELIVERIES_QUEUE)
      .enqueue(
        'deliver',
        { deliveryId: delivery.id, workspaceId: delivery.workspaceId },
        { delayMs },
      );
  }
  return row ?? null;
}

/** The `event-deliveries` queue's handler; `net` is the test seam for local receivers. */
export function eventDeliveryHandler(
  deps: OutboundDeps,
  net: NetOptions = deps.net ?? {},
): JobHandler<EventDeliveryJob> {
  return async (job) => {
    await deliverEvent(deps, job.data.deliveryId, net);
  };
}

/**
 * Requeues pending deliveries whose in-process job died with the process
 * (in-memory infra only; Redis keeps delayed jobs across restarts).
 */
export async function requeuePendingEventDeliveries(deps: OutboundDeps, now = new Date()) {
  const pending = await deps.db
    .select({
      id: schema.eventDeliveries.id,
      workspaceId: schema.eventDeliveries.workspaceId,
      nextAttemptAt: schema.eventDeliveries.nextAttemptAt,
    })
    .from(schema.eventDeliveries)
    .where(eq(schema.eventDeliveries.status, 'pending' satisfies EventDeliveryStatus));
  for (const row of pending) {
    const delayMs = row.nextAttemptAt
      ? Math.max(0, row.nextAttemptAt.getTime() - now.getTime())
      : 0;
    await deps.infra
      .queue<EventDeliveryJob>(EVENT_DELIVERIES_QUEUE)
      .enqueue('deliver', { deliveryId: row.id, workspaceId: row.workspaceId }, { delayMs });
  }
  return pending.length;
}
