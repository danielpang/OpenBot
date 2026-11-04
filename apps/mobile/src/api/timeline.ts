import type { components } from '@openbots/api-client';
import {
  applyMessageDelta,
  type MessageDelta,
  type MessagePart,
  type WsEvent,
} from '@openbots/shared';
export type Message = components['schemas']['Message'];

/** Stable references for unchanged rows let memoized native parts skip streaming updates. */
export function mergeMessages(held: readonly Message[], incoming: readonly Message[]): Message[] {
  const byId = new Map(held.map((message) => [message.id, message]));
  for (const message of incoming) {
    const previous = byId.get(message.id);
    if (
      previous &&
      (previous.deltaSeq > message.deltaSeq ||
        (previous.deltaSeq === message.deltaSeq &&
          previous.status !== 'streaming' &&
          message.status === 'streaming'))
    )
      continue;
    byId.set(message.id, { ...previous, ...message });
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}
export function applyEvent(
  messages: readonly Message[],
  event: WsEvent,
): { messages: Message[]; gap: boolean } {
  if (event.type === 'message.created')
    return { messages: mergeMessages(messages, [event.payload.message as Message]), gap: false };
  if (event.type === 'message.deleted')
    return {
      messages: messages.filter((message) => message.id !== event.payload.messageId),
      gap: false,
    };
  if (event.type === 'message.delta' || event.type === 'message.completed') {
    const current = messages.find((message) => message.id === event.payload.messageId);
    if (!current) return { messages: [...messages], gap: true };
    if (event.type === 'message.delta') {
      if (event.payload.deltaSeq <= current.deltaSeq)
        return { messages: messages as Message[], gap: false };
      if (event.payload.deltaSeq !== current.deltaSeq + 1)
        return { messages: [...messages], gap: true };
      const next = applyMessageDelta(
        current.parts as MessagePart[],
        current.deltaSeq,
        event.payload as MessageDelta,
      );
      return {
        messages: messages.map((message) =>
          message === current ? { ...message, ...next } : message,
        ),
        gap: false,
      };
    }
    if ((event.payload.deltaSeq ?? 0) > current.deltaSeq)
      return { messages: [...messages], gap: true };
    return {
      messages: messages.map((message) =>
        message === current ? { ...message, status: event.payload.status } : message,
      ),
      gap: false,
    };
  }
  if (event.type === 'widget.updated') {
    const { messageId, partIndex, state } = event.payload.widget;
    return {
      messages: messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              parts: message.parts.map((part, index) =>
                index === partIndex && part.type === 'widget' ? { ...part, state } : part,
              ),
            }
          : message,
      ),
      gap: false,
    };
  }
  // Reactions and approval decisions include overlays that should be read from the server.
  return {
    messages: messages as Message[],
    gap: event.type.startsWith('reaction.') || event.type === 'approval.resolved',
  };
}

export async function readResync(
  read: (since: number) => Promise<components['schemas']['Resync']>,
  since: number,
  apply: (page: components['schemas']['Resync']) => void,
): Promise<void> {
  for (let cursor = since; ;) {
    const page = await read(cursor);
    apply(page);
    if (!page.hasMore) return;
    const next = Math.max(
      cursor,
      ...page.messages.map((message) => message.updatedSeq),
      ...page.deleted.map((message) => message.seq),
    );
    if (next <= cursor) throw new Error('The server returned a resync page without progress.');
    cursor = next;
  }
}
