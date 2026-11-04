import { useState } from 'react';
import { Alert, Pressable, ScrollView, Switch, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { unwrap } from '@openbots/api-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../api/provider';
import { Button, Card, Empty, ErrorNote, Icon, Label, Page, Section, row } from '../components/ui';
import { BotAvatar } from '../components/bot-avatar';
import { useTheme } from '../theme';
import { useBots, type Bot } from './data';
import { BotAppearance } from './bot-appearance';

type Tab = 'Activity' | 'Artifacts' | 'Routines' | 'About';
export function BotDetailsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('Activity');
  const [editingAppearance, setEditingAppearance] = useState(false);
  const bots = useBots();
  const bot = bots.data?.find((bot) => bot.id === id);
  const c = useTheme();
  return (
    <Page>
      <Stack.Screen options={{ title: 'Bot details' }} />
      {bot ? (
        <>
          <View style={{ alignItems: 'center', gap: 8 }}>
            <BotAvatar bot={bot} size={88} />
            <Label size={28} weight="700">
              {bot.name}
            </Label>
            <Label muted>{bot.label || `@${bot.handle}`}</Label>
            {!editingAppearance ? (
              <Button
                title="Edit appearance"
                variant="ghost"
                icon="color-palette-outline"
                onPress={() => setEditingAppearance(true)}
              />
            ) : null}
          </View>
          {editingAppearance ? (
            <BotAppearance
              key={bot.id}
              bot={bot}
              bots={bots.data ?? []}
              onClose={() => setEditingAppearance(false)}
            />
          ) : null}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8 }}
          >
            {(['Activity', 'Artifacts', 'Routines', 'About'] as const).map((item) => (
              <Pressable
                key={item}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === item }}
                onPress={() => setTab(item)}
                style={{
                  backgroundColor: tab === item ? c.primary : c.muted,
                  paddingHorizontal: 15,
                  paddingVertical: 11,
                  borderRadius: 18,
                }}
              >
                <Label
                  size={14}
                  weight="600"
                  style={{ color: tab === item ? c.primaryForeground : c.foreground }}
                >
                  {item}
                </Label>
              </Pressable>
            ))}
          </ScrollView>
          {tab === 'Activity' ? (
            <Activity bot={bot} />
          ) : tab === 'Artifacts' ? (
            <Artifacts bot={bot} />
          ) : tab === 'Routines' ? (
            <Routines bot={bot} />
          ) : (
            <About bot={bot} />
          )}
          <Button
            title="Screen preview"
            variant="secondary"
            icon="desktop-outline"
            onPress={() => router.push(`/bot/${bot.id}/preview`)}
          />
        </>
      ) : (
        <ErrorNote error={bots.error} />
      )}
    </Page>
  );
}
function Activity({ bot }: { bot: Bot }) {
  const api = useApi();
  const runId = bot.state.runId;
  const steps = useQuery({
    queryKey: ['runs', runId, 'steps'],
    enabled: !!runId,
    queryFn: async () =>
      runId
        ? (await unwrap(api.GET('/api/v1/runs/{id}/steps', { params: { path: { id: runId } } })))
            .items
        : [],
    refetchInterval: bot.state.state === 'working' ? 3000 : false,
  });
  return (
    <>
      <ErrorNote error={steps.error} />
      {bot.state.currentAction ? (
        <Card>
          <Label weight="600">{bot.state.currentAction}</Label>
          <Label muted size={13}>
            {bot.state.state}
          </Label>
        </Card>
      ) : null}
      {steps.data?.map((step) => (
        <View key={step.id} style={[row.base, { alignItems: 'flex-start' }]}>
          <Icon
            name={step.type === 'error' ? 'alert-circle-outline' : 'checkmark-circle-outline'}
            size={19}
          />
          <View style={{ flex: 1, gap: 4 }}>
            <Label>{step.label}</Label>
            <Label muted size={12}>
              {new Date(step.createdAt).toLocaleTimeString()}
              {step.durationMs ? ` · ${(step.durationMs / 1000).toFixed(1)}s` : ''}
            </Label>
          </View>
        </View>
      ))}
      {!runId ? (
        <Empty
          icon="pulse-outline"
          title="No recent activity"
          detail="Run steps appear here while your Bot works."
        />
      ) : null}
    </>
  );
}
function Artifacts({ bot }: { bot: Bot }) {
  const api = useApi();
  const query = useQuery({
    queryKey: ['bot-artifacts', bot.id],
    queryFn: async () =>
      (await unwrap(api.GET('/api/v1/bots/{id}/artifacts', { params: { path: { id: bot.id } } })))
        .items,
  });
  return (
    <>
      <ErrorNote error={query.error} />
      {query.data?.map((artifact) => (
        <Pressable
          key={artifact.id}
          accessibilityRole="button"
          onPress={() => router.push(`/artifact/${artifact.id}`)}
        >
          <Card>
            <View style={row.base}>
              <Icon name="layers-outline" />
              <View style={{ flex: 1 }}>
                <Label weight="600">{artifact.title}</Label>
                <Label muted size={13}>
                  {artifact.kind} · Version {artifact.currentVersion?.version ?? 1}
                </Label>
              </View>
              <Icon name="chevron-forward" size={17} />
            </View>
          </Card>
        </Pressable>
      ))}
      {query.data?.length === 0 ? (
        <Empty
          icon="layers-outline"
          title="Nothing made yet"
          detail="Documents, code and designs your Bot makes appear here."
        />
      ) : null}
    </>
  );
}
function Routines({ bot }: { bot: Bot }) {
  const api = useApi();
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ['routines', bot.id],
    queryFn: async () =>
      (await unwrap(api.GET('/api/v1/bots/{id}/routines', { params: { path: { id: bot.id } } })))
        .items,
    refetchInterval: 15000,
  });
  const [busy, setBusy] = useState<string | null>(null);
  async function update(id: string, enabled: boolean) {
    try {
      await unwrap(
        api.PATCH('/api/v1/routines/{id}', { params: { path: { id } }, body: { enabled } }),
      );
      await cache.invalidateQueries({ queryKey: ['routines', bot.id] });
    } catch (error) {
      Alert.alert(
        'Could not update routine',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  async function run(id: string) {
    setBusy(id);
    try {
      await unwrap(api.POST('/api/v1/routines/{id}/run-now', { params: { path: { id } } }));
      await cache.invalidateQueries({ queryKey: ['routines', bot.id] });
    } catch (error) {
      Alert.alert('Could not run routine', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <ErrorNote error={query.error} />
      {query.data?.map((routine) => (
        <Card key={routine.id}>
          <View style={row.between}>
            <Label weight="600" style={{ flex: 1 }}>
              {routine.name}
            </Label>
            <Switch
              accessibilityLabel={`Enable ${routine.name}`}
              value={routine.enabled}
              onValueChange={(enabled) => void update(routine.id, enabled)}
            />
          </View>
          <Label muted size={14}>
            {routine.schedule}
          </Label>
          <Label>{routine.prompt}</Label>
          {routine.nextRunAt ? (
            <Label muted size={12}>
              Next · {new Date(routine.nextRunAt).toLocaleString()}
            </Label>
          ) : null}
          <Button
            title="Run now"
            variant="secondary"
            loading={busy === routine.id}
            onPress={() => void run(routine.id)}
          />
        </Card>
      ))}
      {query.data?.length === 0 ? (
        <Empty
          icon="repeat-outline"
          title="No routines yet"
          detail="Create a routine on your computer, then run or pause it here."
        />
      ) : null}
    </>
  );
}
function About({ bot }: { bot: Bot }) {
  const api = useApi();
  const cache = useQueryClient();
  const library = useQuery({
    queryKey: ['skills'],
    queryFn: () => unwrap(api.GET('/api/v1/skills')),
  });
  const skills = useQuery({
    queryKey: ['bot-skills', bot.id],
    queryFn: () =>
      unwrap(api.GET('/api/v1/bots/{id}/skills', { params: { path: { id: bot.id } } })),
  });
  async function pin() {
    try {
      if (bot.pinned)
        await unwrap(api.POST('/api/v1/bots/{id}/unpin', { params: { path: { id: bot.id } } }));
      else await unwrap(api.POST('/api/v1/bots/{id}/pin', { params: { path: { id: bot.id } } }));
      await cache.invalidateQueries({ queryKey: ['bots'] });
    } catch (error) {
      Alert.alert('Could not pin Bot', error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <>
      <Section title="About">
        <Card>
          <Label>{bot.description || 'No standing instructions.'}</Label>
          <Label muted size={13}>
            @{bot.handle}
          </Label>
        </Card>
      </Section>
      <Section title="Model">
        <Label>{bot.modelConfig?.model_id ?? 'No model selected'}</Label>
      </Section>
      <Section title="Tools">
        <Label muted size={14}>
          {Object.entries(bot.toolPolicy.tools ?? {})
            .map(([name, policy]) => `${name} · ${policy}`)
            .join('\n') || 'Default tool policies'}
        </Label>
      </Section>
      <Section title="Skills">
        <Label muted size={14}>
          {library.data?.items
            .filter((skill) => skills.data?.skillIds.includes(skill.id))
            .map((skill) => skill.name)
            .join(', ') || 'No Skills assigned'}
        </Label>
      </Section>
      <Button
        title={bot.pinned ? 'Unpin Bot' : 'Pin Bot'}
        variant="secondary"
        icon="pin-outline"
        onPress={() => void pin()}
      />
      <Label muted size={13}>
        Edit models, tools and Skills on your computer.
      </Label>
    </>
  );
}
