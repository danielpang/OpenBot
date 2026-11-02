import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  EndpointMatchSchema,
  EventTriggerSchema,
  WebhookSignatureSchema,
  type EndpointMatch,
  type TriggerOverride,
  type WebhookDeliveryOrigin,
  type WebhookDeliveryStatus,
  type WebhookSignature,
  type WebhookSignaturePreset,
} from '@openbots/shared';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { assertBotOwner } from '../ownership.js';
import { decryptSecretString, encryptSecret, keyringFromConfig } from '../secrets.js';
import { openFile, storeFile } from '../services/files.js';
import { openBotChat, postMessage } from '../services/messages.js';
import { startRoutineForEvent } from '../services/routines.js';
import { enqueueRun, type RunRow } from '../services/runs.js';
import { ensureInbox, INBOX_SLUG } from './inbox.js';
import { describeEvent, matchesRule, parseTriggerRule, type IncomingEvent } from './match.js';
import { frameEvent, renderTemplate } from './template.js';
import { generateSigningSecret, generateToken, hashToken, TOKEN_PREFIX } from './verify.js';

// Webhook endpoints and their delivery log (plan 4.7, 11; H1, H2, H5). An
// endpoint with no Routine is a Bot inbox: a delivery becomes a `webhook`
// message in the transcript and a `webhook` run at priority 2. One with a
// Routine is that Routine's event trigger: a matched delivery starts a
// `routine` run with a `routine_runs` record. Both post the payload framed as
// data (P2) and run under the endpoint's `tool_policy_override`.
//
// The ingress checks (size, IP, token, signature, rate, handshakes) are in
// ingress.ts; this file stores what passed them, matches and enqueues, and
// serves replay and the test form from the same path.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type HooksDeps = Pick<AppDeps, 'config' | 'db' | 'infra' | 'logger'>;

export type EndpointRow = typeof schema.webhookEndpoints.$inferSelect;
export type DeliveryRow = typeof schema.webhookDeliveries.$inferSelect;
type BotRow = typeof schema.bots.$inferSelect;
type RoutineRow = typeof schema.routines.$inferSelect;

export { INBOX_SLUG, hasToken, NO_TOKEN } from './inbox.js';
/** Seconds a sync delivery waits when the endpoint sets nothing: H4's "up to 60 seconds". */
export const DEFAULT_SYNC_TIMEOUT_S = 60;
export const MAX_SYNC_TIMEOUT_S = 60;

/**
 * Seconds a sync delivery to `endpoint` actually waits: its own timeout (60
 * when unset), capped by the admin's sync webhook wait and by H4's 60.
 */
export const syncWaitSeconds = (
  endpoint: Pick<EndpointRow, 'syncTimeoutS'>,
  limit: number,
): number => Math.min(endpoint.syncTimeoutS ?? DEFAULT_SYNC_TIMEOUT_S, limit, MAX_SYNC_TIMEOUT_S);
/**
 * Repeats of one `Idempotency-Key` or body inside this window are answered
 * once. Internal: it covers a sender's automatic retries, which come within
 * minutes; a later repeat is a new delivery on purpose (a manual redeliver).
 */
export const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;
/** Body text kept on the row for the log; the whole body is a file (`body_ref`). */
export const BODY_PREVIEW_BYTES = 16 * 1024;

/**
 * What the log keeps of a refused delivery (H5). Anyone can send one, so it
 * keeps less: a short body preview and no body file, at most `HEADERS` headers
 * of `HEADER_CHARS` each, and only the `KEPT` most recent per endpoint. The
 * failed-verification rate limit (per endpoint and address) runs first.
 */
export const REFUSED = { PREVIEW_BYTES: 2 * 1024, HEADERS: 40, HEADER_CHARS: 512, KEPT: 50 };

/** Headers never written to the delivery log. */
const REDACTED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-openbots-token',
]);

const keyring = (deps: Pick<AppDeps, 'config'>) => keyringFromConfig(deps.config);

