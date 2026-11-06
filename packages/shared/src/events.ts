import { z } from 'zod';

// The realtime protocol on `/ws` (plan 14.2). Workers publish these events on
// the event bus; API instances forward each one to the sockets subscribed to
// its chat or Bot.
//
// Append-only: later phases add payload fields and new event types, never
// rename or remove one. Payload objects are loose so an older client ignores
// fields it does not know. The envelope is snake_case (`chat_id`, `bot_id`);
// payloads carry camelCase fields like the REST API.

/** The bus channel every realtime event is published on. */
export const EVENTS_CHANNEL = 'openbots:events';

const id = z.string().min(1);
const nullableId = id.nullable();
const timestamp = z.string();

export const BotStateKindSchema = z.enum([
  'idle',
  'thinking',
  'working',
  'waiting',
  'blocked',
  'done',
]);

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]);

export const RunStepTypeSchema = z.enum([
  'llm',
  'tool_call',
  'tool_result',
  'approval',
  'steer',
  'error',
]);

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);

export const ParticipantTypeSchema = z.enum(['user', 'bot']);

/** A transcript message as the API returns it (plan 4.2). */
export const MessageSchema = z.looseObject({
  id,
  chatId: id,
  seq: z.number().int(),
  threadRootId: nullableId.optional(),
  authorType: z.enum(['user', 'bot', 'system', 'webhook', 'routine']),
  authorId: nullableId,
  /** Ordered parts (text, image, file, tool_call, ...); typed by the message-parts module. */
  parts: z.array(z.unknown()),
  runId: nullableId.optional(),
  status: z.enum(['complete', 'streaming', 'failed']),
  createdAt: timestamp,
  /** The last `message.delta` the stored parts include; skip deltas at or below it. */
  deltaSeq: z.number().int().nonnegative().optional(),
});

export const UsageSchema = z.looseObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const RunStepSchema = z.looseObject({
  id,
  runId: id,
  idx: z.number().int().nonnegative(),
  type: RunStepTypeSchema,
  /** The activity log line (I4). */
  label: z.string().nullable(),
});

export const ApprovalSchema = z.looseObject({
  id,
  /** Null for a coding session's request on the owner's own turn. */
  runId: nullableId,
  toolName: z.string(),
  args: z.unknown(),
  reason: z.string().nullable(),
  status: ApprovalStatusSchema,
});

export const WidgetStateSchema = z.looseObject({
  messageId: id,
  partIndex: z.number().int().nonnegative(),
  state: z.unknown(),
  pendingRunId: nullableId,
});

/** A device in `device.paired`, `device.revoked` and `device.updated`. */
export const DeviceEventSchema = z.looseObject({
  id,
  name: z.string(),
  platform: z.enum(['ios', 'android', 'desktop']),
  createdAt: timestamp,
  revokedAt: timestamp.nullable().optional(),
});

