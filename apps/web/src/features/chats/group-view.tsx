import { cn } from '@openbots/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { meQuery } from '../../app/api.js';
import { useChatDock } from '../../app/chat-dock.js';
import { windowDragClass } from '../../app/platform.js';
import { botsQuery } from '../bots/queries.js';
import type { Message } from '../transcript/api.js';
import { ChatTimeline } from '../transcript/chat-timeline.js';
import { Composer } from '../transcript/composer.js';
import { useBotPanel, useFocusThread } from '../transcript/panel.js';
import { useRealtime } from '../transcript/realtime.js';
import { useTranscript } from '../transcript/use-transcript.js';
import { chatsQuery, groupLimit, groupTitle, useRemoveMember } from './api.js';
import { GroupMembers } from './group-members.js';

// A group chat (C4, C5, C9): the owner and two to six Bots in one transcript,
// each Bot's messages under its avatar and name. Writing normally lets the
// Bots decide who answers; `@handle` directs one, `@everyone` all, and
// mentioning a Bot outside the group adds it while there is room. The
// members menu removes one. The right panel works as in a Bot's transcript,
// remembered under the chat's id.

const MEMBERSHIP_EVENTS = new Set(['member_joined', 'member_left']);

export function GroupView({
  chatId,
  focusSeq,
  focusThread,
}: {
  chatId: string;
  focusSeq?: number;
  /** The root of the thread `focusSeq` is in, for a reply in a thread. */
  focusThread?: string;
}) {
  const chats = useQuery(chatsQuery);
  const bots = useQuery(botsQuery);
  const me = useQuery(meQuery);
  const queryClient = useQueryClient();
  const dock = useChatDock<HTMLDivElement>();
  const { client } = useRealtime();
  const showPanel = useBotPanel(chatId);
  const transcript = useTranscript(chatId);
  const remove = useRemoveMember(chatId);

  const chat = chats.data?.items.find((c) => c.id === chatId && c.type === 'group');
  const roster = bots.data?.items;
  const byId = useMemo(() => new Map(roster?.map((b) => [b.id, b])), [roster]);
  const members = chat?.botIds.flatMap((id) => byId.get(id) ?? []) ?? [];
  const limit = groupLimit(me.data?.limits);
  const addable =
    chat && chat.botIds.length < limit
      ? (roster ?? []).filter((b) => !b.hidden && !chat.botIds.includes(b.id))
      : [];

  // A Bot joining or leaving (a mention adds one) changes the member list.
  useEffect(() => {
    if (!client) return;
    return client.on('message.created', (event) => {
      if (event.chat_id !== chatId) return;
      const parts = (event.payload.message as Message).parts;
      if (parts.some((p) => p.type === 'event' && MEMBERSHIP_EVENTS.has(p.kind))) {
        void queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey });
      }
    });
  }, [client, chatId, queryClient]);

  const botFor = useCallback(
    (m: Message) => (m.authorType === 'bot' && m.authorId ? byId.get(m.authorId) : undefined),
    [byId],
  );
  const stateFor = useCallback(
    (m: Message) => {
      const state = botFor(m)?.state;
      return state && m.runId && state.runId === m.runId ? state : undefined;
    },
    [botFor],
  );
  const onOpenThread = useCallback(
    (m: Message) => showPanel({ kind: 'thread', chatId, rootId: m.id }),
    [chatId, showPanel],
  );
  useFocusThread(showPanel, chatId, focusThread, focusSeq);

  if (transcript.error) {
    return <p className="p-8 text-sm text-destructive">{transcript.error.message}</p>;
  }
  if (!chat) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        {chats.isPending ? 'Loading…' : 'This group does not exist.'}
      </div>
    );
  }
  const title = groupTitle(chat, roster);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        data-slot="chat-header"
        className={cn('flex items-center gap-3 border-b px-4 py-3', windowDragClass())}
      >
        <h1 className="truncate font-semibold">{title}</h1>
        <GroupMembers
          members={members}
          onRemove={(bot) => remove.mutate(bot.id)}
          removing={remove.isPending ? remove.variables : null}
        />
      </header>
      <ChatTimeline
        label={title}
        start={`The start of ${title}.`}
        transcript={transcript}
        ownerId={me.data?.user.id}
        botFor={botFor}
        stateFor={stateFor}
        named
        focusSeq={focusSeq}
        focusThread={focusThread}
        onOpenActivity={(runId) => showPanel({ kind: 'activity', runId })}
        onOpenArtifact={(artifactId, version) =>
          showPanel({ kind: 'artifact', artifactId, version })
        }
        onOpenThread={onOpenThread}
      />
      <div ref={dock} data-slot="chat-dock" className="mx-auto w-full max-w-3xl px-4 pb-4">
        <Composer
          chatId={chatId}
          mentionable={members}
          everyone
          addable={addable}
          placeholder={`Message ${title}`}
          onSent={transcript.addMessage}
        />
      </div>
    </div>
  );
}
