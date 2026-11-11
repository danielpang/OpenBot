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
import { GlassIconButton } from '../components/glass';
import { useTheme } from '../theme';
import { Composer } from './composer';
import { DancingBots } from './dancing-avatar';
import { ActivityView, MessagePartView } from './parts';
import { toBlocks } from './blocks';
import { MessageReactions } from './reactions';
import type { Message } from './model';
import type { Bot } from '../screens/data';

// How often a hidden conversation is re-pinned and checked for movement.
const SETTLE_TICK_MS = 50;
// FlashList keeps re-applying its own initial scroll for 100ms after its first layout.
const SETTLE_MIN_MS = 150;
// Show the conversation anyway if it never holds still, e.g. while a reply streams in.
const SETTLE_LIMIT_MS = 1000;
// A hidden conversation is shown after this long even if its list never reports a layout.
const HIDDEN_LIMIT_MS = 3000;

// The composer's height before it has been measured.
const COMPOSER_ESTIMATE = 70;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type TranscriptProps = {
  chatId: string;
  bots: Bot[];
  title: string;
  threadRootId?: string;
  targetMessageId?: string;
  targetSeq?: number;
  /** A group's Bots, in join order. A Bot's own chat is recognised without it. */
  members?: Bot[];
};

// Remount per conversation so its scroll position, reveal and jump state, unsent
// draft and loaded messages never carry over when a screen switches chats in place.
export function Transcript(props: TranscriptProps) {
  return <ConversationTranscript key={`${props.chatId}:${props.threadRootId ?? ''}`} {...props} />;
}

