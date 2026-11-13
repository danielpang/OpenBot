import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextInput,
} from 'react-native';
import { router } from 'expo-router';
import { unwrap } from '@openbots/api-client';
import { generate, newBotAvatar } from '@openbots/avatars';
import { SvgXml } from 'react-native-svg';
import { useQueryClient } from '@tanstack/react-query';
import { useApi, useMobile } from '../api/provider';
import { BotAvatar } from '../components/bot-avatar';
import { GlassIconButton } from '../components/glass';
import { Button, Empty, ErrorNote, Field, Icon, Label, Page, Section, row } from '../components/ui';
import { OfficeSheet } from '../office/office-sheet';
import { useTheme } from '../theme';
import { groupTitle, useBots, useChats, useGroupLimit, type Bot } from './data';

// On iOS, a pull past the top this far opens search, and this far refreshes.
const PULL_TO_SEARCH = 40;
const PULL_TO_REFRESH = 110;
// How far past the end of the list a pull must go to open the office.
const PULL_TO_OFFICE = 120;

export function BotsScreen({
  sidebar = false,
  selected,
}: {
  sidebar?: boolean;
  selected?: { kind: 'bot' | 'chat'; id?: string };
}) {
  const c = useTheme();
  const mobile = useMobile();
  const bots = useBots();
  const chats = useChats();
  const [search, setSearch] = useState('');
  const hostName = mobile.host?.name?.trim();
  const [create, setCreate] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const gap = sidebar ? 20 : 28;
  // On iOS one pull from the top does two things, by distance: a short pull opens search
  // with the keyboard up, a long one refreshes. The native refresh control fires too
  // early to leave room for search, so iOS measures the pull itself.
  const pullGestures = Platform.OS === 'ios';
  const [searchShown, setSearchShown] = useState(!pullGestures);
  const [pull, setPull] = useState<'none' | 'search' | 'refresh'>('none');
  // The offset the list rests at when scrolled to the top. It depends on the safe area
  // the system applies, so it is learned from where drags begin rather than assumed.
  const restY = useRef<number | undefined>(undefined);
  const searchInput = useRef<TextInput>(null);
  // Opened by a pull and nothing typed yet: the list is covered so only search is in view.
  const searchCovering = pullGestures && searchShown && !search;
  useEffect(() => {
    if (!pullGestures || !searchShown) return;
    // Focus once the field is laid out, so the keyboard reliably comes up.
    const focus = setTimeout(() => searchInput.current?.focus(), 50);
    return () => clearTimeout(focus);
  }, [pullGestures, searchShown]);
  function closeSearch() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSearchShown(false);
  }
  const dragFromTop = useRef(false);
  // Pulling up past the end of the list opens the office, an easter egg from the Mac app.
  const [officeOpen, setOfficeOpen] = useState(false);
  const [pastEnd, setPastEnd] = useState(false);
  // The space the tab bar and home indicator take below the list. Learned from where iOS
  // settles a pull past the end; this guess only places the hint before then.
  const bottomInset = useRef(83);
  function beyondEnd({ contentOffset, contentSize, layoutMeasurement }: NativeScrollEvent) {
    if (!contentSize || !layoutMeasurement) return -Infinity;
    const end = Math.max(
      restY.current ?? 0,
      contentSize.height - layoutMeasurement.height + bottomInset.current,
    );
    return contentOffset.y - end;
  }
  function pullDistance(event: NativeSyntheticEvent<NativeScrollEvent>) {
    return (restY.current ?? 0) - event.nativeEvent.contentOffset.y;
  }
  function beginPull(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const y = event.nativeEvent.contentOffset.y;
    if (restY.current === undefined || y < restY.current) restY.current = y;
    dragFromTop.current = y <= restY.current + 1;
  }
  function trackPull(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const office = beyondEnd(event.nativeEvent) >= PULL_TO_OFFICE;
    if (office !== pastEnd) setPastEnd(office);
    if (!dragFromTop.current) return;
    const distance = pullDistance(event);
    // Once far enough to refresh, it stays a refresh, as with the native control.
    const next =
      pull === 'refresh' || distance >= PULL_TO_REFRESH
        ? 'refresh'
        : distance >= PULL_TO_SEARCH && !searchShown
          ? 'search'
          : 'none';
    if (next !== pull) setPull(next);
  }
  function endPull(event: NativeSyntheticEvent<NativeScrollEvent>) {
    setPastEnd(false);
    const { contentOffset, contentSize, layoutMeasurement, targetContentOffset } =
      event.nativeEvent;
    // iOS reports where the list will settle, so past the end is measured exactly here.
    if (targetContentOffset && contentOffset.y - targetContentOffset.y >= PULL_TO_OFFICE) {
      if (contentSize && layoutMeasurement && targetContentOffset.y > (restY.current ?? 0)) {
        bottomInset.current =
          targetContentOffset.y - (contentSize.height - layoutMeasurement.height);
      }
      setOfficeOpen(true);
      return;
    }
    if (!dragFromTop.current) return;
    dragFromTop.current = false;
    const action = pull;
    setPull('none');
    if (action === 'refresh') void refreshManually();
    // Judge search on release, so pulling back up cancels it.
    else if (!searchShown && pullDistance(event) >= PULL_TO_SEARCH) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setSearchShown(true);
    }
  }
  async function refreshManually() {
    if (!mobile.transport) {
      mobile.refresh();
      return;
    }
    setRefreshing(true);
    try {
      await Promise.allSettled([bots.refetch(), chats.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }
  const visible = (bots.data ?? []).filter(
    (bot) =>
      !bot.hidden &&
      `${bot.name} ${bot.handle} ${bot.label ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  );
  const groups = (chats.data ?? []).filter(
    (chat) =>
      chat.type === 'group' &&
      groupTitle(chat, bots.data).toLowerCase().includes(search.toLowerCase()),
  );
  function openConversation(kind: 'bot' | 'chat', id: string) {
    const href = kind === 'bot' ? (`/bot/${id}` as const) : (`/chat/${id}` as const);
    if (sidebar) router.navigate(href);
    else router.push(href);
  }
  function botRow(bot: Bot) {
    const active =
      selected?.kind === 'bot'
        ? selected.id === bot.id
        : selected?.kind === 'chat' && selected.id === bot.chatId;
    return (
      <Pressable
        key={bot.id}
        accessibilityRole="button"
        accessibilityLabel={`Open ${bot.name}`}
        accessibilityState={{ selected: !!active }}
        onPress={() => openConversation('bot', bot.id)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
          paddingVertical: 13,
          paddingHorizontal: sidebar ? 10 : 0,
          borderRadius: 12,
          backgroundColor: active ? c.accent : 'transparent',
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <BotAvatar bot={bot} />
        <View style={{ flex: 1, gap: 3 }}>
          <Label weight="600" size={sidebar ? 16 : 18}>
            {bot.name}
          </Label>
          <Label muted size={14}>
            {bot.state.currentAction || bot.label || `@${bot.handle}`}
          </Label>
        </View>
        <Icon name="chevron-forward" size={17} color={c.mutedForeground} />
      </Pressable>
    );
  }
  function searchField() {
    return (
      <Field
        accessibilityLabel="Search Bots and groups"
        placeholder="Search Bots and groups"
        value={search}
        onChangeText={setSearch}
        ref={searchInput}
        returnKeyType="search"
        // Put away again once it is dismissed without a search.
        onBlur={() => {
          if (pullGestures && !search) closeSearch();
        }}
      />
    );
  }
  return (
    <Page scroll={false}>
      <ScrollView
        contentInsetAdjustmentBehavior={sidebar ? 'never' : 'automatic'}
        onScrollBeginDrag={pullGestures ? beginPull : undefined}
        onScroll={pullGestures ? trackPull : undefined}
        scrollEventThrottle={pullGestures ? 16 : undefined}
        onScrollEndDrag={pullGestures ? endPull : undefined}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          pullGestures ? undefined : (
            <RefreshControl
              refreshing={refreshing && mobile.connected}
              onRefresh={() => void refreshManually()}
            />
          )
        }
        contentContainerStyle={{
          padding: sidebar ? 14 : 22,
          paddingBottom: 50,
          gap,
          flexGrow: 1,
        }}
      >
        {pullGestures ? (
          // Sits in the space a pull opens above the list, saying what letting go will do.
          <View
            pointerEvents="none"
            style={{ position: 'absolute', top: -44, left: 0, right: 0, alignItems: 'center' }}
          >
            {pull === 'refresh' ? (
              // Far enough to refresh: the spinner starts here and carries on once released.
              <ActivityIndicator accessibilityLabel="Release to refresh" />
            ) : pull === 'search' ? (
              <Label muted size={13}>
                Release to search
              </Label>
            ) : null}
          </View>
        ) : null}
        {pullGestures && refreshing && mobile.connected ? (
          <ActivityIndicator accessibilityLabel="Refreshing" />
        ) : null}
        <View style={row.between}>
          <View style={{ flex: 1 }}>
            <Label size={sidebar ? 24 : 32} weight="700">
              OpenBots
            </Label>
            <View style={[row.base, { gap: 6 }]}>
              <View
                accessibilityRole="image"
                accessibilityLabel={
                  mobile.connected
                    ? 'Connected to server'
                    : mobile.connectionFailed
                      ? 'Disconnected from server'
                      : 'Server'
                }
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: mobile.connected
                    ? c.success
                    : mobile.connectionFailed
                      ? c.danger
                      : c.mutedForeground,
                }}
              />
              <Label muted size={13}>
                {/* The title already says OpenBots, so a host by that name isn't repeated. */}
                {[
                  hostName && hostName.toLowerCase() !== 'openbots' ? hostName : undefined,
                  mobile.connected
                    ? 'Connected'
                    : mobile.connectionFailed
                      ? 'Disconnected'
                      : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Label>
            </View>
          </View>
          <GlassIconButton
            icon="add"
            label="Create a Bot or group"
            onPress={() => setCreate(true)}
          />
        </View>
        {searchShown ? searchField() : null}
        <View style={{ flexGrow: 1, gap }}>
        {mobile.connected ? (
          <ErrorNote error={bots.error} onRetry={() => void bots.refetch()} />
        ) : null}
        {bots.isLoading && !bots.data && mobile.connected ? <ActivityIndicator /> : null}
        {visible.some((bot) => bot.pinned) ? (
          <Section title="Pinned">{visible.filter((bot) => bot.pinned).map(botRow)}</Section>
        ) : null}
        {visible.some((bot) => !bot.pinned) ? (
          <Section title="Your Bots">{visible.filter((bot) => !bot.pinned).map(botRow)}</Section>
        ) : null}
        {groups.length ? (
          <Section title="Groups">
            {groups.map((chat) => (
              <Pressable
                key={chat.id}
                accessibilityRole="button"
                accessibilityLabel={`Open ${groupTitle(chat, bots.data)}`}
                accessibilityState={{
                  selected: selected?.kind === 'chat' && selected.id === chat.id,
                }}
                onPress={() => openConversation('chat', chat.id)}
                style={[
                  row.base,
                  {
                    paddingVertical: 10,
                    paddingHorizontal: sidebar ? 10 : 0,
                    borderRadius: 12,
                    backgroundColor:
                      selected?.kind === 'chat' && selected.id === chat.id
                        ? c.accent
                        : 'transparent',
                  },
                ]}
              >
                <View style={{ backgroundColor: c.muted, padding: 15, borderRadius: 20 }}>
                  <Icon name="people-outline" />
                </View>
                <View style={{ flex: 1 }}>
                  <Label weight="600">{groupTitle(chat, bots.data)}</Label>
                  <Label muted size={14}>
                    {chat.botIds.length} Bots
                  </Label>
                </View>
                <Icon name="chevron-forward" size={17} />
              </Pressable>
            ))}
          </Section>
        ) : null}
        {!bots.isLoading && bots.data !== undefined && !visible.length && !groups.length ? (
          <Empty
            title={search ? 'No matches' : 'Meet your first Bot'}
            detail={
              search ? 'Try another name or handle.' : 'Give a Bot a name and start a conversation.'
            }
            action={
              !search ? <Button title="Create a Bot" onPress={() => setCreate(true)} /> : undefined
            }
          />
        ) : null}
          {searchCovering ? (
            // Covers the list behind a freshly opened search. Tapping it closes search.
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close search"
              onPress={() => searchInput.current?.blur()}
              style={{
                position: 'absolute',
                top: -gap / 2,
                bottom: -50,
                left: sidebar ? -14 : -22,
                right: sidebar ? -14 : -22,
                backgroundColor: c.background,
                opacity: 0.94,
              }}
            />
          ) : null}
        </View>
        {pullGestures && pastEnd ? (
          <View
            pointerEvents="none"
            style={{ position: 'absolute', bottom: -40, left: 0, right: 0, alignItems: 'center' }}
          >
            <Label muted size={13}>
              Release to visit the office
            </Label>
          </View>
        ) : null}
      </ScrollView>
      <OfficeSheet
        visible={officeOpen}
        bots={(bots.data ?? []).filter((bot) => !bot.hidden)}
        onClose={() => setOfficeOpen(false)}
        onOpenBot={(id) => {
          setOfficeOpen(false);
          openConversation('bot', id);
        }}
      />
      <CreateSheet visible={create} onClose={() => setCreate(false)} bots={bots.data ?? []} />
    </Page>
  );
}

function CreateSheet({
  visible,
  onClose,
  bots,
}: {
  visible: boolean;
  onClose: () => void;
  bots: Bot[];
}) {
  const c = useTheme();
  const api = useApi();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<'bot' | 'group'>('bot');
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const limit = useGroupLimit();
  const [avatar, setAvatar] = useState(() => newBotAvatar(String(Date.now())));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'bot') {
        const bot = await unwrap(api.POST('/api/v1/bots', { body: { name: name.trim(), avatar } }));
        await queryClient.invalidateQueries({ queryKey: ['bots'] });
        onClose();
        setName('');
        router.push(`/bot/${bot.id}`);
      } else {
        const chat = await unwrap(
          api.POST('/api/v1/chats', {
            body: { title: name.trim() || undefined, botIds: selected },
          }),
        );
        await queryClient.invalidateQueries({ queryKey: ['chats'] });
        onClose();
        setSelected([]);
        router.push(`/chat/${chat.id}`);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <Page>
        <View style={[row.between, { paddingTop: 20 }]}>
          <Label size={28} weight="700">
            New {kind === 'bot' ? 'Bot' : 'group'}
          </Label>
          <Button title="Cancel" variant="ghost" onPress={onClose} />
        </View>
        <View style={row.base}>
          <Button
            title="Bot"
            variant={kind === 'bot' ? 'primary' : 'secondary'}
            onPress={() => setKind('bot')}
          />
          <Button
            title="Group"
            variant={kind === 'group' ? 'primary' : 'secondary'}
            onPress={() => setKind('group')}
          />
        </View>
        {kind === 'bot' ? (
          <View style={{ alignItems: 'center', gap: 12 }}>
            <SvgXml xml={generate(avatar).svg} width={88} height={88} />
            <Button
              title="Shuffle avatar"
              icon="shuffle-outline"
              variant="ghost"
              onPress={() =>
                setAvatar(
                  newBotAvatar(
                    `${Date.now()}:${Math.random()}`,
                    bots.flatMap((bot) => (bot.avatar.kind === 'generated' ? [bot.avatar] : [])),
                  ),
                )
              }
            />
          </View>
        ) : null}
        <Field
          accessibilityLabel={kind === 'bot' ? 'Bot name' : 'Group name'}
          placeholder={kind === 'bot' ? 'What’s your Bot’s name?' : 'Group name · optional'}
          value={name}
          onChangeText={setName}
        />
        {kind === 'group' ? (
          <>
            <Label muted>Choose 2 to {limit} Bots.</Label>
            {bots
              .filter((bot) => !bot.hidden)
              .map((bot) => (
                <Pressable
                  key={bot.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selected.includes(bot.id) }}
                  onPress={() =>
                    setSelected((current) =>
                      current.includes(bot.id)
                        ? current.filter((id) => id !== bot.id)
                        : current.length < limit
                          ? [...current, bot.id]
                          : current,
                    )
                  }
                  style={row.base}
                >
                  <BotAvatar bot={bot} size={44} />
                  <Label style={{ flex: 1 }}>{bot.name}</Label>
                  <Icon
                    name={selected.includes(bot.id) ? 'checkmark-circle' : 'ellipse-outline'}
                    color={selected.includes(bot.id) ? c.success : c.mutedForeground}
                  />
                </Pressable>
              ))}
          </>
        ) : (
          <Label muted>
            Choose a model and Skills in Bot details → About. Configure tools on your computer.
          </Label>
        )}
        <ErrorNote error={error} />
        <Button
          title={kind === 'bot' ? 'Create Bot' : 'Start group'}
          loading={busy}
          // The limit can drop while the sheet is open, leaving too many chosen.
          disabled={kind === 'bot' ? !name.trim() : selected.length < 2 || selected.length > limit}
          onPress={() => void create()}
        />
      </Page>
    </Modal>
  );
}
