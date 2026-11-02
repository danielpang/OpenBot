import { z } from 'zod';

// Webhooks (plan 4.7, 11; H1 to H6, R2): what `webhook_endpoints.signature`
// and `.match` store, and the value sets of `webhook_deliveries.status`,
// `event_deliveries.status` and the outbound event names. The pipeline that
// reads them lives in the server's `hooks/` directory.

/** HMAC verification presets (H3); `generic` reads the header the endpoint names. */
export const WebhookSignaturePresetSchema = z.enum(['github', 'slack', 'stripe', 'generic']);
export type WebhookSignaturePreset = z.infer<typeof WebhookSignaturePresetSchema>;

/** `webhook_endpoints.signature`; the secret is sealed in `signature_secret`. */
export const WebhookSignatureSchema = z.strictObject({
  preset: WebhookSignaturePresetSchema,
  /** The signature header for `generic`; defaults to `X-Signature`. */
  header: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .optional(),
});
export type WebhookSignature = z.infer<typeof WebhookSignatureSchema>;

/**
 * The GitHub events a Routine can wait for (R2). GitHub issues are never
 * merged, so "issue created, merged or closed" is issue opened or closed.
 */
export const GithubEventSchema = z.enum([
  'issue_opened',
  'issue_closed',
  'pr_opened',
  'pr_merged',
  'pr_closed',
  'check_failed',
  'label_added',
  'comment_contains',
]);
export type GithubEvent = z.infer<typeof GithubEventSchema>;

/** A narrow rule over one GitHub event; every field given must match. */
export const GithubMatchSchema = z
  .strictObject({
    source: z.literal('github'),
    event: GithubEventSchema,
    /** `owner/name`, or `owner/*` for every repository of an owner. */
    repo: z.string().trim().min(1).max(200).optional(),
    /** The label added (`label_added`), case-insensitive. */
    label: z.string().trim().min(1).max(100).optional(),
    /** Text the comment contains (`comment_contains`), case-insensitive. */
    text: z.string().trim().min(1).max(500).optional(),
  })
  .refine((m) => m.event !== 'comment_contains' || m.text, {
    message: 'comment_contains needs the text to look for',
    path: ['text'],
  });

export const SlackEventSchema = z.enum(['message', 'reaction_added', 'channel_created']);
export type SlackEvent = z.infer<typeof SlackEventSchema>;

/** A narrow rule over one Slack Events API event (R2). */
export const SlackMatchSchema = z
  .strictObject({
    source: z.literal('slack'),
    event: SlackEventSchema,
    /** Channel id (`C0123...`) the message or reaction is in. */
    channel: z.string().trim().min(1).max(100).optional(),
    /** Text the message contains, case-insensitive. */
    text: z.string().trim().min(1).max(500).optional(),
    /** The reaction's emoji name, without colons. */
    emoji: z.string().trim().min(1).max(100).optional(),
    /** Channel name glob for `channel_created`, e.g. `proj-*`. */
    pattern: z.string().trim().min(1).max(100).optional(),
  })
  .refine((m) => m.event !== 'channel_created' || m.pattern, {
    message: 'channel_created needs a channel name pattern',
    path: ['pattern'],
  });

/** A condition on one field of a generic payload, by dotted path (`data.object.status`). */
export const WebhookConditionSchema = z.strictObject({
  path: z.string().trim().min(1).max(200),
  op: z.enum(['equals', 'contains', 'matches']),
  /** For `matches`, a regular expression (case-insensitive). */
  value: z.string().max(200),
});

/** Any other source (generic, Stripe): every condition must hold. */
export const GenericMatchSchema = z.strictObject({
  source: z.literal('webhook'),
  conditions: z.array(WebhookConditionSchema).min(1).max(10),
});

/** `webhook_endpoints.match`; null means every delivery matches. */
export const EndpointMatchSchema = z.discriminatedUnion('source', [
  GithubMatchSchema,
  SlackMatchSchema,
  GenericMatchSchema,
]);
export type EndpointMatch = z.infer<typeof EndpointMatchSchema>;

export const WebhookResponseModeSchema = z.enum(['async', 'sync']);

/**
 * `webhook_deliveries.status`: ignored when the matching rule said no (or the
 * Routine is paused), queued once its run is enqueued, failed when it could
 * not be, refused when it failed the IP, token or signature check (H5; kept
 * capped, and never matched, run or replayed).
 */
export const WebhookDeliveryStatusSchema = z.enum([
  'received',
  'ignored',
  'queued',
  'failed',
  'refused',
]);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>;

/** How a delivery arrived: from outside, a replay from the log, or the test form (H5). */
export const WebhookDeliveryOriginSchema = z.enum(['ingress', 'replay', 'test']);
export type WebhookDeliveryOrigin = z.infer<typeof WebhookDeliveryOriginSchema>;

/** What outbound subscriptions can receive (H6). */
export const OutboundEventSchema = z.enum([
  'message.created',
  'run.completed',
  'run.failed',
  'approval.requested',
  'routine.ran',
  'artifact.created',
]);
export type OutboundEvent = z.infer<typeof OutboundEventSchema>;

/** `event_deliveries.status`: pending through its retries, then delivered or failed. */
export const EventDeliveryStatusSchema = z.enum(['pending', 'delivered', 'failed']);
export type EventDeliveryStatus = z.infer<typeof EventDeliveryStatusSchema>;
