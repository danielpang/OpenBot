import {
  applyMessageDelta,
  type MessageDelta,
  type MessagePart as SharedPart,
} from '@openbots/shared';
import type { Message } from './api.js';

// The transcript's state (C2): messages by id in seq order, fed by REST pages,
// resync and the realtime events, every one of them applied idempotently. A
// message can arrive from several places (the page, `message.created`, the
// post's reply, resync); whichever copy is further along wins.

export interface Timeline {
  byId: Record<string, Message>;
  /** Message ids, oldest first. */
  order: string[];
}

export const emptyTimeline: Timeline = { byId: {}, order: [] };

/** The copy of a message that is further along: higher `deltaSeq`, then finished over streaming. */
function newer(a: Message, b: Message): Message {
  if (b.deltaSeq !== a.deltaSeq) return b.deltaSeq > a.deltaSeq ? b : a;
  if (a.status === 'streaming' && b.status !== 'streaming') return b;
  if (b.status === 'streaming' && a.status !== 'streaming') return a;
  // Same progress: the incoming copy may carry a newer widget state overlay.
  return b;
}

/** The newer copy, keeping the reply count a read added if that copy came from an event, which has none. */
function merged(a: Message, b: Message): Message {
  const winner = newer(a, b);
  const other = winner === b ? a : b;
  if (winner.replyCount !== undefined || other.replyCount === undefined) return winner;
  return { ...winner, replyCount: other.replyCount, lastReplySeq: other.lastReplySeq };
}

/** Adds or refreshes messages from any source. */
export function upsertMessages(timeline: Timeline, messages: readonly Message[]): Timeline {
  if (!messages.length) return timeline;
  const byId = { ...timeline.byId };
  let added = false;
  for (const message of messages) {
    const current = byId[message.id];
    if (!current) added = true;
    byId[message.id] = current ? merged(current, message) : message;
  }
  const order = added
    ? Object.keys(byId).sort((a, b) => byId[a]!.seq - byId[b]!.seq)
    : timeline.order;
  return { byId, order };
}

export type DeltaResult = { timeline: Timeline; gap: boolean };

/**
 * Applies a `message.delta`. A replayed delta changes nothing; a delta for an
 * unknown message, or one that skips a number, is not applied and reports a
 * gap so the caller can resync the message.
 */
export function applyDelta(
  timeline: Timeline,
  payload: { messageId: string } & MessageDelta,
): DeltaResult {
  const message = timeline.byId[payload.messageId];
  if (!message) return { timeline, gap: true };
  if (payload.deltaSeq <= message.deltaSeq) return { timeline, gap: false };
  if (payload.deltaSeq > message.deltaSeq + 1) return { timeline, gap: true };
  const next = applyMessageDelta(message.parts as SharedPart[], message.deltaSeq, payload);
  return {
    timeline: replace(timeline, {
      ...message,
      parts: next.parts as Message['parts'],
      deltaSeq: next.deltaSeq,
    }),
    gap: false,
  };
}

/** Applies `message.completed`; reports a gap when deltas before it were missed. */
export function applyCompleted(
  timeline: Timeline,
  payload: { messageId: string; status: 'complete' | 'failed'; deltaSeq?: number },
): DeltaResult {
  const message = timeline.byId[payload.messageId];
  if (!message) return { timeline, gap: true };
  const gap = payload.deltaSeq !== undefined && payload.deltaSeq > message.deltaSeq;
  if (gap || message.status === payload.status) return { timeline, gap };
  return { timeline: replace(timeline, { ...message, status: payload.status }), gap: false };
}

/** Applies `widget.updated` (or a widget action's reply) to the widget part's state. */
export function applyWidgetState(
  timeline: Timeline,
  widget: { messageId: string; partIndex: number; state?: unknown },
): Timeline {
  const message = timeline.byId[widget.messageId];
  const part = message?.parts[widget.partIndex];
  if (!message || part?.type !== 'widget') return timeline;
  const parts = [...message.parts];
  parts[widget.partIndex] = { ...part, state: widget.state };
  return replace(timeline, { ...message, parts });
}

/**
 * An `approval.resolved` event: the decision, and who made it and when, onto
 * the approval widget of the request's message. A pending state never
 * replaces a decided one.
 */
export function applyApprovalResolved(
  timeline: Timeline,
  approval: {
    messageId?: string | null;
    status: string;
    note?: string | null;
    decidedBy?: string | null;
    decidedAt?: string | null;
  },
): Timeline {
  const message = approval.messageId ? timeline.byId[approval.messageId] : undefined;
  const index = message?.parts.findIndex((p) => p.type === 'widget' && p.kind === 'approval');
  if (!message || index === undefined || index < 0 || approval.status === 'pending') {
    return timeline;
  }
  const part = message.parts[index] as Extract<Message['parts'][number], { type: 'widget' }>;
  const parts = [...message.parts];
  parts[index] = {
    ...part,
    state: {
      ...(part.state as object | undefined),
      status: approval.status,
      ...(approval.note ? { note: approval.note } : {}),
      decidedBy: approval.decidedBy ?? null,
      decidedAt: approval.decidedAt ?? null,
    },
  };
  return replace(timeline, { ...message, parts });
}

export function messagesOf(timeline: Timeline): Message[] {
  return timeline.order.map((id) => timeline.byId[id]!);
}

export function oldestSeq(timeline: Timeline): number | undefined {
  const first = timeline.order[0];
  return first ? timeline.byId[first]!.seq : undefined;
}

export function newestSeq(timeline: Timeline): number {
  const last = timeline.order.at(-1);
  return last ? timeline.byId[last]!.seq : 0;
}

function replace(timeline: Timeline, message: Message): Timeline {
  return { byId: { ...timeline.byId, [message.id]: message }, order: timeline.order };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A route's `?seq=` and `?thread=`: open the chat at one message (a
 * notification's or deep link's target), and for a reply in a thread, that
 * thread (`thread` is its root message's id) at the reply.
 */
export function focusSeqSearch(search: Record<string, unknown>): { seq?: number; thread?: string } {
  const seq = Number(search.seq);
  const thread = typeof search.thread === 'string' && UUID.test(search.thread) ? search.thread : '';
  return {
    ...(Number.isInteger(seq) && seq > 0 ? { seq } : {}),
    ...(thread ? { thread: thread.toLowerCase() } : {}),
  };
}

/**
 * The Bot route's search: `focusSeqSearch`, and `?chat=` for a message in one
 * of the Bot's chats with another Bot (C6), folded under the transcript. The
 * seq is then that chat's.
 */
export function transcriptSearch(search: Record<string, unknown>): {
  seq?: number;
  thread?: string;
  chat?: string;
} {
  const chat = typeof search.chat === 'string' && UUID.test(search.chat) ? search.chat : '';
  return { ...focusSeqSearch(search), ...(chat ? { chat: chat.toLowerCase() } : {}) };
}
