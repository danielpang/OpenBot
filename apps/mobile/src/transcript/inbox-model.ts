import type { Message } from './model';
import type { components } from '@openbots/api-client';
export type PendingWidget = {
  message: Message;
  part: Extract<Message['parts'][number], { type: 'widget' }>;
  index: number;
};
/** A missing state means the widget is still in its kind's initial pending state. */
export function pendingWidgets(messages: readonly Message[]): PendingWidget[] {
  return messages
    .flatMap((message) =>
      message.parts.flatMap((part, index) => {
        if (part.type !== 'widget' || !['question', 'login_request'].includes(part.kind)) return [];
        const state = part.state as { status?: unknown } | null | undefined;
        return state?.status === undefined || state.status === 'pending'
          ? [{ message, part, index }]
          : [];
      }),
    )
    .sort((a, b) => b.message.createdAt.localeCompare(a.message.createdAt));
}
export async function collectChatHistory(
  fetchPage: (before?: number) => Promise<{ messages: Message[]; hasMore: boolean }>,
): Promise<Message[]> {
  const held = new Map<string, Message>();
  let before: number | undefined;
  for (;;) {
    const page = await fetchPage(before);
    for (const message of page.messages) held.set(message.id, message);
    if (!page.hasMore) return [...held.values()];
    const oldest = Math.min(...page.messages.map((message) => message.seq));
    if (!Number.isFinite(oldest) || (before !== undefined && oldest >= before))
      throw new Error(
        'The server returned a message page without progress. Update your server and try again.',
      );
    before = oldest;
  }
}

export type InboxSnapshot = { cursor: number; messages: Message[] };
/** /messages pages omit replies. Resync starts at zero for the first scan and
 * includes replies, then carries only pending-message rows and a durable cursor. */
export async function syncPendingInput(
  read: (since: number) => Promise<components['schemas']['Resync']>,
  previous: InboxSnapshot = { cursor: 0, messages: [] },
): Promise<InboxSnapshot> {
  const held = new Map(previous.messages.map((message) => [message.id, message]));
  let cursor = previous.cursor;
  for (;;) {
    const page = await read(cursor);
    for (const message of page.messages) {
      held.delete(message.id);
      if (pendingWidgets([message]).length) held.set(message.id, message);
    }
    for (const deleted of page.deleted) held.delete(deleted.id);
    const next = Math.max(
      cursor,
      ...page.messages.map((message) => message.updatedSeq),
      ...page.deleted.map((message) => message.seq),
    );
    if (page.hasMore && next <= cursor)
      throw new Error('The server returned an inbox resync page without progress.');
    cursor = next;
    if (!page.hasMore) return { cursor, messages: [...held.values()] };
  }
}
