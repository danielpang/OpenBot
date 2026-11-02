import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  boolean,
  cidr,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { bots } from './bots.js';
import { bytea, createdAt, id, timestamptz } from './columns.js';
import { routines } from './prompts.js';
import { runs } from './runs.js';
import { workspaceId } from './workspace.js';

// Plan 4.7: Webhooks (H1 to H6).

export const webhookResponseMode = pgEnum('webhook_response_mode', ['async', 'sync']);

/** `routine_id` null means the Bot inbox (H1); set means a Routine event trigger (H2). */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: id(),
    workspaceId: workspaceId(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    routineId: uuid('routine_id').references(() => routines.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Signature preset and header; the secret itself is in `signature_secret`. */
    signature: jsonb('signature'),
    signatureSecret: bytea('signature_secret'),
    match: jsonb('match'),
    templateMd: text('template_md'),
    responseMode: webhookResponseMode('response_mode').notNull().default('async'),
    syncTimeoutS: integer('sync_timeout_s'),
    toolPolicyOverride: jsonb('tool_policy_override'),
    allowedIps: cidr('allowed_ips').array(),
    rateLimitPerMin: integer('rate_limit_per_min'),
    enabled: boolean('enabled').notNull().default(true),
    /**
     * Why `enabled` is false: `owner` (turned off in its settings) or
     * `trigger_switch` (its Routine's trigger stopped being an event). Only
     * `trigger_switch` endpoints come back on when the trigger switches back.
     */
    disabledReason: text('disabled_reason').$type<'owner' | 'trigger_switch'>(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.botId, t.slug)],
);

/** H5. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    workspaceId: workspaceId(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
    remoteIp: inet('remote_ip'),
    headers: jsonb('headers').notNull().default({}),
    bodyRef: text('body_ref'),
    bodyPreview: text('body_preview'),
    verified: boolean('verified').notNull().default(false),
    matched: boolean('matched').notNull().default(false),
    status: text('status').notNull(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    error: text('error'),
    /** `Idempotency-Key`, or the body's sha256; a repeat within 10 minutes is answered once. */
    idempotencyKey: text('idempotency_key'),
    /** ingress, replay or test (H5). */
    origin: text('origin').notNull().default('ingress'),
    replayOf: uuid('replay_of').references((): AnyPgColumn => webhookDeliveries.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('webhook_deliveries_endpoint_received').on(t.endpointId, t.receivedAt),
    index('webhook_deliveries_idempotency').on(t.endpointId, t.idempotencyKey),
  ],
);

/** Outbound event subscriptions (H6). */
export const eventSubscriptions = pgTable('event_subscriptions', {
  id: id(),
  workspaceId: workspaceId(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  url: text('url').notNull(),
  events: text('events').array().notNull().default([]),
  secret: bytea('secret'),
  enabled: boolean('enabled').notNull().default(true),
  /** An admin marked the receiver as on their own network, so it may be a private address (S-8). */
  local: boolean('local').notNull().default(false),
  createdAt: createdAt(),
});

export const eventDeliveries = pgTable(
  'event_deliveries',
  {
    id: id(),
    workspaceId: workspaceId(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => eventSubscriptions.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: jsonb('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    status: text('status').notNull(),
    lastError: text('last_error'),
    nextAttemptAt: timestamptz('next_attempt_at'),
    createdAt: createdAt(),
    /** The event's own id (message, run, approval, artifact): each goes out once per subscription. */
    dedupeKey: text('dedupe_key'),
  },
  (t) => [
    unique('event_deliveries_dedupe').on(t.subscriptionId, t.event, t.dedupeKey),
    index('event_deliveries_subscription_created').on(t.subscriptionId, t.createdAt),
  ],
);