/** Audit log (plan 17): who created, changed, rotated or deleted an endpoint. */
async function audit(
  db: Db,
  owner: Owner,
  action: 'webhook.create' | 'webhook.update' | 'webhook.rotate' | 'webhook.delete',
  endpointId: string,
  metadata: Record<string, unknown> = {},
) {
  await db.insert(schema.auditLog).values({
    workspaceId: owner.workspaceId,
    actorType: 'user',
    actorId: owner.id,
    action,
    targetType: 'webhook_endpoint',
    targetId: endpointId,
    metadata,
  });
}

const slugTaken = () =>
  new DomainError(409, 'SLUG_TAKEN', 'This Bot already has an endpoint with that slug');
const invalidEndpoint = (message: string) => new DomainError(400, 'INVALID_ENDPOINT', message);
const inboxRequired = (message: string) => new DomainError(409, 'INBOX_REQUIRED', message);

/** The Bot inbox (H1): no Routine, slug `inbox`. */
const isInbox = (endpoint: Pick<EndpointRow, 'routineId' | 'slug'>) =>
  !endpoint.routineId && endpoint.slug === INBOX_SLUG;

export interface EndpointInput {
  slug?: string;
  routineId?: string | null;
  signature?: (WebhookSignature & { secret?: string }) | null;
  match?: EndpointMatch | null;
  template?: string | null;
  responseMode?: 'async' | 'sync';
  syncTimeoutS?: number | null;
  toolPolicyOverride?: TriggerOverride | null;
  allowedIps?: string[];
  rateLimitPerMin?: number | null;
  enabled?: boolean;
}

export type EndpointPatch = Omit<EndpointInput, 'routineId'>;

export interface EndpointRecord {
  endpoint: EndpointRow;
  bot: Pick<BotRow, 'id' | 'handle'>;
}

/** What a create or rotate hands back once: the token, and a signing secret we chose. */
export interface IssuedEndpoint extends EndpointRecord {
  token: string;
  signingSecret?: string;
}

function checkSlug(slug: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(slug)) {
    throw invalidEndpoint('Slugs are lowercase letters, digits, - and _, at most 48');
  }
  if (slug.startsWith(TOKEN_PREFIX)) {
    throw invalidEndpoint(`Slugs cannot start with ${TOKEN_PREFIX}`);
  }
}

/** The sealed signing secret: given, or chosen for presets where we may choose it. */
function sealSignature(
  deps: Pick<AppDeps, 'config'>,
  signature: (WebhookSignature & { secret?: string }) | null | undefined,
): { stored: WebhookSignature | null; sealed: Buffer | null; chosen?: string } | undefined {
  if (signature === undefined) return undefined;
  if (signature === null) return { stored: null, sealed: null };
  const { secret, ...stored } = signature;
  const needsTheirs: WebhookSignaturePreset[] = ['slack', 'stripe'];
  if (!secret && needsTheirs.includes(signature.preset)) {
    throw new DomainError(
      400,
      'SIGNING_SECRET_REQUIRED',
      `Paste the signing secret ${signature.preset === 'slack' ? 'Slack' : 'Stripe'} shows for this endpoint`,
    );
  }
  const value = secret ?? generateSigningSecret();
  return {
    stored: WebhookSignatureSchema.parse(stored),
    sealed: encryptSecret(value, keyring(deps)),
    ...(secret ? {} : { chosen: value }),
  };
}

/** The event-triggered Routine of this Bot an endpoint serves; 400 for a schedule Routine. */
async function routineFor(db: Db, botId: string, routineId: string): Promise<RoutineRow> {
  const [routine] = await db
    .select()
    .from(schema.routines)
    .where(and(eq(schema.routines.id, routineId), eq(schema.routines.botId, botId)));
  if (!routine) throw notFound('Routine not found');
  if (!EventTriggerSchema.safeParse(routine.trigger).success) {
    throw invalidEndpoint('Only a Routine with an event trigger can have an endpoint');
  }
  return routine;
}

