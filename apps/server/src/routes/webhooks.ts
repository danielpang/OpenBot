import { createRoute, z } from '@hono/zod-openapi';
import {
  EndpointMatchSchema,
  EventDeliveryStatusSchema,
  OutboundEventSchema,
  TriggerOverrideSchema,
  WebhookDeliveryOriginSchema,
  WebhookDeliveryStatusSchema,
  WebhookResponseModeSchema,
  WebhookSignaturePresetSchema,
  WebhookSignatureSchema,
} from '@openbots/shared';
import type { Context } from 'hono';
import type { Config } from '../config.js';
import type { AppEnv } from '../context.js';
import {
  createEndpoint,
  deleteEndpoint,
  hasToken,
  INBOX_SLUG,
  listDeliveries,
  listEndpoints,
  MAX_SYNC_TIMEOUT_S,
  replayDelivery,
  rotateEndpointToken,
  syncWaitSeconds,
  testEndpoint,
  updateEndpoint,
  type AcceptedDelivery,
  type DeliveryRow,
  type EndpointRecord,
} from '../hooks/endpoints.js';
import {
  createSubscription,
  deleteSubscription,
  listEventDeliveries,
  listSubscriptions,
  updateSubscription,
  type EventDeliveryRow,
  type SubscriptionRow,
} from '../hooks/outbound.js';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import { organizationSettings } from '../workspace.js';

// Webhook endpoints, their delivery log and outbound event subscriptions
// (plan 11, 14.1; H1 to H6). Owner-scoped through the Bot; another user's Bot,
// endpoint or subscription is 404. Tokens and signing secrets are returned
// once, when issued, and never again. The ingress itself is `/hooks/...`
// (hooks/ingress.ts), outside this API.

const MatchSchema = EndpointMatchSchema.describe(
  'A narrow rule over one event: `{source: "github", event, repo?, label?, text?}`, `{source: "slack", event, channel?, text?, emoji?, pattern?}` or `{source: "webhook", conditions}`',
).openapi('EndpointMatch');

const OverrideSchema = TriggerOverrideSchema.describe(
  'Stricter-only decisions for runs this endpoint starts (`{default?, groups?, tools?}`)',
).openapi('TriggerOverride');

const cidr = z
  .string()
  .regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/, 'An IP address or CIDR range')
  .openapi({ example: '192.30.252.0/22' });

