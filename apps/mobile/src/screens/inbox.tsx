import { ActivityIndicator, Alert, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { unwrap } from '@openbots/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../api/provider';
import { Button, Card, Empty, ErrorNote, Icon, Label, Page, row } from '../components/ui';
import { BotAvatar } from '../components/bot-avatar';
import { NativeWidget } from '../transcript/widget';
import { useBots } from './data';
import { useInbox } from './inbox-data';

export function InboxScreen() {
  const api = useApi();
  const bots = useBots();
  const inbox = useInbox();
  const cache = useQueryClient();
  const widgets = inbox.widgets;
  async function decide(id: string, decision: 'approve' | 'deny') {
    try {
      await unwrap(
        api.POST('/api/v1/approvals/{id}/decide', { params: { path: { id } }, body: { decision } }),
      );
      await cache.invalidateQueries({ queryKey: ['approvals'] });
      await cache.invalidateQueries({ queryKey: ['inbox'] });
    } catch (e) {
      Alert.alert('Could not decide', e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <Page>
      <View>
        <Label size={32} weight="700">
          Inbox
        </Label>
        <Label muted>When your Bots need you.</Label>
      </View>
      <ErrorNote error={inbox.error} onRetry={() => void inbox.refetch()} />
      {inbox.loading ? <ActivityIndicator /> : null}
      {[...(inbox.approvals ?? [])].reverse().map((approval) => {
        const bot = bots.data?.find((bot) => bot.id === approval.botId);
        return (
          <Card key={approval.id}>
            {bot ? (
              <View style={row.base}>
                <BotAvatar bot={bot} size={30} />
                <Label weight="600">{bot.name}</Label>
              </View>
            ) : null}
            <View style={row.base}>
              <Icon name="hand-left-outline" size={18} />
              <Label size={13} muted>
                Approval needed
              </Label>
            </View>
            <Label weight="600">{approval.toolName}</Label>
            <Label>{approval.summary}</Label>
            {approval.reason ? (
              <Label muted size={14}>
                {approval.reason}
              </Label>
            ) : null}
            <View style={row.base}>
              <View style={{ flex: 1 }}>
                <Button
                  title="Deny"
                  variant="secondary"
                  onPress={() => void decide(approval.id, 'deny')}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button title="Approve" onPress={() => void decide(approval.id, 'approve')} />
              </View>
            </View>
            {approval.chatId ? (
              <Button
                title="Open conversation"
                variant="ghost"
                onPress={() =>
                  router.push({
                    pathname: '/chat/[id]',
                    params: {
                      id: approval.chatId!,
                      message: approval.messageId ?? '',
                      title: bot?.name ?? 'Conversation',
                    },
                  })
                }
              />
            ) : null}
          </Card>
        );
      })}
      {widgets.map(({ message, part, index }) => {
        const bot = bots.data?.find((bot) => bot.chatId === message.chatId);
        return (
          <View key={`${message.id}-${index}`} style={{ gap: 10 }}>
            {bot ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push(`/bot/${bot.id}`)}
                style={row.base}
              >
                <BotAvatar bot={bot} size={28} />
                <Label weight="600">{bot.name}</Label>
              </Pressable>
            ) : null}
            <NativeWidget
              messageId={message.id}
              index={index}
              part={part}
              onUpdated={() => {
                void cache.invalidateQueries({ queryKey: ['messages', message.chatId] });
                void cache.invalidateQueries({ queryKey: ['inbox'] });
              }}
            />
          </View>
        );
      })}
      {!inbox.loading && !inbox.approvals?.length && !widgets.length ? (
        <Empty
          icon="checkmark-done-outline"
          title="All caught up"
          detail="Approvals, questions and sign-in requests will appear here."
        />
      ) : null}
    </Page>
  );
}
