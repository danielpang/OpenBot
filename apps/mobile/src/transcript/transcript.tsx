import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, View } from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';
import { router } from 'expo-router';
import { unwrap } from '@openbots/api-client';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApi } from '../api/provider';
import { useMessages } from '../api/messages';
import { Button, Empty, ErrorNote, Icon, Label, row } from '../components/ui';
import { BotAvatar } from '../components/bot-avatar';
import { useTheme } from '../theme';
import { Composer } from './composer';
import { MessagePartView } from './parts';
import type { Message } from './model';
import type { Bot } from '../screens/data';

export function Transcript({
  chatId,
  bots,
  title,
  threadRootId,
  targetMessageId,
  targetSeq,
}: {
  chatId: string;
  bots: Bot[];
  title: string;
  threadRootId?: string;
  targetMessageId?: string;
  targetSeq?: number;
}) {
  const c = useTheme();
  const safe = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  // Follow the native keyboard frame on the UI thread, including interactive
  // dismissal. The bottom inset is applied once, not added above the keyboard.
  const keyboardInsets = useAnimatedStyle(() => ({
    paddingBottom: Math.max(keyboard.height.value, safe.bottom),
  }));
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const messages = useMessages(chatId, threadRootId);
  const list = useRef<FlashListRef<Message>>(null);
  const jumped = useRef<string | undefined>(undefined);
  const api = useApi();
  const refresh = useCallback(() => {
    void messages.refetch();
  }, [messages.refetch]);
  async function react(message: Message, emoji: string) {
    try {
      const own = message.reactions?.find(
        (reaction) => reaction.emoji === emoji && reaction.reactorType === 'user',
      );
      if (own)
        await unwrap(
          api.DELETE('/api/v1/messages/{id}/reactions', {
            params: { path: { id: message.id }, query: { emoji } },
          }),
        );
      else
        await unwrap(
          api.POST('/api/v1/messages/{id}/reactions', {
            params: { path: { id: message.id } },
            body: { emoji },
          }),
        );
      refresh();
    } catch (error) {
      Alert.alert('Could not react', error instanceof Error ? error.message : String(error));
    }
  }
  useEffect(() => {
    if ((!targetMessageId && !targetSeq) || messages.loading) return;
    const target = targetMessageId ?? String(targetSeq);
    const index = messages.messages.findIndex((message) =>
      targetMessageId ? message.id === targetMessageId : message.seq === targetSeq,
    );
    if (index < 0 && messages.hasMore) void messages.loadMore();
    else if (index >= 0 && jumped.current !== target) {
      requestAnimationFrame(() => {
        list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: false });
        jumped.current = target;
      });
    }
  }, [
    targetMessageId,
    targetSeq,
    messages.messages,
    messages.hasMore,
    messages.loading,
    messages.loadMore,
  ]);
  return (
    <Animated.View
      testID="chat-keyboard-frame"
      style={[{ flex: 1, backgroundColor: c.background }, keyboardInsets]}
    >
      <View style={{ flex: 1 }}>
        <ErrorNote error={messages.error} onRetry={refresh} />
        {messages.loading ? <ActivityIndicator style={{ marginTop: 40 }} /> : null}
        <FlashList
          ref={list}
          data={messages.messages}
          keyExtractor={(message) => message.id}
          getItemType={(message) => message.authorType}
          renderItem={({ item }) => (
            <MessageRow
              message={item}
              bots={bots}
              highlighted={targetMessageId === item.id || targetSeq === item.seq}
              onUpdated={refresh}
              onReaction={(emoji) => void react(item, emoji)}
              onThread={
                !threadRootId
                  ? () =>
                      router.push({
                        pathname: '/chat/[id]',
                        params: { id: chatId, thread: item.id, title: `Thread · ${title}` },
                      })
                  : undefined
              }
            />
          )}
          contentContainerStyle={{ paddingTop: 12, paddingBottom: 8 }}
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets={false}
          scrollEventThrottle={32}
          onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
            setAwayFromBottom(
              contentSize.height - layoutMeasurement.height - contentOffset.y > 180,
            );
          }}
          maintainVisibleContentPosition={{
            startRenderingFromBottom: true,
            autoscrollToBottomThreshold: 0.2,
          }}
          onStartReached={() => {
            if (messages.hasMore) void messages.loadMore();
          }}
          onStartReachedThreshold={0.5}
          ListHeaderComponent={
            messages.hasMore ? (
              <Button
                title="Earlier messages"
                variant="ghost"
                onPress={() => void messages.loadMore()}
              />
            ) : null
          }
          ListEmptyComponent={
            !messages.loading ? (
              <Empty
                title={threadRootId ? 'Start a thread' : 'Say hello'}
                detail={
                  threadRootId
                    ? 'Keep this conversation together with a reply.'
                    : `Send ${title} a message to get started.`
                }
              />
            ) : null
          }
        />
        {awayFromBottom ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Jump to latest message"
            onPress={() => list.current?.scrollToEnd({ animated: true })}
            style={({ pressed }) => ({
              position: 'absolute',
              right: 20,
              bottom: 8,
              width: 44,
              height: 44,
              borderRadius: 22,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: c.card,
              borderWidth: 1,
              borderColor: c.border,
              opacity: pressed ? 0.65 : 1,
            })}
          >
            <Icon name="arrow-down" size={20} />
          </Pressable>
        ) : null}
      </View>
      <Composer
        bots={bots}
        onSend={messages.send}
        sending={messages.sending}
        threadRootId={threadRootId}
      />
    </Animated.View>
  );
}