function checkMatchSource(match: EndpointMatch | null | undefined, routine: RoutineRow | null) {
  const trigger = routine ? EventTriggerSchema.safeParse(routine.trigger) : null;
  if (!match || !trigger?.success) return;
  if (match.source !== trigger.data.source) {
    throw invalidEndpoint(
      `The Routine waits for ${trigger.data.source} events; the rule is for ${match.source}`,
    );
  }
}

const botOf = async (db: Db, botId: string) => {
  const [bot] = await db
    .select({ id: schema.bots.id, handle: schema.bots.handle })
    .from(schema.bots)
    .where(eq(schema.bots.id, botId));
  if (!bot) throw notFound('Bot not found');
  return bot;
};

/** The Bot's endpoints, the inbox first; a Bot made before inboxes came with it gets one here. */
export async function listEndpoints(db: Db, owner: Owner, botId: string) {
  await assertBotOwner(db, owner, botId);
  const bot = await botOf(db, botId);
  await ensureInbox(db, { workspaceId: owner.workspaceId, botId });
  const rows = await db
    .select()
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.botId, botId))
    .orderBy(
      sql`${schema.webhookEndpoints.slug} <> ${INBOX_SLUG}`,
      schema.webhookEndpoints.createdAt,
    );
  return rows.map((endpoint) => ({ endpoint, bot }));
}

/** One of the owner's endpoints; another user's is 404. */
export async function getEndpoint(db: Db, owner: Owner, id: string): Promise<EndpointRecord> {
  const [endpoint] = await db
    .select()
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, id));
  if (!endpoint) throw notFound('Endpoint not found');
  await assertBotOwner(db, owner, endpoint.botId).catch(() => {
    throw notFound('Endpoint not found');
  });
  return { endpoint, bot: await botOf(db, endpoint.botId) };
}

/**
 * Creates an endpoint. Without a Routine and a slug it is the Bot's inbox
 * (`/hooks/{botHandle}`); with a Routine its slug defaults to the Routine's,
 * and the Routine's trigger records the endpoint id.
 */
export async function createEndpoint(
  deps: Pick<AppDeps, 'config' | 'db'>,
  owner: Owner,
  botId: string,
  input: EndpointInput,
): Promise<IssuedEndpoint> {
  await assertBotOwner(deps.db, owner, botId);
  const routine = input.routineId ? await routineFor(deps.db, botId, input.routineId) : null;
  const slug = input.slug ?? routine?.slug ?? INBOX_SLUG;
  checkSlug(slug);
  checkMatchSource(input.match, routine);
  const signature = sealSignature(deps, input.signature);
  const token = generateToken();
  const endpoint = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.webhookEndpoints)
      .values({
        workspaceId: owner.workspaceId,
        botId,
        routineId: routine?.id ?? null,
        slug,
        tokenHash: hashToken(token),
        signature: signature?.stored ?? null,
        signatureSecret: signature?.sealed ?? null,
        match: input.match ?? null,
        templateMd: input.template ?? null,
        responseMode: input.responseMode ?? 'async',
        syncTimeoutS: input.syncTimeoutS ?? null,
        toolPolicyOverride: input.toolPolicyOverride ?? null,
        allowedIps: input.allowedIps?.length ? input.allowedIps : null,
        rateLimitPerMin: input.rateLimitPerMin ?? null,
        enabled: input.enabled ?? true,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw slugTaken();
    if (routine) {
      const trigger = EventTriggerSchema.parse(routine.trigger);
      await tx
        .update(schema.routines)
        .set({ trigger: { ...trigger, endpoint_id: row.id } })
        .where(eq(schema.routines.id, routine.id));
    }
    await audit(tx, owner, 'webhook.create', row.id, { botId, slug });
    return row;
  });
  return {
    endpoint,
    bot: await botOf(deps.db, botId),
    token,
    ...(signature?.chosen ? { signingSecret: signature.chosen } : {}),
  };
}