const EndpointSchema = z
  .object({
    id: z.uuid(),
    botId: z.uuid(),
    routineId: z.uuid().nullable().openapi({ description: 'Null for the Bot inbox (H1)' }),
    slug: z.string(),
    url: z.string().openapi({ description: 'Where senders POST' }),
    hasToken: z.boolean().openapi({
      description:
        'False for an inbox whose token was never generated; it refuses deliveries until rotate issues one',
    }),
    signature: z
      .object({
        preset: WebhookSignaturePresetSchema,
        header: z.string().optional(),
        hasSecret: z.boolean(),
      })
      .nullable(),
    match: MatchSchema.nullable(),
    template: z.string().nullable(),
    responseMode: WebhookResponseModeSchema,
    syncTimeoutS: z.number().int().nullable(),
    syncWaitS: z.number().int().openapi({
      description:
        "Seconds a sync delivery actually waits: `syncTimeoutS` (60 when unset), capped by the admin's sync webhook wait and by 60",
    }),
    toolPolicyOverride: OverrideSchema.nullable(),
    allowedIps: z.array(z.string()),
    rateLimitPerMin: z.number().int().nullable(),
    enabled: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .openapi('WebhookEndpoint');

const IssuedEndpointSchema = z
  .object({
    endpoint: EndpointSchema,
    token: z.string().optional().openapi({ description: 'Shown once; send it as a bearer token' }),
    signingSecret: z
      .string()
      .optional()
      .openapi({ description: 'Shown once, when OpenBots chose it (GitHub, generic)' }),
  })
  .openapi('IssuedWebhookEndpoint');

const SignatureInputSchema = z
  .strictObject({
    ...WebhookSignatureSchema.shape,
    secret: z.string().min(8).max(500).optional().openapi({
      description: 'Required for Slack and Stripe; OpenBots chooses one for GitHub and generic',
    }),
  })
  .openapi('WebhookSignatureInput');

const slug = z.string().min(1).max(48);
const fields = {
  signature: SignatureInputSchema.nullable().optional(),
  match: MatchSchema.nullable().optional(),
  template: z.string().max(8_000).nullable().optional(),
  responseMode: WebhookResponseModeSchema.optional(),
  syncTimeoutS: z.number().int().min(1).max(MAX_SYNC_TIMEOUT_S).nullable().optional(),
  toolPolicyOverride: OverrideSchema.nullable().optional(),
  allowedIps: z.array(cidr).max(50).optional(),
  rateLimitPerMin: z.number().int().min(1).max(10_000).nullable().optional(),
  enabled: z.boolean().optional(),
};

const CreateEndpointSchema = z
  .strictObject({
    slug: slug.optional().openapi({
      description: "Defaults to `inbox` without a Routine, else the Routine's slug",
    }),
    routineId: z.uuid().nullable().optional(),
    ...fields,
  })
  .openapi('CreateWebhookEndpoint');

const UpdateEndpointSchema = z
  .strictObject({ slug: slug.optional(), ...fields })
  .openapi('UpdateWebhookEndpoint');

const DeliverySchema = z
  .object({
    id: z.uuid(),
    endpointId: z.uuid(),
    receivedAt: z.iso.datetime(),
    remoteIp: z.string().nullable(),
    headers: z.record(z.string(), z.string()),
    body: z
      .string()
      .nullable()
      .openapi({ description: 'The first 16 KB of the body (2 KB for a refused delivery)' }),
    bodyFileId: z.uuid().nullable().openapi({ description: 'The whole body, at /files/{id}' }),
    verified: z.boolean().openapi({
      description:
        'Passed the token or signature check; false for the test form and for a refused delivery',
    }),
    matched: z.boolean(),
    status: WebhookDeliveryStatusSchema,
    runId: z.uuid().nullable(),
    error: z.string().nullable(),
    origin: WebhookDeliveryOriginSchema,
    replayOf: z.uuid().nullable(),
  })
  .openapi('WebhookDelivery');

const AcceptedSchema = z
  .object({ delivery: DeliverySchema, runId: z.uuid().nullable() })
  .openapi('WebhookDeliveryResult');

const SubscriptionSchema = z
  .object({
    id: z.uuid(),
    url: z.string(),
    events: z.array(OutboundEventSchema),
    enabled: z.boolean(),
    local: z.boolean().openapi({
      description:
        'An admin marked the receiver as on their own network, so it may be on a private or local address (S-8)',
    }),
    createdAt: z.iso.datetime(),
  })
  .openapi('EventSubscription');

const IssuedSubscriptionSchema = z
  .object({
    subscription: SubscriptionSchema,
    secret: z.string().optional().openapi({
      description:
        'Shown once. Deliveries carry `X-OpenBots-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`',
    }),
  })
  .openapi('IssuedEventSubscription');

const url = z.url({ protocol: /^https?$/ }).max(2_000);
const events = z.array(OutboundEventSchema).min(1);
const local = z.boolean().openapi({
  description:
    'Admins only. The receiver runs on your own network (n8n on the compose network, a LAN host). Without it a URL on a private, local or unresolvable host is refused (`PRIVATE_HOST`). Changing the URL clears it unless the same request sets it',
});

const CreateSubscriptionSchema = z
  .strictObject({ url, events, enabled: z.boolean().optional(), local: local.optional() })
  .openapi('CreateEventSubscription');

const UpdateSubscriptionSchema = z
  .strictObject({
    url: url.optional(),
    events: events.optional(),
    enabled: z.boolean().optional(),
    local: local.optional(),
    rotateSecret: z.boolean().optional(),
  })
  .openapi('UpdateEventSubscription');

const EventDeliverySchema = z
  .object({
    id: z.uuid(),
    subscriptionId: z.uuid(),
    event: OutboundEventSchema,
    payload: z.unknown(),
    attempts: z.number().int(),
    status: EventDeliveryStatusSchema,
    lastError: z.string().nullable(),
    nextAttemptAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('EventDelivery');

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/**
 * An endpoint's public URL. It names the Bot by handle on a self-hosted
 * install and by id on the managed service, where handles are unique only
 * per (organization, owner) (plan 21.3).
 */
export function endpointUrl(
  config: Pick<Config, 'publicUrl' | 'deployment'>,
  bot: { id: string; handle: string },
  slug: string,
) {
  const base = config.publicUrl.replace(/\/$/, '');
  const name = config.deployment === 'managed' ? bot.id : bot.handle;
  return slug === INBOX_SLUG ? `${base}/hooks/${name}` : `${base}/hooks/${name}/${slug}`;
}

/** The organization's sync webhook wait, which caps every endpoint's (H4). */
async function syncWaitLimit(c: Context<AppEnv>): Promise<number> {
  return (await organizationSettings(c.var.deps, c.var.user.workspaceId)).limits
    .syncWebhookWaitSeconds;
}

function toEndpoint(
  config: Pick<Config, 'publicUrl' | 'deployment'>,
  { endpoint, bot }: EndpointRecord,
  waitLimit: number,
): z.infer<typeof EndpointSchema> {
  const signature = WebhookSignatureSchema.safeParse(endpoint.signature);
  const match = EndpointMatchSchema.safeParse(endpoint.match);
  const override = TriggerOverrideSchema.safeParse(endpoint.toolPolicyOverride);
  return {
    id: endpoint.id,
    botId: endpoint.botId,
    routineId: endpoint.routineId,
    slug: endpoint.slug,
    url: endpointUrl(config, bot, endpoint.slug),
    hasToken: hasToken(endpoint),
    signature: signature.success
      ? { ...signature.data, hasSecret: Boolean(endpoint.signatureSecret) }
      : null,
    match: match.success ? match.data : null,
    template: endpoint.templateMd,
    responseMode: endpoint.responseMode,
    syncTimeoutS: endpoint.syncTimeoutS,
    syncWaitS: syncWaitSeconds(endpoint, waitLimit),
    toolPolicyOverride: override.success ? override.data : null,
    allowedIps: endpoint.allowedIps ?? [],
    rateLimitPerMin: endpoint.rateLimitPerMin,
    enabled: endpoint.enabled,
    createdAt: new Date(endpoint.createdAt).toISOString(),
  };
}

function toDelivery(row: DeliveryRow): z.infer<typeof DeliverySchema> {
  return {
    id: row.id,
    endpointId: row.endpointId,
    receivedAt: new Date(row.receivedAt).toISOString(),
    remoteIp: row.remoteIp,
    headers: row.headers as Record<string, string>,
    body: row.bodyPreview,
    bodyFileId: row.bodyRef,
    verified: row.verified,
    matched: row.matched,
    status: WebhookDeliveryStatusSchema.catch('received').parse(row.status),
    runId: row.runId,
    error: row.error,
    origin: WebhookDeliveryOriginSchema.catch('ingress').parse(row.origin),
    replayOf: row.replayOf,
  };
}

const toAccepted = ({ delivery, run }: AcceptedDelivery) => ({
  delivery: toDelivery(delivery),
  runId: run?.id ?? null,
});

function toSubscription(row: SubscriptionRow): z.infer<typeof SubscriptionSchema> {
  return {
    id: row.id,
    url: row.url,
    events: row.events.filter((e) => OutboundEventSchema.safeParse(e).success) as z.infer<
      typeof OutboundEventSchema
    >[],
    enabled: row.enabled,
    local: row.local,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

function toEventDelivery(row: EventDeliveryRow): z.infer<typeof EventDeliverySchema> {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    event: OutboundEventSchema.parse(row.event),
    payload: row.payload,
    attempts: row.attempts,
    status: EventDeliveryStatusSchema.catch('pending').parse(row.status),
    lastError: row.lastError,
    nextAttemptAt: iso(row.nextAttemptAt),
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

const params = z.object({ id: z.uuid() });
const json = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } }, required: true },
});

export const webhookRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/bots/{id}/endpoints',
      tags: ['webhooks'],
      summary: "A Bot's webhook endpoints, the inbox first",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: json('Endpoints', z.object({ items: z.array(EndpointSchema) })),
        ...authProblems,
        404: problemResponse('No such Bot'),
      },
    }),
    async (c) => {
      const rows = await listEndpoints(c.var.deps.db, c.var.user, c.req.valid('param').id);
      const limit = await syncWaitLimit(c);
      return c.json({ items: rows.map((r) => toEndpoint(c.var.deps.config, r, limit)) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/bots/{id}/endpoints',
      tags: ['webhooks'],
      summary: 'Create an endpoint, e.g. a Routine event trigger (every Bot already has its inbox)',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params, ...body(CreateEndpointSchema) },
      responses: {
        201: json('The endpoint with its token, shown once', IssuedEndpointSchema),
        400: problemResponse('INVALID_ENDPOINT or SIGNING_SECRET_REQUIRED'),
        ...authProblems,
        404: problemResponse('No such Bot or Routine'),
        409: problemResponse('SLUG_TAKEN'),
      },
    }),
    async (c) => {
      const issued = await createEndpoint(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('json'),
      );
      return c.json(
        {
          endpoint: toEndpoint(c.var.deps.config, issued, await syncWaitLimit(c)),
          token: issued.token,
          ...(issued.signingSecret ? { signingSecret: issued.signingSecret } : {}),
        },
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/endpoints/{id}',
      tags: ['webhooks'],
      summary: 'Edit an endpoint',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params, ...body(UpdateEndpointSchema) },
      responses: {
        200: json(
          'The endpoint, with a signing secret when OpenBots chose a new one',
          IssuedEndpointSchema,
        ),
        400: problemResponse('INVALID_ENDPOINT or SIGNING_SECRET_REQUIRED'),
        ...authProblems,
        404: problemResponse('No such endpoint'),
        409: problemResponse('SLUG_TAKEN, or INBOX_REQUIRED for a new inbox slug'),
      },
    }),
    async (c) => {
      const updated = await updateEndpoint(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('json'),
      );
      return c.json(
        {
          endpoint: toEndpoint(c.var.deps.config, updated, await syncWaitLimit(c)),
          ...(updated.signingSecret ? { signingSecret: updated.signingSecret } : {}),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/endpoints/{id}',
      tags: ['webhooks'],
      summary: 'Delete an endpoint and its delivery log',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        204: { description: 'Deleted' },
        ...authProblems,
        404: problemResponse('No such endpoint'),
        409: problemResponse('INBOX_REQUIRED: the inbox can be turned off, not deleted'),
      },
    }),
    async (c) => {
      await deleteEndpoint(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/endpoints/{id}/rotate',
      tags: ['webhooks'],
      summary: 'Issue a new token (the first, for a new inbox); the old one stops working',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: json('The endpoint with its new token, shown once', IssuedEndpointSchema),
        ...authProblems,
        404: problemResponse('No such endpoint'),
      },
    }),
    async (c) => {
      const issued = await rotateEndpointToken(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json(
        {
          endpoint: toEndpoint(c.var.deps.config, issued, await syncWaitLimit(c)),
          token: issued.token,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/endpoints/{id}/deliveries',
      tags: ['webhooks'],
      summary: 'The delivery log, newest first (H5)',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params,
        query: z.object({
          before: z.iso.datetime().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: {
        200: json('Deliveries', z.object({ items: z.array(DeliverySchema) })),
        ...authProblems,
        404: problemResponse('No such endpoint'),
      },
    }),
    async (c) => {
      const { before, limit } = c.req.valid('query');
      const rows = await listDeliveries(c.var.deps.db, c.var.user, c.req.valid('param').id, {
        ...(limit ? { limit } : {}),
        ...(before ? { before: new Date(before) } : {}),
      });
      return c.json({ items: rows.map(toDelivery) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/endpoints/{id}/deliveries/{did}/replay',
      tags: ['webhooks'],
      summary: 'Replay a delivery: same headers and body, a new delivery and run',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: z.object({ id: z.uuid(), did: z.uuid() }) },
      responses: {
        201: json('The new delivery', AcceptedSchema),
        ...authProblems,
        404: problemResponse('No such endpoint or delivery'),
        409: problemResponse('NOT_REPLAYABLE: the delivery failed verification'),
      },
    }),
    async (c) => {
      const { id, did } = c.req.valid('param');
      const accepted = await replayDelivery(c.var.deps, c.var.user, id, did);
      return c.json(toAccepted(accepted), 201);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/endpoints/{id}/test',
      tags: ['webhooks'],
      summary: 'Send a test event through matching and into a run (unverified)',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params,
        ...body(
          z
            .strictObject({
              payload: z.unknown(),
              headers: z.record(z.string(), z.string().max(2_000)).optional().openapi({
                description: 'E.g. `{"X-GitHub-Event": "pull_request"}` to test a GitHub rule',
              }),
            })
            .openapi('WebhookTestEvent'),
        ),
      },
      responses: {
        201: json('The test delivery', AcceptedSchema),
        ...authProblems,
        404: problemResponse('No such endpoint'),
      },
    }),
    async (c) => {
      const accepted = await testEndpoint(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('json'),
      );
      return c.json(toAccepted(accepted), 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/event-subscriptions',
      tags: ['webhooks'],
      summary: 'Outbound event subscriptions (H6)',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: json('Subscriptions', z.object({ items: z.array(SubscriptionSchema) })),
        ...authProblems,
      },
    }),
    async (c) => {
      const rows = await listSubscriptions(c.var.deps.db, c.var.user);
      return c.json({ items: rows.map(toSubscription) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/event-subscriptions',
      tags: ['webhooks'],
      summary: 'Subscribe a URL to events; the signing secret is shown once',
      middleware: [requireUser] as const,
      security: authenticated,
      request: body(CreateSubscriptionSchema),
      responses: {
        201: json('The subscription and its secret', IssuedSubscriptionSchema),
        400: problemResponse('INVALID_URL, or PRIVATE_HOST for a receiver not marked local'),
        ...authProblems,
        403: problemResponse('Only an admin can mark a subscription local'),
      },
    }),
    async (c) => {
      const { subscription, secret } = await createSubscription(
        c.var.deps,
        c.var.user,
        c.req.valid('json'),
      );
      return c.json({ subscription: toSubscription(subscription), secret }, 201);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/event-subscriptions/{id}',
      tags: ['webhooks'],
      summary: 'Edit a subscription, or rotate its secret',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params, ...body(UpdateSubscriptionSchema) },
      responses: {
        200: json(
          'The subscription, with the new secret after a rotation',
          IssuedSubscriptionSchema,
        ),
        400: problemResponse('INVALID_URL, or PRIVATE_HOST for a receiver not marked local'),
        ...authProblems,
        403: problemResponse('Only an admin can mark a subscription local'),
        404: problemResponse('No such subscription'),
      },
    }),
    async (c) => {
      const { subscription, secret } = await updateSubscription(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('json'),
      );
      return c.json(
        { subscription: toSubscription(subscription), ...(secret ? { secret } : {}) },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/event-subscriptions/{id}',
      tags: ['webhooks'],
      summary: 'Delete a subscription and its delivery log',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        204: { description: 'Deleted' },
        ...authProblems,
        404: problemResponse('No such subscription'),
      },
    }),
    async (c) => {
      await deleteSubscription(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/event-subscriptions/{id}/deliveries',
      tags: ['webhooks'],
      summary: "A subscription's deliveries with attempts and errors, newest first",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: json('Deliveries', z.object({ items: z.array(EventDeliverySchema) })),
        ...authProblems,
        404: problemResponse('No such subscription'),
      },
    }),
    async (c) => {
      const rows = await listEventDeliveries(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.json({ items: rows.map(toEventDelivery) }, 200);
    },
  );
