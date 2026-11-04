import { useState } from 'react';
import { Modal, View } from 'react-native';
import { unwrap } from '@openbots/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../api/provider';
import { BotAvatar } from '../components/bot-avatar';
import { Button, ErrorNote, Label, Page, Section, row } from '../components/ui';
import type { Bot, Chat } from './data';

export function GroupMembers({
  chat,
  bots,
  visible,
  onClose,
}: {
  chat: Chat;
  bots: Bot[];
  visible: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const cache = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  async function change(botId: string, remove: boolean) {
    setBusy(botId);
    setError(null);
    try {
      if (remove)
        await unwrap(
          api.DELETE('/api/v1/chats/{id}/members/{botId}', {
            params: { path: { id: chat.id, botId } },
          }),
        );
      else
        await unwrap(
          api.POST('/api/v1/chats/{id}/members', {
            params: { path: { id: chat.id } },
            body: { botIds: [botId] },
          }),
        );
      await cache.invalidateQueries({ queryKey: ['chats'] });
    } catch (error) {
      setError(error);
    } finally {
      setBusy(null);
    }
  }
  function member(bot: Bot, joined: boolean) {
    return (
      <View key={bot.id} style={row.base}>
        <BotAvatar bot={bot} size={44} />
        <View style={{ flex: 1 }}>
          <Label weight="600">{bot.name}</Label>
          <Label muted size={12}>
            @{bot.handle}
          </Label>
        </View>
        <Button
          title={joined ? 'Remove' : 'Add'}
          variant="secondary"
          loading={busy === bot.id}
          disabled={!!busy || (joined ? chat.botIds.length <= 2 : chat.botIds.length >= 6)}
          onPress={() => void change(bot.id, joined)}
        />
      </View>
    );
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
          <Label size={26} weight="700">
            Group members
          </Label>
          <Button title="Done" variant="ghost" onPress={onClose} />
        </View>
        <ErrorNote error={error} />
        <Section title={`${chat.botIds.length} Bots in this group`}>
          {bots.filter((bot) => chat.botIds.includes(bot.id)).map((bot) => member(bot, true))}
        </Section>
        <Label muted size={13}>
          A group keeps 2 to 6 Bots. Mention another Bot with @ to invite it while you chat.
        </Label>
        {chat.botIds.length < 6 &&
        bots.some((bot) => !chat.botIds.includes(bot.id) && !bot.hidden) ? (
          <Section title="Add a Bot">
            {bots
              .filter((bot) => !chat.botIds.includes(bot.id) && !bot.hidden)
              .map((bot) => member(bot, false))}
          </Section>
        ) : null}
      </Page>
    </Modal>
  );
}