export async function updateEndpoint(
  deps: Pick<AppDeps, 'config' | 'db'>,
  owner: Owner,
  id: string,
  patch: EndpointPatch,
): Promise<EndpointRecord & { signingSecret?: string }> {
  const { endpoint, bot } = await getEndpoint(deps.db, owner, id);
  if (patch.slug !== undefined && patch.slug !== endpoint.slug) {
    if (isInbox(endpoint)) throw inboxRequired('The inbox keeps the slug inbox');
    checkSlug(patch.slug);
    const [taken] = await deps.db
      .select({ id: schema.webhookEndpoints.id })
      .from(schema.webhookEndpoints)
      .where(
        and(
          eq(schema.webhookEndpoints.botId, endpoint.botId),
          eq(schema.webhookEndpoints.slug, patch.slug),
        ),
      );
    if (taken) throw slugTaken();
  }
  const routine = endpoint.routineId
    ? await routineFor(deps.db, endpoint.botId, endpoint.routineId)
    : null;
  checkMatchSource(patch.match, routine);
  const signature = sealSignature(deps, patch.signature);
  const [row] = await deps.db
    .update(schema.webhookEndpoints)
    .set({
      ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
      ...(signature ? { signature: signature.stored, signatureSecret: signature.sealed } : {}),
      ...(patch.match !== undefined ? { match: patch.match } : {}),
      ...(patch.template !== undefined ? { templateMd: patch.template } : {}),
      ...(patch.responseMode !== undefined ? { responseMode: patch.responseMode } : {}),
      ...(patch.syncTimeoutS !== undefined ? { syncTimeoutS: patch.syncTimeoutS } : {}),
      ...(patch.toolPolicyOverride !== undefined
        ? { toolPolicyOverride: patch.toolPolicyOverride }
        : {}),
      ...(patch.allowedIps !== undefined
        ? { allowedIps: patch.allowedIps.length ? patch.allowedIps : null }
        : {}),
      ...(patch.rateLimitPerMin !== undefined ? { rateLimitPerMin: patch.rateLimitPerMin } : {}),
      // Turned off here, it stays off until the owner turns it on (not on a trigger switch).
      ...(patch.enabled !== undefined
        ? { enabled: patch.enabled, disabledReason: patch.enabled ? null : ('owner' as const) }
        : {}),
    })
    .where(eq(schema.webhookEndpoints.id, id))
    .returning();
  if (!row) throw notFound('Endpoint not found');
  // The tool policy override and IP allowlist in full; other fields by name (S-11).
  await audit(deps.db, owner, 'webhook.update', id, {
    fields: Object.keys(patch).filter((k) => patch[k as keyof EndpointPatch] !== undefined),
    ...(patch.toolPolicyOverride !== undefined
      ? { toolPolicyOverride: patch.toolPolicyOverride }
      : {}),
    ...(patch.allowedIps !== undefined ? { allowedIps: patch.allowedIps } : {}),
  });
  return { endpoint: row, bot, ...(signature?.chosen ? { signingSecret: signature.chosen } : {}) };
}

/**
 * Deletes an endpoint and its delivery log; its Routine stays, without an
 * endpoint. The inbox cannot be deleted, only turned off.
 */
export async function deleteEndpoint(db: Db, owner: Owner, id: string): Promise<void> {
  const { endpoint } = await getEndpoint(db, owner, id);
  if (isInbox(endpoint)) {
    throw inboxRequired('Every Bot has an inbox. Turn it off in its settings instead');
  }
  await db.transaction(async (tx) => {
    if (endpoint.routineId) {
      const [routine] = await tx
        .select()
        .from(schema.routines)
        .where(eq(schema.routines.id, endpoint.routineId));
      const trigger = EventTriggerSchema.safeParse(routine?.trigger);
      if (trigger.success && trigger.data.endpoint_id === id) {
        await tx
          .update(schema.routines)
          .set({ trigger: { ...trigger.data, endpoint_id: null } })
          .where(eq(schema.routines.id, endpoint.routineId));
      }
    }
    await tx.delete(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, id));
    await audit(tx, owner, 'webhook.delete', id, { botId: endpoint.botId, slug: endpoint.slug });
  });
}

