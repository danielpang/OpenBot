import { ActivityIndicator } from 'react-native';
import { useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { unwrap } from '@openbots/api-client';
import { useApi } from '../api/provider';
import { ErrorNote, Page } from '../components/ui';
import { useGlassEnabled } from '../components/glass';
import { useTheme } from '../theme';
import { Transcript } from '../transcript/transcript';
import { groupTitle, useBots, useChats } from './data';
import { GroupMembers } from './group-members';

// Keep content underneath the native navigation controls. On iOS 26 the
// system's soft scroll edge protects the title; accessibility/older-OS fallbacks
// keep an opaque bar without changing the scroll view's inset geometry.
function useConversationHeader() {
  const glass = useGlassEnabled();
  const c = useTheme();
  return {
    headerTransparent: true,
    headerStyle: { backgroundColor: glass ? 'transparent' : c.background },
    scrollEdgeEffects: { top: glass ? ('soft' as const) : ('hidden' as const) },
  };
}

export function BotScreen() {
  const header = useConversationHeader();
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
          ...header,
          title: bot?.name ?? 'Bot',
          unstable_headerRightItems: () => [
            {
              type: 'button',
              label: 'Bot details',
              accessibilityLabel: 'Bot details',
              icon: { type: 'sfSymbol', name: 'info.circle' },
              onPress: () => router.push(`/bot/${id}/details`),
            },
          ],
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
  const header = useConversationHeader();
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
          ...header,
          title: name,
          unstable_headerRightItems: () =>
            chat?.type === 'group'
              ? [
                  {
                    type: 'button',
                    label: 'Group members',
                    accessibilityLabel: 'Group members',
                    icon: { type: 'sfSymbol', name: 'person.2' },
                    onPress: () => setMembersOpen(true),
                  },
                ]
              : bot
                ? [
                    {
                      type: 'button',
                      label: 'Bot details',
                      accessibilityLabel: 'Bot details',
                      icon: { type: 'sfSymbol', name: 'info.circle' },
                      onPress: () => router.push(`/bot/${bot.id}/details`),
                    },
                  ]
                : [],
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
