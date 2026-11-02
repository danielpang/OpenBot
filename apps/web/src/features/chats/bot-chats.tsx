import { Avatar } from '@openbots/avatars/react';
import { cn } from '@openbots/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { meQuery } from '../../app/api.js';
import { botsQuery, type Bot } from '../bots/queries.js';
import { useAuthorNames } from '../transcript/chat-timeline.js';
import { MessageView } from '../transcript/message-view.js';
import { messagesOf } from '../transcript/timeline.js';
import { useTranscript } from '../transcript/use-transcript.js';
import { botChatsOf, chatsQuery, type Chat } from './api.js';

// A Bot's chats with other Bots (C6, plan 7), folded under its transcript:
// `message_bot` requests and their replies, visible to the owner and read
// only. Closed by default; a chat loads when it is opened. A notification or
// deep link for a message in one (`/bots/{id}?chat={chat id}&seq=N`) opens
// that chat at the message.

/** A message to open: one of this Bot's chats with another Bot, at `seq` if given. */
export interface BotChatFocus {
  chatId: string;
  seq?: number;
}

export function BotChats({ botId, focus }: { botId: string; focus?: BotChatFocus }) {
  const chats = useQuery(chatsQuery);
  const bots = useQuery(botsQuery);
  const pairs = botChatsOf(chats.data?.items, botId);
  if (!pairs.length) return null;
  const byId = new Map(bots.data?.items.map((b) => [b.id, b]));
  const focused = pairs.some(({ chat }) => chat.id === focus?.chatId) ? focus : undefined;

  return (
    // A new focus opens the list again, even after the owner closed it.
    <details
      key={focused ? `${focused.chatId}:${focused.seq ?? ''}` : 'none'}
      className="rounded-lg border text-sm"
      data-bot-chats
      open={focused != null}
    >
      <summary className="cursor-pointer select-none px-3 py-1.5 text-xs text-muted-foreground">
        With other Bots ({pairs.length})
      </summary>
      <ul className="flex flex-col border-t">
        {pairs.map(({ chat, peerId }) => (
          <li key={chat.id}>
            <PairChat
              chat={chat}
              peer={byId.get(peerId)}
              bots={byId}
              focus={chat.id === focused?.chatId ? focused : undefined}
            />
          </li>
        ))}
      </ul>
    </details>
  );
}

function PairChat({
  chat,
  peer,
  bots,
  focus,
}: {
  chat: Chat;
  peer?: Bot;
  bots: Map<string, Bot>;
  focus?: BotChatFocus;
}) {
  const [open, setOpen] = useState(focus != null);
  return (
    <details open={focus != null} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-1.5">
        {peer && <Avatar params={peer.avatar} size={20} label={peer.name} />}
        <span>{peer?.name ?? 'A deleted Bot'}</span>
      </summary>
      {open && <PairMessages chatId={chat.id} bots={bots} focusSeq={focus?.seq} />}
    </details>
  );
}

function PairMessages({
  chatId,
  bots,
  focusSeq,
}: {
  chatId: string;
  bots: Map<string, Bot>;
  /** A message to scroll to and mark, loading earlier pages until it is there. */
  focusSeq?: number;
}) {
  const me = useQuery(meQuery);
  const { timeline, loading, hasMore, loadingOlder, loadOlder } = useTranscript(chatId);
  const { authorName } = useAuthorNames([...bots.values()]);
  const messages = messagesOf(timeline);

  const focusedRow = useRef<HTMLDivElement>(null);
  const found = focusSeq !== undefined && messages.some((m) => m.seq === focusSeq);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (focusSeq === undefined || scrolled || loading) return;
    if (found) {
      focusedRow.current?.scrollIntoView?.({ block: 'center' });
      setScrolled(true);
    } else if (hasMore && !loadingOlder && (messages[0]?.seq ?? 0) > focusSeq) {
      void loadOlder();
    }
  }, [focusSeq, scrolled, loading, found, hasMore, loadingOlder, messages, loadOlder]);

  return (
    <div className="max-h-80 overflow-y-auto px-3 pb-2" role="log" aria-label="Chat between Bots">
      {hasMore && (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:underline"
          disabled={loadingOlder}
          onClick={() => void loadOlder()}
        >
          Load earlier messages
        </button>
      )}
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        messages.map((message) => (
          <div
            key={message.id}
            ref={message.seq === focusSeq ? focusedRow : undefined}
            data-focused={message.seq === focusSeq || undefined}
            className={cn(message.seq === focusSeq && 'rounded-lg bg-accent/40')}
          >
            <MessageView
              message={message}
              bot={message.authorId ? bots.get(message.authorId) : undefined}
              ownerId={me.data?.user.id}
              named
              authorName={authorName}
            />
          </div>
        ))
      )}
    </div>
  );
}