/** A new token (the first, for an inbox made with its Bot); the old one stops working at once. */
export async function rotateEndpointToken(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  id: string,
): Promise<IssuedEndpoint> {
  const { bot } = await getEndpoint(deps.db, owner, id);
  const token = generateToken();
  const [row] = await deps.db
    .update(schema.webhookEndpoints)
    .set({ tokenHash: hashToken(token) })
    .where(eq(schema.webhookEndpoints.id, id))
    .returning();
  await audit(deps.db, owner, 'webhook.rotate', id);
  return { endpoint: row!, bot, token };
}

/** The endpoint's signing secret, opened for verification. */
export function signingSecret(deps: Pick<AppDeps, 'config'>, endpoint: EndpointRow): string | null {
  return endpoint.signatureSecret
    ? decryptSecretString(endpoint.signatureSecret, keyring(deps))
    : null;
}

// The delivery log (H5)

/** Newest first, `limit` at a time before `before` (a `receivedAt`). */
export async function listDeliveries(
  db: Db,
  owner: Owner,
  endpointId: string,
  { limit = 50, before }: { limit?: number; before?: Date } = {},
): Promise<DeliveryRow[]> {
  await getEndpoint(db, owner, endpointId);
  return db
    .select()
    .from(schema.webhookDeliveries)
    .where(
      and(
        eq(schema.webhookDeliveries.endpointId, endpointId),
        before ? lt(schema.webhookDeliveries.receivedAt, before) : undefined,
      ),
    )
    .orderBy(desc(schema.webhookDeliveries.receivedAt), desc(schema.webhookDeliveries.id))
    .limit(limit);
}

export interface IncomingDelivery {
  /** Lowercased names. */
  headers: Record<string, string>;
  body: Buffer;
  remoteIp: string | null;
  verified: boolean;
  origin: WebhookDeliveryOrigin;
  /** `Idempotency-Key`; the body's sha256 when absent. Ingress only. */
  idempotencyKey?: string;
  replayOf?: string;
}

export interface AcceptedDelivery {
  delivery: DeliveryRow;
  run: RunRow | null;
  /** True when this answers a repeat of an earlier delivery (idempotency). */
  duplicate?: boolean;
}

export const bodyHash = (body: Buffer) => createHash('sha256').update(body).digest('hex');

/**
 * Stores the delivery, unless the same `Idempotency-Key` (or, without one,
 * the same body) reached this endpoint in the last 10 minutes, in which case
 * the earlier delivery comes back. A lock per (endpoint, key) makes two
 * concurrent repeats store one row.
 */
