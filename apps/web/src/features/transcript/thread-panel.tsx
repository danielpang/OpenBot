import { cn } from '@openbots/ui';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { meQuery } from '../../app/api.js';
import { botsQuery, type Bot } from '../bots/queries.js';
import { chatsQuery } from '../chats/api.js';
import { widgetAction, type Message } from './api.js';
import { useAuthorNames } from './chat-timeline.js';
import { Composer } from './composer.js';
import { MessageView } from './message-view.js';
import { messagesOf } from './timeline.js';
import { useTranscript } from './use-transcript.js';

// A thread in the right panel (C7): one result or approval request and the
// replies to it, oldest first, with a composer that posts into the thread so
// the Bot's next run looks at that item only. Works for a Bot's transcript
// and for a group, where the group's Bots and `@everyone` can be mentioned.

export function ThreadPanel({
  chatId,
  rootId,
  focusSeq,
}: {
  chatId: string;
  rootId: string;
  /** A reply to scroll to and mark, from a notification or deep link. */
  focusSeq?: number;
}) {
  const bots = useQuery(botsQuery);
  const chats = useQuery(chatsQuery);
  const me = useQuery(meQuery);
  const transcript = useTranscript(chatId, { thread: rootId });
  const { timeline, loading, error, hasMore, loadingOlder, loadOlder, setWidgetState, react } =
    transcript;
  const messages = messagesOf(timeline);
  const bottom = useRef<HTMLDivElement>(null);

  const roster = bots.data?.items;
  const byId = useMemo(() => new Map(roster?.map((b) => [b.id, b])), [roster]);
  const group = chats.data?.items.find((c) => c.id === chatId && c.type === 'group');
  const own = roster?.find((b) => b.chatId === chatId);
  const members = group ? group.botIds.flatMap((id) => byId.get(id) ?? []) : own ? [own] : [];
  const { authorName, reactorName } = useAuthorNames(roster);

  const onWidgetAction = useCallback(
    async (message: Message, partIndex: number, action: unknown) => {
      const widget = await widgetAction(message.id, partIndex, action as Record<string, unknown>);
      setWidgetState(widget);
      return widget.state;
    },
    [setWidgetState],
  );
  const onReact = useCallback(
    (message: Message, emoji: string, on: boolean) => {
      react(message.id, emoji, on).catch(() => {});
    },
    [react],
  );

  // New replies keep the newest in view; a focused reply is scrolled to
  // once, loading earlier replies until it is there.
  const count = messages.length;
  const focusedRow = useRef<HTMLDivElement>(null);
  const focused = focusSeq !== undefined && messages.some((m) => m.seq === focusSeq);
  const [scrolledToFocus, setScrolledToFocus] = useState(false);
  useEffect(() => {
    if (focusSeq !== undefined && !scrolledToFocus) {
      if (focused) {
        focusedRow.current?.scrollIntoView?.({ block: 'center' });
        setScrolledToFocus(true);
        return;
      }
      const oldestReply = messages.find((m) => m.id !== rootId)?.seq ?? 0;
      if (!loading && hasMore && !loadingOlder && oldestReply > focusSeq) void loadOlder();
      if (loading || hasMore) return;
    }
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [count, focused, loading, hasMore, loadingOlder]);

  if (error) return <p className="p-4 text-sm text-destructive">{error.message}</p>;

  return (
    <div className="flex h-full flex-col">
      <div
        className="min-h-0 flex-1 overflow-y-auto px-3 pt-3"
        role="log"
        aria-label="Thread"
        aria-busy={loading}
      >
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          hasMore && (
            <button
              type="button"
              className="pb-2 text-xs text-muted-foreground hover:underline"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
            >
              {loadingOlder ? 'Loading earlier replies…' : 'Load earlier replies'}
            </button>
          )
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            ref={message.seq === focusSeq ? focusedRow : undefined}
            data-thread-root={message.id === rootId || undefined}
            data-focused={message.seq === focusSeq || undefined}
            className={cn(
              message.id === rootId && 'border-b pb-2',
              message.seq === focusSeq && 'rounded-lg bg-accent/40',
            )}
          >
            <MessageView
              message={message}
              bot={message.authorId ? byId.get(message.authorId) : undefined}
              ownerId={me.data?.user.id}
              named={Boolean(group)}
              liveState={liveState(message, byId)}
              authorName={authorName}
              onWidgetAction={onWidgetAction}
              reactions={transcript.reactions[message.id]}
              onReact={onReact}
              reactorName={reactorName}
            />
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="p-3">
        <Composer
          chatId={chatId}
          threadRootId={rootId}
          mentionable={members}
          everyone={Boolean(group)}
          placeholder="Reply in thread"
          onSent={transcript.addMessage}
        />
      </div>
    </div>
  );
}

/** The author's live state while it writes this message; the roster cache follows `bot.state`. */
function liveState(message: Message, bots: Map<string, Bot>) {
  const bot = message.authorId ? bots.get(message.authorId) : undefined;
  return bot && message.runId && bot.state.runId === message.runId ? bot.state.state : undefined;
}
