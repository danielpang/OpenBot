import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap } from '@openbots/api-client';
import {
  CODER_AGENT_LABELS,
  CODING_SESSION_ENDED,
  type CodingSessionEntry,
} from '@openbots/shared';
import { sessionStatusWords } from '@openbots/widgets';
import Markdown from 'react-native-markdown-display';
import { useApi, useMobile } from '../api/provider';
import { Button, Card, Empty, ErrorNote, Icon, Label, Page, row } from '../components/ui';
import { useTheme } from '../theme';
import { Composer } from '../transcript/composer';
import { SessionApprovals } from './approvals';
import { AcceptEdits } from '../components/accept-edits';
import { AgentOrb } from './agent-orb';
import { useCodingSessions, useCodingTranscript, useCodingUpdates } from './data';

export function CodingSessionsScreen({ botId }: { botId?: string }) {
  const sessions = useCodingSessions(botId);
  const c = useTheme();
  return (
    <>
      <Stack.Screen options={{ title: 'Code' }} />
      <FlatList
        style={{ flex: 1, backgroundColor: c.background }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 22, gap: 12 }}
        data={sessions.data ?? []}
        keyExtractor={(session) => session.id}
        refreshing={sessions.isFetching}
        onRefresh={() => void sessions.refetch()}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            <Label size={28} weight="700">
              Code
            </Label>
            <ErrorNote error={sessions.error} onRetry={() => void sessions.refetch()} />
          </View>
        }
        ListEmptyComponent={
          sessions.isPending ? (
            <ActivityIndicator />
          ) : !sessions.error ? (
            <Empty
              icon="code-slash-outline"
              title="No sessions yet"
              detail="Ask your Bot to work on a repository. Its sessions will appear here in Code."
            />
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.title || 'Code'}`}
            onPress={() => router.push(`/coding-session/${item.id}`)}
            style={({ pressed }) => ({ opacity: pressed ? 0.65 : 1 })}
          >
            <Card>
              <View style={row.base}>
                <Icon name="code-slash-outline" />
                <View style={{ flex: 1, gap: 4 }}>
                  <Label weight="600">{item.title || item.repoFullName || 'Code'}</Label>
                  {item.repoFullName && (
                    <Label muted size={13}>
                      {item.repoFullName}
                    </Label>
                  )}
                </View>
                <Icon name="chevron-forward" size={16} />
              </View>
            </Card>
          </Pressable>
        )}
      />
    </>
  );
}

export function CodingSessionScreen({ id }: { id: string }) {
  const api = useApi();
  const { connected } = useMobile();
  const [inputFocused, setInputFocused] = useState(false);
  useEffect(() => {
    const listener = Keyboard.addListener('keyboardDidHide', () => setInputFocused(false));
    return () => listener.remove();
  }, []);
  const safe = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  const keyboardInsets = useAnimatedStyle(() => ({
    paddingBottom: Math.max(keyboard.height.value, safe.bottom),
  }));
  const cache = useQueryClient();
  const c = useTheme();
  useCodingUpdates();
  const session = useQuery({
    queryKey: ['coding-sessions', id],
    queryFn: async () =>
      (await unwrap(api.GET('/api/v1/coding-sessions/{id}', { params: { path: { id } } }))).session,
    refetchInterval: 3000,
  });
  const transcript = useCodingTranscript(id);
  const entries = transcript.data ?? [];
  const log = useRef<FlatList<CodingSessionEntry>>(null);
  const atBottom = useRef(true);
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: ['coding-sessions'] });
  };
  const send = useMutation({
    mutationFn: (text: string) =>
      unwrap(
        api.POST('/api/v1/coding-sessions/{id}/turns', {
          params: { path: { id } },
          body: { prompt: text },
        }),
      ),
    onSuccess: (result) => {
      atBottom.current = true;
      cache.setQueryData(['coding-sessions', id], result.session);
      refresh();
    },
  });
  const stop = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/v1/coding-sessions/{id}/stop', { params: { path: { id } } })),
    onSuccess: refresh,
  });
  const current = session.data;
  const ended = !!current && CODING_SESSION_ENDED.includes(current.status);
  const last = entries.at(-1)?.event;
  const tool =
    last?.type === 'tool_use' ? last.name : last?.type === 'command' ? 'bash' : undefined;
  const working =
    current?.status === 'running' || current?.status === 'starting' || current?.status === 'queued';
  return (
    <Animated.View
      testID="code-keyboard-frame"
      style={[{ flex: 1, backgroundColor: c.background }, keyboardInsets]}
    >
      <Stack.Screen options={{ title: current?.title || 'Code' }} />
      <View style={{ flex: 1 }}>
        {!current ? (
          <Page>
            {session.isPending ? (
              <ActivityIndicator />
            ) : (
              <ErrorNote error={session.error} onRetry={() => void session.refetch()} />
            )}
          </Page>
        ) : (
          <>
            <View style={{ padding: 16, gap: 8, borderBottomWidth: 1, borderColor: c.border }}>
              <View style={row.between}>
                <View style={{ flex: 1 }}>
                  <Label weight="600">{CODER_AGENT_LABELS[current.agent]}</Label>
                  <Label muted size={12}>
                    {[current.repoFullName, current.branch].filter(Boolean).join(' · ')}
                  </Label>
                </View>
                {!ended && (
                  <Button
                    title="Stop"
                    variant="secondary"
                    disabled={!connected}
                    loading={stop.isPending}
                    onPress={() => stop.mutate()}
                  />
                )}
              </View>
              {current.status !== 'settled' && (
                <Label muted size={13}>
                  {sessionStatusWords[current.status]}
                </Label>
              )}
              <ErrorNote error={stop.error || session.error} />
            </View>
            <FlatList
              ref={log}
              data={entries}
              keyExtractor={(entry) => String(entry.seq)}
              contentContainerStyle={{ padding: 18, gap: 18 }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              automaticallyAdjustKeyboardInsets={false}
              onScroll={({ nativeEvent: e }) => {
                atBottom.current =
                  e.contentSize.height - e.contentOffset.y - e.layoutMeasurement.height < 80;
              }}
              scrollEventThrottle={100}
              onContentSizeChange={() => {
                if (atBottom.current) log.current?.scrollToEnd({ animated: false });
              }}
              renderItem={({ item }) => (
                <Entry entry={item} agent={CODER_AGENT_LABELS[current.agent]} />
              )}
              ListEmptyComponent={
                transcript.isPending ? <ActivityIndicator /> : <Label muted>No messages yet.</Label>
              }
              ListFooterComponent={
                <View style={{ gap: 12 }}>
                  <ErrorNote error={transcript.error} onRetry={() => void transcript.refetch()} />
                  {working && connected && (
                    <AgentOrb
                      tool={tool}
                      label={
                        current.status === 'queued'
                          ? 'Queued'
                          : current.status === 'starting'
                            ? 'Starting agent…'
                            : tool
                              ? `Working · ${tool}`
                              : 'Thinking…'
                      }
                    />
                  )}
                  {current.status === 'waiting' && (
                    <Label muted>Waiting for approval or the agent to become available.</Label>
                  )}
                </View>
              }
            />
            <View style={{ gap: 8 }}>
              <SessionApprovals sessionId={id} />
              {!connected && (
                <Label muted style={{ paddingHorizontal: 22 }}>
                  You’re offline. Reconnect to send a message.
                </Label>
              )}
              {inputFocused && (
                <View style={{ paddingHorizontal: 22 }}>
                  <AcceptEdits botId={current.botId} composer />
                </View>
              )}
              <Composer
                onFocusChange={setInputFocused}
                textOnly
                maxLength={4000}
                sending={send.isPending}
                sendDisabled={!connected || !ended}
                onSend={({ text }) => send.mutateAsync(text!)}
              />
              {!ended && (
                <Label muted size={12} style={{ paddingHorizontal: 22, paddingBottom: 8 }}>
                  Messages can be sent after the agent finishes.
                </Label>
              )}
              <ErrorNote error={send.error} />
            </View>
          </>
        )}
      </View>
    </Animated.View>
  );
}

function RichText({ text }: { text: string }) {
  const c = useTheme();
  return (
    <Markdown
      style={{
        body: { color: c.foreground, fontSize: 16, lineHeight: 24 },
        fence: { backgroundColor: c.muted, color: c.foreground, borderColor: c.border },
        code_inline: { backgroundColor: c.muted, color: c.foreground },
        link: { color: c.foreground },
        blockquote: { backgroundColor: c.muted, borderColor: c.border },
      }}
    >
      {text}
    </Markdown>
  );
}

export function Entry({ entry, agent }: { entry: CodingSessionEntry; agent: string }) {
  const [expanded, setExpanded] = useState(false);
  const c = useTheme();
  const event = entry.event;
  if (event.type === 'prompt')
    return (
      <View
        style={{
          alignSelf: 'flex-end',
          maxWidth: '92%',
          backgroundColor: c.muted,
          borderRadius: 16,
          padding: 14,
          gap: 4,
        }}
      >
        <Label muted size={12}>
          {event.by === 'owner' ? 'You' : 'Bot'} · Turn {entry.turn}
        </Label>
        <Label selectable>{event.text}</Label>
      </View>
    );
  if (event.type === 'text')
    return (
      <View>
        <Label muted size={12}>
          {agent}
        </Label>
        <RichText text={event.text} />
      </View>
    );
  if (event.type === 'result')
    return (
      <View>
        <Label muted size={12}>
          {event.ok ? 'Turn complete' : 'Turn failed'}
        </Label>
        {!!event.summary && <RichText text={event.summary} />}
        {!!event.error && <Label style={{ color: c.danger }}>{event.error}</Label>}
      </View>
    );
  if (event.type === 'error') return <Label style={{ color: c.danger }}>{event.message}</Label>;
  if (event.type === 'usage')
    return (
      <Label muted size={12}>
        {event.input_tokens.toLocaleString()} in · {event.output_tokens.toLocaleString()} out
        {event.cost_usd !== undefined ? ` · $${event.cost_usd.toFixed(4)}` : ''}
      </Label>
    );
  const title =
    event.type === 'tool_use'
      ? event.name
      : event.type === 'command'
        ? 'bash'
        : event.type === 'file_change'
          ? `${event.kind} · ${event.path}`
          : event.title;
  const detail =
    event.type === 'tool_use'
      ? event.summary
      : event.type === 'command'
        ? [
            event.command,
            event.summary,
            event.exit_code !== undefined ? `Exit code: ${event.exit_code}` : null,
          ]
            .filter(Boolean)
            .join('\n')
        : event.type === 'file_change'
          ? `${event.path}\n+${event.added ?? 0} −${event.removed ?? 0}`
          : event.detail || event.title;
  return (
    <View style={{ backgroundColor: c.muted, borderRadius: 12, overflow: 'hidden' }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${title}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => [
          row.base,
          { padding: 14, minHeight: 48, opacity: pressed ? 0.6 : 1 },
        ]}
      >
        <Icon name="terminal-outline" size={17} />
        <Label size={14} style={{ flex: 1 }}>
          {title}
        </Label>
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={16} />
      </Pressable>
      {expanded && (
        <ScrollView
          horizontal
          style={{ maxHeight: 280 }}
          contentContainerStyle={{ padding: 14, paddingTop: 0 }}
        >
          <Label
            selectable
            size={12}
            style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}
          >
            {detail}
          </Label>
        </ScrollView>
      )}
    </View>
  );
}
