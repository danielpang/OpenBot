import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
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
import { useTheme } from '../theme';
import { groupTitle, useBots, useChats, type Bot } from './data';

export function BotsScreen() {
  const c = useTheme();
  const mobile = useMobile();
  const bots = useBots();
  const chats = useChats();
  const [search, setSearch] = useState('');
  const [create, setCreate] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
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
  function botRow(bot: Bot) {
    return (
      <Pressable
        key={bot.id}
        accessibilityRole="button"
        accessibilityLabel={`Open ${bot.name}`}
        onPress={() => router.push(`/bot/${bot.id}`)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
          paddingVertical: 13,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <BotAvatar bot={bot} />
        <View style={{ flex: 1, gap: 3 }}>
          <Label weight="600" size={18}>
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
  return (
    <Page scroll={false}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing && mobile.connected}
            onRefresh={() => void refreshManually()}
          />
        }
        contentContainerStyle={{ padding: 22, paddingBottom: 50, gap: 28 }}
      >
        <View style={row.between}>
          <View>
            <Label size={32} weight="700">
              OpenBots
            </Label>
            <View style={[row.base, { gap: 6 }]}>
              <View
                accessibilityRole="image"
                accessibilityLabel={
                  mobile.connected ? 'Connected to server' : 'Disconnected from server'
                }
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: mobile.connected ? c.success : c.danger,
                }}
              />
              <Label muted size={13}>
                {mobile.host?.name ?? 'OpenBots'} ·{' '}
                {mobile.connected
                  ? 'Connected'
                  : mobile.connecting
                    ? 'Reconnecting…'
                    : 'Disconnected'}
              </Label>
            </View>
          </View>
          <GlassIconButton
            icon="add"
            label="Create a Bot or group"
            onPress={() => setCreate(true)}
          />
        </View>
        <Field
          accessibilityLabel="Search Bots and groups"
          placeholder="Search Bots and groups"
          value={search}
          onChangeText={setSearch}
        />
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
                onPress={() => router.push(`/chat/${chat.id}`)}
                style={[row.base, { paddingVertical: 10 }]}
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
      </ScrollView>
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
            <Label muted>Choose 2 to 6 Bots.</Label>
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
                        : current.length < 6
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
          <Label muted>You can choose a model, Skills and tools on your computer.</Label>
        )}
        <ErrorNote error={error} />
        <Button
          title={kind === 'bot' ? 'Create Bot' : 'Start group'}
          loading={busy}
          disabled={kind === 'bot' ? !name.trim() : selected.length < 2}
          onPress={() => void create()}
        />
      </Page>
    </Modal>
  );
}