const MessageRow = memo(
  function MessageRow({
    message,
    bots,
    onUpdated,
    onReaction,
    onThread,
    highlighted,
  }: {
    message: Message;
    bots: Bot[];
    onUpdated: () => void;
    onReaction: (emoji: string) => void;
    onThread?: () => void;
    highlighted: boolean;
  }) {
    const c = useTheme();
    const bot = bots.find((bot) => bot.id === message.authorId);
    const user = message.authorType === 'user';
    function menu() {
      Alert.alert('Message', undefined, [
        { text: '👍', onPress: () => onReaction('👍') },
        { text: '❤️', onPress: () => onReaction('❤️') },
        ...(onThread ? [{ text: 'Reply in thread', onPress: onThread }] : []),
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
    return (
      <Pressable
        accessibilityRole="none"
        onLongPress={menu}
        style={{
          paddingHorizontal: 20,
          paddingVertical: 16,
          backgroundColor: highlighted ? c.accent : 'transparent',
        }}
      >
        <View
          style={[row.base, { marginBottom: 8, justifyContent: user ? 'flex-end' : 'flex-start' }]}
        >
          {bot ? (
            <BotAvatar bot={bot} size={28} />
          ) : !user ? (
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                backgroundColor: c.muted,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="ellipse-outline" size={15} />
            </View>
          ) : null}
          <Label weight="600" size={14}>
            {bot?.name ??
              (user ? 'You' : message.authorType === 'system' ? 'OpenBots' : message.authorType)}
          </Label>
          <Label muted size={11}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
            })}
          </Label>
          {message.status === 'streaming' ? <ActivityIndicator size="small" /> : null}
        </View>
        <View
          style={
            user
              ? {
                  gap: 8,
                  alignSelf: 'flex-end',
                  maxWidth: '88%',
                  paddingHorizontal: 16,
                  paddingVertical: 8,
                  borderRadius: 22,
                  borderBottomRightRadius: 8,
                  backgroundColor: c.card,
                }
              : { gap: 10 }
          }
        >
          {message.parts.map((part, index) => (
            <MessagePartView
              key={`${index}-${part.type}`}
              part={part}
              message={message}
              index={index}
              onUpdated={onUpdated}
            />
          ))}
        </View>
        {message.status === 'failed' ? (
          <Label size={13} style={{ color: c.danger }}>
            This response was interrupted.
          </Label>
        ) : null}
        <View
          style={[
            row.base,
            { marginTop: 8, flexWrap: 'wrap', justifyContent: user ? 'flex-end' : 'flex-start' },
          ]}
        >
          {Object.entries(
            (message.reactions ?? []).reduce<Record<string, number>>(
              (counts, reaction) => ({
                ...counts,
                [reaction.emoji]: (counts[reaction.emoji] ?? 0) + 1,
              }),
              {},
            ),
          ).map(([emoji, count]) => (
            <Pressable
              key={emoji}
              accessibilityRole="button"
              accessibilityLabel={`React ${emoji}, ${count} reactions`}
              onPress={() => onReaction(emoji)}
              style={{
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 14,
                paddingHorizontal: 9,
                paddingVertical: 4,
              }}
            >
              <Label size={13}>
                {emoji} {count}
              </Label>
            </Pressable>
          ))}
          {onThread ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reply in thread"
              onPress={onThread}
              style={[row.base, { padding: 4, gap: 5 }]}
            >
              <Icon name="chatbubble-outline" size={14} color={c.mutedForeground} />
              <Label size={12} muted>
                {message.replyCount ? `${message.replyCount} replies` : 'Reply'}
              </Label>
            </Pressable>
          ) : null}
        </View>
      </Pressable>
    );
  },
  (previous, next) =>
    previous.message === next.message &&
    previous.bots === next.bots &&
    previous.highlighted === next.highlighted,
);