async function storeDelivery(
  deps: HooksDeps,
  endpoint: EndpointRow,
  incoming: IncomingDelivery,
): Promise<{ delivery: DeliveryRow; duplicate: boolean }> {
  const key =
    incoming.origin === 'ingress'
      ? (incoming.idempotencyKey?.slice(0, 200) ?? `sha256:${bodyHash(incoming.body)}`)
      : null;
  const headers = Object.fromEntries(redact(incoming.headers));
  const stored = await deps.db.transaction(async (tx) => {
    if (key) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`webhook:${endpoint.id}:${key}`}))`,
      );
      const [earlier] = await tx
        .select()
        .from(schema.webhookDeliveries)
        .where(
          and(
            eq(schema.webhookDeliveries.endpointId, endpoint.id),
            eq(schema.webhookDeliveries.idempotencyKey, key),
            gte(schema.webhookDeliveries.receivedAt, new Date(Date.now() - IDEMPOTENCY_WINDOW_MS)),
          ),
        )
        .orderBy(desc(schema.webhookDeliveries.receivedAt))
        .limit(1);
      if (earlier) return { delivery: earlier, duplicate: true };
    }
    const [row] = await tx
      .insert(schema.webhookDeliveries)
      .values({
        workspaceId: endpoint.workspaceId,
        endpointId: endpoint.id,
        remoteIp: incoming.remoteIp && isIP(incoming.remoteIp) ? incoming.remoteIp : null,
        headers,
        bodyPreview: incoming.body.subarray(0, BODY_PREVIEW_BYTES).toString('utf8'),
        verified: incoming.verified,
        status: 'received' satisfies WebhookDeliveryStatus,
        idempotencyKey: key,
        origin: incoming.origin,
        replayOf: incoming.replayOf ?? null,
      })
      .returning();
    return { delivery: row!, duplicate: false };
  });
  if (stored.duplicate || !incoming.body.length) return stored;
  // The whole body is a file of the Bot's owner, for replay and the log.
  const owner = await ownerOf(deps.db, endpoint.botId);
  const file = await storeFile(deps, owner, {
    name: `webhook-${endpoint.slug}-${stored.delivery.id}`,
    bytes: incoming.body,
    declaredMime: incoming.headers['content-type'],
    // Kept for replay and the delivery log, never listed or attached as a file.
    purpose: 'webhook_body',
  });
  const [row] = await deps.db
    .update(schema.webhookDeliveries)
    .set({ bodyRef: file.id })
    .where(eq(schema.webhookDeliveries.id, stored.delivery.id))
    .returning();
  return { delivery: row!, duplicate: false };
}

const redact = (headers: Record<string, string>) =>
  Object.entries(headers).filter(([name]) => !REDACTED_HEADERS.has(name));

/**
 * Logs a delivery that failed the IP, token or signature check, so the owner
 * can see why a sender's events never arrive (a wrong Stripe or Slack secret).
 * Capped as `REFUSED` says, with no idempotency key, so the sender's corrected
 * retry is not taken for a repeat.
 */
export async function recordRefusal(
  deps: Pick<AppDeps, 'db'>,
  endpoint: Pick<EndpointRow, 'id' | 'workspaceId'>,
  incoming: Pick<IncomingDelivery, 'headers' | 'body' | 'remoteIp'> & { reason: string },
): Promise<DeliveryRow> {
  const headers = Object.fromEntries(
    redact(incoming.headers)
      .slice(0, REFUSED.HEADERS)
      .map(([name, value]) => [name.slice(0, 100), value.slice(0, REFUSED.HEADER_CHARS)]),
  );
  const [row] = await deps.db
    .insert(schema.webhookDeliveries)
    .values({
      workspaceId: endpoint.workspaceId,
      endpointId: endpoint.id,
      remoteIp: incoming.remoteIp && isIP(incoming.remoteIp) ? incoming.remoteIp : null,
      headers,
      bodyPreview: incoming.body.subarray(0, REFUSED.PREVIEW_BYTES).toString('utf8'),
      verified: false,
      matched: false,
      status: 'refused' satisfies WebhookDeliveryStatus,
      error: incoming.reason.slice(0, 500),
      origin: 'ingress' satisfies WebhookDeliveryOrigin,
    })
    .returning();
  const stale = await deps.db
    .select({ id: schema.webhookDeliveries.id })
    .from(schema.webhookDeliveries)
    .where(
      and(
        eq(schema.webhookDeliveries.endpointId, endpoint.id),
        eq(schema.webhookDeliveries.status, 'refused' satisfies WebhookDeliveryStatus),
      ),
    )
    .orderBy(desc(schema.webhookDeliveries.receivedAt), desc(schema.webhookDeliveries.id))
    .offset(REFUSED.KEPT);
  if (stale.length) {
    await deps.db.delete(schema.webhookDeliveries).where(
      inArray(
        schema.webhookDeliveries.id,
        stale.map((r) => r.id),
      ),
    );
  }
  return row!;
}

async function ownerOf(db: Db, botId: string): Promise<Owner> {
  const [bot] = await db
    .select({ id: schema.bots.ownerId, workspaceId: schema.bots.workspaceId })
    .from(schema.bots)
    .where(eq(schema.bots.id, botId));
  if (!bot) throw notFound('Bot not found');
  return bot;
}

/** JSON when it parses, a form as an object, anything else as `{text}`. */
export function parsePayload(body: Buffer, contentType = ''): unknown {
  const text = body.toString('utf8');
  if (!text.trim()) return {};
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = Object.fromEntries(new URLSearchParams(text));
    // Slack interactivity sends its JSON in a `payload` field.
    if (typeof form['payload'] === 'string') {
      try {
        return JSON.parse(form['payload']);
      } catch {
        return form;
      }
    }
    return form;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/**
 * The endpoint's rule, or the Routine trigger's when the endpoint has none;
 * null when neither has one. A stored rule that no longer parses is
 * `invalid` and matches nothing, never everything.
 */
function ruleFor(
  endpoint: EndpointRow,
  routine: RoutineRow | null,
): EndpointMatch | null | 'invalid' {
  if (endpoint.match) {
    const own = EndpointMatchSchema.safeParse(endpoint.match);
    return own.success ? own.data : 'invalid';
  }
  const trigger = routine ? EventTriggerSchema.safeParse(routine.trigger) : null;
  if (trigger?.success && trigger.data.match) {
    const parsed = parseTriggerRule(trigger.data);
    return parsed.success ? parsed.data : 'invalid';
  }
  return null;
}

/**
 * Everything after the checks: store (or find the repeat), match, post the
 * framed payload into the transcript, enqueue the run, and record the
 * outcome on the delivery.
 */
export async function acceptDelivery(
  deps: HooksDeps,
  endpoint: EndpointRow,
  incoming: IncomingDelivery,
): Promise<AcceptedDelivery> {
  const stored = await storeDelivery(deps, endpoint, incoming);
  if (stored.duplicate) {
    const run = stored.delivery.runId ? await runById(deps.db, stored.delivery.runId) : null;
    return { delivery: stored.delivery, run, duplicate: true };
  }
  const { delivery } = stored;
  const finish = async (
    status: WebhookDeliveryStatus,
    values: { matched?: boolean; runId?: string | null; error?: string | null } = {},
  ) => {
    const [row] = await deps.db
      .update(schema.webhookDeliveries)
      .set({ status, ...values })
      .where(eq(schema.webhookDeliveries.id, delivery.id))
      .returning();
    return row!;
  };
  try {
    const routine = endpoint.routineId
      ? ((
          await deps.db
            .select()
            .from(schema.routines)
            .where(eq(schema.routines.id, endpoint.routineId))
        )[0] ?? null)
      : null;
    if (endpoint.routineId) {
      // An endpoint whose Routine stopped waiting on events, waits on another
      // endpoint, or is paused starts nothing. updateRoutine turns such
      // endpoints off; this is the check for any left on.
      if (!routine) throw notFound('Routine not found');
      const trigger = EventTriggerSchema.safeParse(routine.trigger);
      const refused = !trigger.success
        ? 'The Routine no longer has an event trigger'
        : trigger.data.endpoint_id && trigger.data.endpoint_id !== endpoint.id
          ? 'The Routine waits on another endpoint'
          : !routine.enabled
            ? 'The Routine is paused'
            : null;
      if (refused) {
        deps.logger.warn(
          { endpointId: endpoint.id, routineId: routine.id, deliveryId: delivery.id },
          `webhook refused: ${refused}`,
        );
        return { delivery: await finish('ignored', { matched: false, error: refused }), run: null };
      }
    }
    const event: IncomingEvent = {
      headers: incoming.headers,
      payload: parsePayload(incoming.body, incoming.headers['content-type']),
    };
    const rule = ruleFor(endpoint, routine);
    if (rule === 'invalid') {
      return {
        delivery: await finish('ignored', {
          matched: false,
          error: 'The stored matching rule is invalid; fix it to match deliveries again',
        }),
        run: null,
      };
    }
    if (!matchesRule(rule, event)) {
      return { delivery: await finish('ignored', { matched: false }), run: null };
    }
    const text = frameEvent(
      renderTemplate(endpoint.templateMd, { payload: event.payload, event: describeEvent(event) }),
      endpoint.slug,
      incoming.verified,
    );
    // The message takes the delivery's id, so outbound events can name the
    // delivery without carrying its payload (hooks/outbound.ts).
    const post = (chatId: string) =>
      postMessage(deps, chatId, {
        id: delivery.id,
        authorType: 'webhook',
        authorId: endpoint.id,
        parts: [{ type: 'text', text }],
      });
    const webhook = { endpointId: endpoint.id, deliveryId: delivery.id };
    let run: RunRow;
    if (routine) {
      const started = await startRoutineForEvent(deps, routine, { webhook }, async ({ run }) => {
        await post(run.chatId!);
      });
      if (!started || 'skipped' in started) {
        // Paused, or its Skill cannot run (S1, S2): the transcript says why.
        const error = started ? started.skipped : 'The Routine is paused';
        return { delivery: await finish('ignored', { matched: true, error }), run: null };
      }
      run = started.run;
    } else {
      const owner = await ownerOf(deps.db, endpoint.botId);
      const chat = await openBotChat(deps, owner, endpoint.botId);
      await post(chat.id);
      run = await enqueueRun(deps, {
        botId: endpoint.botId,
        chatId: chat.id,
        trigger: 'webhook',
        input: { webhook },
      });
    }
    return { delivery: await finish('queued', { matched: true, runId: run.id }), run };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finish('failed', { error: message.slice(0, 2_000) });
    throw error;
  }
}

async function runById(db: Db, runId: string): Promise<RunRow | null> {
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  return run ?? null;
}

/** Replays a logged delivery: same headers and body, a new delivery and run (H5). */
export async function replayDelivery(
  deps: HooksDeps,
  owner: Owner,
  endpointId: string,
  deliveryId: string,
): Promise<AcceptedDelivery> {
  const { endpoint } = await getEndpoint(deps.db, owner, endpointId);
  const [original] = await deps.db
    .select()
    .from(schema.webhookDeliveries)
    .where(
      and(
        eq(schema.webhookDeliveries.id, deliveryId),
        eq(schema.webhookDeliveries.endpointId, endpointId),
      ),
    );
  if (!original) throw notFound('Delivery not found');
  if (original.status === 'refused') {
    throw new DomainError(
      409,
      'NOT_REPLAYABLE',
      'This delivery failed verification, so it was never accepted and cannot be replayed',
    );
  }
  let body = Buffer.alloc(0);
  if (original.bodyRef) {
    const { stream } = await openFile(
      deps,
      await ownerOf(deps.db, endpoint.botId),
      original.bodyRef,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    body = Buffer.concat(chunks);
  }
  return acceptDelivery(deps, endpoint, {
    headers: original.headers as Record<string, string>,
    body,
    remoteIp: null,
    verified: original.verified,
    origin: 'replay',
    replayOf: original.id,
  });
}

/** The test form (H5): the owner's payload through matching and enqueueing, unverified. */
export async function testEndpoint(
  deps: HooksDeps,
  owner: Owner,
  endpointId: string,
  input: { payload: unknown; headers?: Record<string, string> },
): Promise<AcceptedDelivery> {
  const { endpoint } = await getEndpoint(deps.db, owner, endpointId);
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return acceptDelivery(deps, endpoint, {
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify(input.payload ?? {})),
    remoteIp: null,
    verified: false,
    origin: 'test',
  });
}
