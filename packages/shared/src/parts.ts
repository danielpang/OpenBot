import { z } from 'zod';

// Message parts (plan 4.2, 12.2; C1, C2, W1, W3): the ordered `messages.parts`
// array. Parts are stored verbatim in jsonb, so their keys are snake_case like
// other jsonb values (`file_id`), while the message around them is camelCase.
//
// Append-only like the event protocol: later phases add part types and
// fields, never rename or remove one. Part objects are loose so an older
// client keeps fields it does not know.

export const MessageAuthorTypeSchema = z.enum(['user', 'bot', 'system', 'webhook', 'routine']);

export const MessageStatusSchema = z.enum(['complete', 'streaming', 'failed']);

const id = z.string().min(1);

export const TextPartSchema = z.looseObject({ type: z.literal('text'), text: z.string() });

/** An uploaded image, served by `GET /api/v1/files/{file_id}`. */
export const ImagePartSchema = z.looseObject({
  type: z.literal('image'),
  file_id: id,
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative().optional(),
});

/** Any other attachment, served by `GET /api/v1/files/{file_id}`. */
export const FilePartSchema = z.looseObject({
  type: z.literal('file'),
  file_id: id,
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative().optional(),
});

export const ToolCallPartSchema = z.looseObject({
  type: z.literal('tool_call'),
  tool_call_id: id,
  tool_name: z.string(),
  args: z.unknown(),
  /** The activity label (I4), from `labelFor`. */
  label: z.string().optional(),
});

export const ToolResultPartSchema = z.looseObject({
  type: z.literal('tool_result'),
  tool_call_id: id,
  tool_name: z.string(),
  result: z.unknown(),
  is_error: z.boolean().optional(),
  label: z.string().optional(),
});

export const ReasoningPartSchema = z.looseObject({
  type: z.literal('reasoning'),
  text: z.string(),
});

/**
 * A widget (plan 12.2). Each kind's props schema lives in `@openbots/widgets`;
 * here `kind` is any string so an unknown kind still round-trips.
 */
export const WidgetPartSchema = z.looseObject({
  type: z.literal('widget'),
  kind: z.string().min(1),
  props: z.unknown(),
  state: z.unknown().optional(),
});

/** A compact system row, not a chat bubble (W3): Routine ran, computer started, ... */
export const EventPartSchema = z.looseObject({
  type: z.literal('event'),
  kind: z.string().min(1),
  text: z.string(),
  data: z.unknown().optional(),
});

/** An Artifact card (plan 12.1). */
export const ArtifactPartSchema = z.looseObject({
  type: z.literal('artifact'),
  artifact_id: id,
  title: z.string(),
  kind: z.string().optional(),
  version: z.number().int().positive().optional(),
});

/** A Skill referenced with `/` in the composer (C1, S1). */
export const SkillRefPartSchema = z.looseObject({
  type: z.literal('skill_ref'),
  skill_id: id,
  name: z.string().optional(),
});

export const MessagePartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ImagePartSchema,
  FilePartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
  ReasoningPartSchema,
  WidgetPartSchema,
  EventPartSchema,
  ArtifactPartSchema,
  SkillRefPartSchema,
]);

export type MessagePart = z.infer<typeof MessagePartSchema>;
export type MessagePartType = MessagePart['type'];
export type MessageAuthorType = z.infer<typeof MessageAuthorTypeSchema>;

export const MESSAGE_PART_TYPES = MessagePartSchema.options.map(
  (o) => o.shape.type.value,
) as MessagePartType[];

// Streaming (plan 5.5). The runtime appends whole parts and text deltas; the
// server coalesces them and publishes `message.delta` events, each numbered
// with a per-message `deltaSeq`. A message row records the `deltaSeq` its
// stored parts include, so a client that loads a row and then receives events
// skips the ones it already has.

/** A piece of streamed text, appended to the open text or reasoning part. */
export const TextDeltaSchema = z.object({
  type: z.enum(['text_delta', 'reasoning_delta']),
  text: z.string(),
});

export type TextDelta = z.infer<typeof TextDeltaSchema>;

/**
 * One entry of a `message.delta` event. With `part`, the part at `partIndex`
 * is set to it (a whole tool call, widget, ...). Without, `text` is appended
 * to the text or reasoning part at `partIndex`, which starts empty.
 */
export type PartDelta = {
  partIndex: number;
  type: string;
  text: string;
  part?: MessagePart;
};

export type MessageDelta = {
  deltaSeq: number;
  deltas: PartDelta[];
};

/**
 * Applies a `message.delta` to parts that include everything up to
 * `lastDeltaSeq`. Replays (a `deltaSeq` already applied) leave the parts
 * unchanged, so a reconnecting client can apply whatever it receives.
 */
export function applyMessageDelta(
  parts: readonly MessagePart[],
  lastDeltaSeq: number,
  delta: MessageDelta,
): { parts: MessagePart[]; deltaSeq: number } {
  if (delta.deltaSeq <= lastDeltaSeq) return { parts: [...parts], deltaSeq: lastDeltaSeq };
  const next = [...parts];
  for (const d of delta.deltas) {
    if (d.part) {
      next[d.partIndex] = d.part;
      continue;
    }
    const current = next[d.partIndex];
    const text = current && 'text' in current ? current.text : '';
    const type = d.type === 'reasoning' ? 'reasoning' : 'text';
    next[d.partIndex] = { ...(current ?? { type }), text: text + d.text } as MessagePart;
  }
  return { parts: next, deltaSeq: delta.deltaSeq };
}

// Mentions (C1, C4): `@handle` names a Bot, `@everyone` every Bot in the chat.

const MENTION = /(^|[^\w@])@([a-z0-9_-]{1,32})(?![\w-])/gi;

/** Lowercased handles mentioned in `text`, in order, without duplicates or `everyone`. */
export function parseMentions(text: string): { handles: string[]; everyone: boolean } {
  const handles = new Set<string>();
  let everyone = false;
  for (const match of text.matchAll(MENTION)) {
    const handle = match[2]!.toLowerCase();
    if (handle === 'everyone') everyone = true;
    else handles.add(handle);
  }
  return { handles: [...handles], everyone };
}
