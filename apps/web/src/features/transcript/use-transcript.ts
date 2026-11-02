import type { MessageDelta } from '@openbots/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addReaction,
  fetchMessages,
  fetchResync,
  removeReaction,
  type Message,
  type Reaction,
} from './api.js';
import { seedReactions, withoutReaction, withReaction, type Reactions } from './reactions.js';
import { useRealtime } from './realtime.js';
import {
  applyApprovalResolved,
  applyCompleted,
  applyDelta,
  applyWidgetState,
  emptyTimeline,
  newestSeq,
  oldestSeq,
  upsertMessages,
  type DeltaResult,
  type Timeline,
} from './timeline.js';

// One chat's timeline: the newest page over REST, older pages on demand
// (upward by seq), live `message.*`, `widget.updated` and `reaction.*` events, and a resync after a reconnect or whenever a delta shows something
// was missed. A resync brings back the messages new or changed since the seq
// it is given, so one that completed, or whose widget or reactions changed,
// while the socket was down is current again. With `thread` it is one thread
// (C7): the root and its replies.

export interface TranscriptData {
  timeline: Timeline;
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder(): Promise<void>;
  /** Merges a message the client already has, e.g. the reply to a post. */
  addMessage(message: Message): void;
  setWidgetState(widget: { messageId: string; partIndex: number; state?: unknown }): void;
  /** Reactions seen on this chat's messages, by message id. */
  reactions: Reactions;
  /** Adds (`on`) or takes back the owner's reaction. */
  react(messageId: string, emoji: string, on: boolean): Promise<void>;
}

export interface TranscriptOptions {
  /**
   * A thread root: load and follow only that thread. The chat's own
   * transcript holds the chat's subscription, so a thread does not subscribe.
   */
  thread?: string;
}

export function useTranscript(
  chatId: string | undefined,
  { thread }: TranscriptOptions = {},
): TranscriptData {
  const { client, onResync } = useRealtime();
  const [timeline, setTimeline] = useState<Timeline>(emptyTimeline);
  const [reactions, setReactions] = useState<Reactions>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const timelineRef = useRef(timeline);
  // Every change goes through here so event handlers see the latest timeline
  // synchronously, however many events arrive before the next render.
  const update = useCallback((change: (t: Timeline) => Timeline) => {
    timelineRef.current = change(timelineRef.current);
    setTimeline(timelineRef.current);
  }, []);
  // Resync and the socket bring every message of the chat; a thread keeps its own.
  const inScope = useCallback(
    (m: Message) => !thread || m.id === thread || m.threadRootId === thread,
    [thread],
  );

  // Merges messages read over REST, with the reactions they carry.
  const read = useCallback(
    (messages: readonly Message[]) => {
      update((t) => upsertMessages(t, messages));
      setReactions((r) => seedReactions(r, messages));
    },
    [update],
  );

  const resync = useCallback(
    async (since: number) => {
      if (!chatId) return;
      for (let from = since; ;) {
        const page = await fetchResync(chatId, from);
        read(page.messages.filter(inScope));
        // Pages run in the order messages last changed, which a reply or a
        // reaction can move past newer ones (plan 14.2).
        const last = page.messages.at(-1);
        if (!page.hasMore || !last) break;
        from = last.updatedSeq;
      }
    },
    [chatId, inScope, read],
  );

  // The newest page.
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    update(() => emptyTimeline);
    setReactions({});
    setLoading(true);
    setError(null);
    fetchMessages(chatId, undefined, thread).then(
      (page) => {
        if (cancelled) return;
        read(page.messages);
        setHasMore(page.hasMore);
        setLoading(false);
      },
      (e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [chatId, thread, update, read]);

  // Live events and reconnect resync.
  useEffect(() => {
    if (!chatId || !client) return;
    if (!thread) client.subscribe({ chats: [chatId] });
    const mine = (event: { chat_id?: string }) => event.chat_id === chatId;
    // A delta for a message not loaded yet, or one that skips a number, means
    // something was missed: fetch that message again from just before its seq.
    // A thread only follows messages it has; the rest belong to the chat.
    const settle = (result: DeltaResult, seq: number | undefined, messageId: string) => {
      const known = Boolean(timelineRef.current.byId[messageId]);
      if (result.gap && (known || !thread)) {
        void resync(Math.max(0, (seq ?? newestSeq(timelineRef.current)) - 1));
      }
      return result.timeline;
    };
    const offs = [
      client.on('message.created', (event) => {
        const message = event.payload.message as Message;
        if (!mine(event) || !inScope(message)) return;
        update((t) => upsertMessages(t, [message]));
      }),
      client.on('message.delta', (event) => {
        if (!mine(event)) return;
        const payload = event.payload as { messageId: string } & MessageDelta;
        update((t) => settle(applyDelta(t, payload), event.seq, payload.messageId));
      }),
      client.on('message.completed', (event) => {
        if (!mine(event)) return;
        const payload = event.payload;
        update((t) => settle(applyCompleted(t, payload), event.seq, payload.messageId));
      }),
      client.on('widget.updated', (event) => {
        if (!mine(event)) return;
        update((t) => applyWidgetState(t, event.payload.widget));
      }),
      // Adds who decided and when, which `widget.updated` does not carry.
      client.on('approval.resolved', (event) => {
        if (!mine(event)) return;
        update((t) => applyApprovalResolved(t, event.payload.approval));
      }),
      client.on('reaction.added', (event) => {
        if (!mine(event)) return;
        setReactions((r) => withReaction(r, event.payload as Reaction));
      }),
      // Another tab, or the owner here before the DELETE answered.
      client.on('reaction.removed', (event) => {
        if (!mine(event)) return;
        setReactions((r) => withoutReaction(r, event.payload as Reaction));
      }),
      onResync(chatId, (since) => void resync(since)),
    ];
    return () => {
      for (const off of offs) off();
      if (!thread) client.unsubscribe({ chats: [chatId] });
    };
  }, [chatId, thread, client, onResync, resync, inScope, update]);

  // The client resyncs from the highest seq it has heard over the socket;
  // tell it about the ones loaded over REST too.
  const newest = newestSeq(timeline);
  useEffect(() => {
    if (chatId && client && newest && !thread) client.noteSeq(chatId, newest);
  }, [chatId, client, newest, thread]);

  const loadOlder = useCallback(async () => {
    const before = oldestSeq(timelineRef.current);
    if (!chatId || before === undefined || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await fetchMessages(chatId, before, thread);
      read(page.messages);
      setHasMore(page.hasMore);
    } finally {
      setLoadingOlder(false);
    }
  }, [chatId, thread, loadingOlder, read]);

  const addMessage = useCallback(
    (message: Message) => {
      update((t) => upsertMessages(t, [message]));
    },
    [update],
  );

  const setWidgetState = useCallback(
    (widget: { messageId: string; partIndex: number; state?: unknown }) => {
      update((t) => applyWidgetState(t, widget));
    },
    [update],
  );

  const react = useCallback(async (messageId: string, emoji: string, on: boolean) => {
    if (on) {
      const reaction = await addReaction(messageId, emoji);
      setReactions((r) => withReaction(r, reaction));
    } else {
      await removeReaction(messageId, emoji);
      // The owner is the chat's one user, so their reaction is the user one.
      setReactions((r) => {
        const own = r[messageId]?.find((x) => x.emoji === emoji && x.reactorType === 'user');
        return own ? withoutReaction(r, own) : r;
      });
    }
  }, []);

  return {
    timeline,
    loading,
    error,
    hasMore,
    loadingOlder,
    loadOlder,
    addMessage,
    setWidgetState,
    reactions,
    react,
  };
}