/** Payload schema per event type. */
export const EVENT_PAYLOADS = {
  'message.created': z.looseObject({ message: MessageSchema }),
  /**
   * Coalesced part deltas for a streaming message, numbered per message by
   * `deltaSeq` (1, 2, ...). Apply with `applyMessageDelta` from the parts module.
   */
  'message.delta': z.looseObject({
    messageId: id,
    deltaSeq: z.number().int().positive(),
    deltas: z.array(
      z.looseObject({
        partIndex: z.number().int().nonnegative(),
        type: z.string(),
        /** Text to append to the part; empty when `part` replaces it. */
        text: z.string(),
        /** A whole part to set at `partIndex`. */
        part: z.looseObject({ type: z.string() }).optional(),
      }),
    ),
  }),
  'message.completed': z.looseObject({
    messageId: id,
    /** The final `deltaSeq`; the stored parts are complete through it. */
    deltaSeq: z.number().int().nonnegative().optional(),
    status: z.enum(['complete', 'failed']),
    usage: UsageSchema.optional(),
  }),
  /**
   * A streaming Bot message removed before it showed anything: the worker
   * that opened it lost its run to another (K4), or the run ended first. The
   * envelope's `seq` is the message's; resync lists it under `deleted`.
   */
  'message.deleted': z.looseObject({
    messageId: id,
    chatId: id,
    /** The thread it was a reply in, so a client can correct the root's reply count. */
    threadRootId: nullableId.optional(),
  }),
  'bot.state': z.looseObject({
    botId: id,
    state: BotStateKindSchema,
    currentAction: z.string().nullable(),
    runId: nullableId,
    /** The tool running while `working`; a computer tool lights the title-bar icon (I5). */
    currentTool: z.string().nullable().optional(),
  }),
  'run.status': z.looseObject({
    runId: id,
    status: RunStatusSchema,
    error: z.string().nullable().optional(),
    /** What started the run (`message`, `routine`, ...). */
    trigger: z.string().optional(),
    /** When the run first started running, and when it ended; null until then. */
    startedAt: timestamp.nullable().optional(),
    finishedAt: timestamp.nullable().optional(),
    /**
     * Once the run has ended: its last message (the envelope's `seq` is that
     * message's) and the thread it is in, so a notification opens it.
     */
    messageId: nullableId.optional(),
    threadRootId: nullableId.optional(),
  }),
  'run.step': z.looseObject({ step: RunStepSchema }),
  'approval.requested': z.looseObject({
    approval: ApprovalSchema,
    /** The thread the request's message is in, when it is in one. */
    threadRootId: nullableId.optional(),
  }),
  'approval.resolved': z.looseObject({ approval: ApprovalSchema }),
  'widget.updated': z.looseObject({ widget: WidgetStateSchema }),
  'routine.ran': z.looseObject({
    routineId: id,
    run: z.looseObject({ id, status: z.string() }),
  }),
  'artifact.created': z.looseObject({ artifactId: id, title: z.string() }),
  'artifact.updated': z.looseObject({
    artifactId: id,
    title: z.string(),
    version: z.number().int().positive().optional(),
  }),
  /** Sent to the owner (`user_id`): the account's computer is account-level, not a Bot's. */
  'computer.status': z.looseObject({
    computerId: id,
    status: z.string(),
    error: z.string().nullable().optional(),
  }),
  /**
   * Sent to the owner (`user_id`) when a connector's OAuth sign-in finishes,
   * so every open page updates the card at once. Carries no token.
   */
  'connector.updated': z.looseObject({
    connectorId: id,
    oauth: z.enum(['connected', 'error']).optional(),
    /** Why the sign-in failed, for the owner; never a secret. */
    error: z.string().nullable().optional(),
  }),
  /**
   * Sent to the owner (`user_id`, in `workspace_id`) when a phone pairs with
   * their account (docs/RELAY_PROTOCOL.md 6.4), so Settings > Devices updates.
   */
  'device.paired': z.looseObject({ device: DeviceEventSchema }),
  /**
   * Sent to the owner when a device is revoked. The relay adapter on every
   * API instance closes that device's streams on it.
   */
  'device.revoked': z.looseObject({ device: DeviceEventSchema }),
  /**
   * Sent to the owner when a device changes without pairing or revoking: it
   * registered or refreshed its push token. The push worker reads the
   * organization's devices again on it.
   */
  'device.updated': z.looseObject({
    device: DeviceEventSchema.extend({ pushRegistered: z.boolean() }),
  }),
  /**
   * Sent to each owner with a device or an open pairing (`user_id`, in
   * `workspace_id`) when this server's relay link changes status: the
   * `GET /api/v1/relay` answer (docs/RELAY_PROTOCOL.md 6.4).
   */
  'relay.status': z.looseObject({
    hostId: z.string(),
    relayUrl: z.string().nullable(),
    status: z.enum(['off', 'connecting', 'linked']),
    since: timestamp.nullable(),
  }),
  /** Who controls a Bot's screen: the Bot, or the owner after a takeover. */
  'screen.control': z.looseObject({
    screenId: id,
    controller: z.enum(['bot', 'user']),
    userId: nullableId.optional(),
    botId: id.optional(),
    display: z.number().int().optional(),
  }),
  'reaction.added': z.looseObject({
    messageId: id,
    emoji: z.string().min(1),
    reactorType: ParticipantTypeSchema,
    reactorId: id,
  }),
  'reaction.removed': z.looseObject({
    messageId: id,
    emoji: z.string().min(1),
    reactorType: ParticipantTypeSchema,
    reactorId: id,
  }),
  /**
   * Sent to the owner (`user_id`, in `workspace_id`) when one of their coding
   * sessions changes (CA15): its status, summary, error, PR or usage. The
   * payload is the session as `GET /coding-sessions/{id}` returns it.
   */
  'coding_session.updated': z.looseObject({
    session: z.looseObject({ id, botId: id, agent: z.string(), status: z.string() }),
  }),
  /**
   * Sent to the owner when a coding session's transcript grows: the new
   * entries, in order, batched by the server (`CodingSessionEntry` in
   * coders.ts). A client with a gap before `entries[0].seq` reads
   * `GET /coding-sessions/{id}/events?after=` to fill it.
   */
  'coding_session.events': z.looseObject({
    sessionId: id,
    entries: z.array(
      z.looseObject({
        seq: z.number().int().positive(),
        turn: z.number().int().positive(),
        at: timestamp,
        event: z.looseObject({ type: z.string() }),
      }),
    ),
  }),
} as const;

