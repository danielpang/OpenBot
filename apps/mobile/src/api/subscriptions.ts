import type { WsClient } from '@openbots/api-client';

/** Roster notices and open transcripts may share a chat subscription. One
 * consumer leaving must not unsubscribe the other consumer's event stream. */
export function withSubscriptionCounts(client: WsClient): WsClient {
  const chats = new Map<string, number>();
  const bots = new Map<string, number>();
  const change = (counts: Map<string, number>, ids: string[], add: boolean) => {
    const changed: string[] = [];
    for (const id of new Set(ids)) {
      const before = counts.get(id) ?? 0;
      const after = Math.max(0, before + (add ? 1 : -1));
      if (after) counts.set(id, after);
      else counts.delete(id);
      if (add ? before === 0 : before === 1) changed.push(id);
    }
    return changed;
  };
  return {
    get status() {
      return client.status;
    },
    subscribe(target) {
      const newChats = change(chats, target.chats ?? [], true);
      const newBots = change(bots, target.bots ?? [], true);
      if (newChats.length || newBots.length) client.subscribe({ chats: newChats, bots: newBots });
    },
    unsubscribe(target) {
      const oldChats = change(chats, target.chats ?? [], false);
      const oldBots = change(bots, target.bots ?? [], false);
      if (oldChats.length || oldBots.length) client.unsubscribe({ chats: oldChats, bots: oldBots });
    },
    noteSeq: client.noteSeq,
    on: client.on,
    onEvent: client.onEvent,
    close: client.close,
  };
}