function ConversationTranscript({
  chatId,
  bots,
  title,
  threadRootId,
  targetMessageId,
  targetSeq,
  members,
}: TranscriptProps) {
  const c = useTheme();
  const safe = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  // Follow the native keyboard frame on the UI thread, including interactive
  // dismissal. The bottom inset is applied once, not added above the keyboard.
  const keyboardInsets = useAnimatedStyle(() => ({
    paddingBottom: Math.max(keyboard.height.value, safe.bottom),
  }));
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  // Measure the complete dock, including growing drafts, attachments and menus.
  // Only scroll padding reserves space: the viewport continues behind the glass.
  const [composerHeight, setComposerHeight] = useState(COMPOSER_ESTIMATE);
  const messages = useMessages(chatId, threadRootId);
  const list = useRef<FlashListRef<Message>>(null);
  const jumped = useRef<string | undefined>(undefined);
  // FlashList first paints away from the latest message, keeps moving while it measures
  // rows, and animates to the end when the server's messages arrive. Keep a reopened
  // conversation hidden until it holds still on the latest (or linked) message, so it
  // appears in place instead of visibly jumping and scrolling.
  const [revealed, setRevealed] = useState(false);
  // FlashList can't scroll to a row before its first layout.
  const [listReady, setListReady] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const settling = useRef(false);
  // Re-pin the position until the content height and scroll offset stop changing, then
  // show the conversation.
  const settle = useCallback(async (pin?: () => unknown) => {
    if (settling.current) return;
    settling.current = true;
    const started = Date.now();
    let previous: string | undefined;
    let still = 0;
    for (;;) {
      // FlashList's scrollToEnd can take 200ms+ when it has to render the last row first.
      await Promise.race([pin?.(), wait(SETTLE_TICK_MS * 5)]);
      await wait(SETTLE_TICK_MS);
      const current = list.current;
      if (!alive.current || !current) return;
      let position: string;
      try {
        position = `${Math.round(current.getChildContainerDimensions().height)}:${Math.round(current.getAbsoluteLastScrollOffset())}`;
      } catch {
        // The list can't report its layout: show it rather than wait for the limit.
        break;
      }
      still = position === previous ? still + 1 : 0;
      previous = position;
      const elapsed = Date.now() - started;
      if ((still >= 2 && elapsed >= SETTLE_MIN_MS) || elapsed >= SETTLE_LIMIT_MS) break;
    }
    setRevealed(true);
  }, []);
  // Land on the true end, below a tall last message and the composer padding.
  const pinToEnd = useCallback(() => list.current?.scrollToEnd({ animated: false }), []);
  const hasTarget = Boolean(targetMessageId || targetSeq);
  const hidden = !revealed && messages.messages.length > 0;
  // A conversation first shown empty is already settled; its first message must not blink.
  if (!revealed && !messages.loading && messages.messages.length === 0) setRevealed(true);
  useEffect(() => {
    if (!hidden) return;
    // Never leave the transcript blank if the list fails to report its first layout.
    const fallback = setTimeout(() => setRevealed(true), HIDDEN_LIMIT_MS);
    return () => clearTimeout(fallback);
  }, [hidden]);
  // One loader covers both waits, the first messages and the hidden list, from the
  // first frame: any delay before it is a moment of empty screen.
  const waiting = hidden || (messages.loading && messages.messages.length === 0);
  // Who dances while it loads: a group's Bots, or the Bot whose own chat this is.
  const chatBot = bots.find((bot) => bot.chatId === chatId);
  const dancers = members?.length ? members : chatBot ? [chatBot] : [];
  // FlashList won't repeat onStartReached while the list stays in the start zone, so
  // page in history skipped while hidden once it is shown, if it settled near the top
  // (a short conversation, or a link to an early message).
  const nearStart = () => {
    const current = list.current;
    if (!current) return false;
    return current.getAbsoluteLastScrollOffset() < current.getWindowSize().height * 0.5;
  };
  const pagedOnReveal = useRef(false);
  useEffect(() => {
    if (!revealed || pagedOnReveal.current) return;
    pagedOnReveal.current = true;
    if (messages.hasMore && nearStart()) void messages.loadMore();
  });
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
  // Open a notification's message as soon as it is on the phone, from the saved copy
  // or the server, instead of waiting for the whole refresh to finish.
  useEffect(() => {
    if (!hasTarget) return;
    const target = targetMessageId ?? String(targetSeq);
    const index = messages.messages.findIndex((message) =>
      targetMessageId ? message.id === targetMessageId : message.seq === targetSeq,
    );
    if (index < 0) {
      // Not here yet: it may still arrive from the server, or be in older history.
      if (messages.loading) return;
      if (messages.hasMore) void messages.loadMore();
      else if (listReady) void settle(pinToEnd);
      return;
    }
    if (!listReady || jumped.current === target) return;
    jumped.current = target;
    void Promise.resolve(
      list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: false }),
    ).then(() => settle());
  }, [
    hasTarget,
    listReady,
    settle,
    pinToEnd,
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
        <View
          testID="chat-transcript"
          style={{ flex: 1, opacity: hidden ? 0 : 1 }}
          // While hidden, rows must not take taps or VoiceOver focus.
          pointerEvents={hidden ? 'none' : 'auto'}
          accessibilityElementsHidden={hidden}
          importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
        >
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
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ paddingTop: 12, paddingBottom: composerHeight + 8 }}
            scrollIndicatorInsets={{ bottom: composerHeight }}
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
              // Animate only for messages that arrive while reading. While hidden it would
              // fight the pin to the end, and messages synced on open should not scroll by.
              animateAutoScrollToBottom: revealed && !messages.loading,
            }}
            onLoad={() => {
              setListReady(true);
              if (!hasTarget) void settle(pinToEnd);
            }}
            onStartReached={() => {
              // The hidden list briefly sits at the top; don't page in history for that.
              if (messages.hasMore && !hidden) void messages.loadMore();
            }}
            onStartReachedThreshold={0.5}
            ListHeaderComponent={
              // A fixed slot: the button arrives with the server's first page, after the
              // conversation is shown, and a header that grows then would push it down.
              messages.messages.length > 0 ? (
                <View style={{ minHeight: 48 }}>
                  {messages.hasMore ? (
                    <Button
                      title="Earlier messages"
                      variant="ghost"
                      onPress={() => void messages.loadMore()}
                    />
                  ) : null}
                </View>
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
        </View>
        {waiting ? (
          <View
            testID="chat-transcript-loading"
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              // Not the measured composer: its height arrives a frame late, and a
              // loader centred on it would shift as soon as it does.
              bottom: COMPOSER_ESTIMATE,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {/* Until the roster is on the phone there is no Bot to show. */}
            {dancers.length ? <DancingBots bots={dancers} /> : <ActivityIndicator />}
          </View>
        ) : null}
        {awayFromBottom && !hidden ? (
          <View
            testID="chat-jump-control"
            style={{ position: 'absolute', right: 20, bottom: composerHeight + 8 }}
          >
            <GlassIconButton
              icon="arrow-down"
              label="Jump to latest message"
              onPress={() => list.current?.scrollToEnd({ animated: true })}
            />
          </View>
        ) : null}
        <View
          testID="chat-composer-overlay"
          pointerEvents="box-none"
          onLayout={({ nativeEvent }) => setComposerHeight(nativeEvent.layout.height)}
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
        >
          <View style={{ width: '100%', maxWidth: 960, alignSelf: 'center' }}>
            {messages.error ? (
              <View style={{ paddingHorizontal: 16 }}>
                <ErrorNote error={messages.error} onRetry={refresh} />
              </View>
            ) : null}
            <Composer
              bots={bots}
              onSend={messages.send}
              sending={messages.sending}
              threadRootId={threadRootId}
            />
          </View>
        </View>
      </View>
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
    // Rows are recycled for other messages, so the open picker is tied to this one.
    const [pickingFor, setPickingFor] = useState<string>();
    const picking = pickingFor === message.id;
    return (
      <Pressable
        accessibilityRole="none"
        onLongPress={() => setPickingFor(message.id)}
        style={{
          paddingHorizontal: 20,
          paddingVertical: 16,
          width: '100%',
          maxWidth: 960,
          alignSelf: 'center',
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
          {toBlocks(message).map((block) =>
            block.kind === 'activity' ? (
              // Keyed by message: a recycled row must not carry an opened activity over.
              <ActivityView key={`${message.id}-${block.index}`} steps={block.steps} />
            ) : (
              <MessagePartView
                key={`${block.index}-${block.part.type}`}
                part={block.part}
                message={message}
                index={block.index}
                onUpdated={onUpdated}
              />
            ),
          )}
        </View>
        {message.status === 'failed' ? (
          <Label size={13} style={{ color: c.danger }}>
            This response was interrupted.
          </Label>
        ) : null}
        <MessageReactions
          message={message}
          alignEnd={user}
          picking={picking}
          onPicking={(open) => setPickingFor(open ? message.id : undefined)}
          onReaction={onReaction}
          onThread={onThread}
        />
      </Pressable>
    );
  },
  (previous, next) =>
    previous.message === next.message &&
    previous.bots === next.bots &&
    previous.highlighted === next.highlighted,
);