export type WsEventType = keyof typeof EVENT_PAYLOADS;

export const WS_EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as WsEventType[];

const envelope = <T extends WsEventType>(type: T) =>
  z.object({
    type: z.literal(type),
    /** Milliseconds since the epoch, set by the publisher. */
    ts: z.number().int().nonnegative(),
    /** The chat's `messages.seq` this event belongs to, for resync. */
    seq: z.number().int().nonnegative().optional(),
    chat_id: id.optional(),
    bot_id: id.optional(),
    /**
     * Account-level events (`computer.status`, `connector.updated`, `device.*`, `relay.status`) go to every
     * socket of this user in the organization `workspace_id`, which they carry.
     */
    user_id: id.optional(),
    /** The organization an account-level event belongs to (plan 21.3). */
    workspace_id: id.optional(),
    payload: EVENT_PAYLOADS[type],
  });

type EnvelopeSchema<T extends WsEventType> = ReturnType<typeof envelope<T>>;

export const WsEventSchema = z.discriminatedUnion(
  'type',
  WS_EVENT_TYPES.map(envelope) as unknown as [
    EnvelopeSchema<WsEventType>,
    ...EnvelopeSchema<WsEventType>[],
  ],
);

export type WsEventOf<T extends WsEventType> = z.infer<EnvelopeSchema<T>>;
export type WsEvent = { [T in WsEventType]: WsEventOf<T> }[WsEventType];
export type WsEventPayload<T extends WsEventType> = z.infer<(typeof EVENT_PAYLOADS)[T]>;

/** Builds an event with `ts` set to now. */
export function wsEvent<T extends WsEventType>(
  type: T,
  payload: WsEventPayload<T>,
  scope: {
    chat_id?: string;
    bot_id?: string;
    user_id?: string;
    workspace_id?: string;
    seq?: number;
  } = {},
): WsEventOf<T> {
  return { type, ts: Date.now(), ...scope, payload } as WsEventOf<T>;
}

// Client to server.

const ids = z.array(id).max(500);

export const ClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), chats: ids.default([]), bots: ids.default([]) }),
  z.object({ type: z.literal('unsubscribe'), chats: ids.default([]), bots: ids.default([]) }),
  z.object({ type: z.literal('ping') }),
]);

export type ClientFrame = z.input<typeof ClientFrameSchema>;

// Server to client, besides events.

export const ControlFrameSchema = z.discriminatedUnion('type', [
  /** The full subscription set after a subscribe or unsubscribe, and what was refused. */
  z.object({
    type: z.literal('subscribed'),
    chats: z.array(id),
    bots: z.array(id),
    denied: z.object({ chats: z.array(id), bots: z.array(id) }),
  }),
  z.object({ type: z.literal('pong'), ts: z.number().int() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);

export type ControlFrame = z.infer<typeof ControlFrameSchema>;

export type ServerFrame = WsEvent | ControlFrame;

export function parseServerFrame(data: unknown): ServerFrame | undefined {
  const control = ControlFrameSchema.safeParse(data);
  if (control.success) return control.data;
  const event = WsEventSchema.safeParse(data);
  return event.success ? (event.data as WsEvent) : undefined;
}
