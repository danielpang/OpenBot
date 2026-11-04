import { ActivityIndicator } from 'react-native';
import { useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { unwrap } from '@openbots/api-client';
import { useApi } from '../api/provider';
import { Button, ErrorNote, Page } from '../components/ui';
import { Transcript } from '../transcript/transcript';
import { groupTitle, useBots, useChats } from './data';
import { GroupMembers } from './group-members';

export function BotScreen() {
  const { id, message, seq, thread, threadRootId } = useLocalSearchParams<{
    id: string;
    message?: string;
    seq?: string;
    thread?: string;
    threadRootId?: string;
  }>();
  const api = useApi();
  const bots = useBots();
  const bot = bots.data?.find((bot) => bot.id === id);
  const chat = useQuery({
    queryKey: ['bot-chat', id],
    queryFn: () => unwrap(api.GET('/api/v1/bots/{id}/chat', { params: { path: { id } } })),
    staleTime: Infinity,
  });
  return (
    <>
      <Stack.Screen
        options={{
          title: bot?.name ?? 'Bot',
          headerRight: () => (
            <Button
              title="Details"
              variant="ghost"
              onPress={() => router.push(`/bot/${id}/details`)}
            />
          ),
        }}
      />
      {chat.data?.id || bot?.chatId ? (
        <Transcript
          chatId={chat.data?.id ?? bot!.chatId}
          bots={bots.data ?? []}
          title={bot?.name ?? 'your Bot'}
          targetMessageId={message}
          targetSeq={parseTargetSeq(seq)}
          threadRootId={threadRootId ?? thread}
        />
      ) : (
        <Page>
          {chat.isLoading ? (
            <ActivityIndicator />
          ) : (
            <ErrorNote error={chat.error} onRetry={() => void chat.refetch()} />
          )}
        </Page>
      )}
    </>
  );
}
export function ChatScreen() {
  const [membersOpen, setMembersOpen] = useState(false);
  const { id, thread, threadRootId, message, seq, title } = useLocalSearchParams<{
    id: string;
    thread?: string;
    threadRootId?: string;
    seq?: string;
    message?: string;
    title?: string;
  }>();
  const bots = useBots();
  const chats = useChats();
  const chat = chats.data?.find((chat) => chat.id === id);
  const bot = bots.data?.find((bot) => bot.chatId === id);
  const name = title ?? bot?.name ?? (chat ? groupTitle(chat, bots.data) : 'Conversation');
  return (
    <>
      <Stack.Screen
        options={{
          title: name,
          headerRight:
            chat?.type === 'group'
              ? () => (
                  <Button title="Members" variant="ghost" onPress={() => setMembersOpen(true)} />
                )
              : undefined,
        }}
      />
      <Transcript
        chatId={id}
        bots={bots.data ?? []}
        title={name}
        threadRootId={threadRootId ?? thread}
        targetMessageId={message}
        targetSeq={parseTargetSeq(seq)}
      />
      {chat?.type === 'group' ? (
        <GroupMembers
          visible={membersOpen}
          onClose={() => setMembersOpen(false)}
          chat={chat}
          bots={bots.data ?? []}
        />
      ) : null}
    </>
  );
}

function parseTargetSeq(value: string | undefined) {
  const seq = Number(value);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
}
