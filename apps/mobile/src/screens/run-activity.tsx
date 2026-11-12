import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { unwrap } from '@openbots/api-client';
import { useApi } from '../api/provider';
import { Empty, ErrorNote, Icon, Label, Page, row } from '../components/ui';

/** A run's steps, oldest first. `live` keeps them refreshing while the run works. */
export function RunSteps({ runId, live = false }: { runId: string; live?: boolean }) {
  const api = useApi();
  const steps = useQuery({
    queryKey: ['runs', runId, 'steps'],
    queryFn: async () =>
      (await unwrap(api.GET('/api/v1/runs/{id}/steps', { params: { path: { id: runId } } }))).items,
    refetchInterval: live ? 3000 : false,
  });
  return (
    <>
      <ErrorNote error={steps.error} />
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
      {steps.data?.length === 0 ? (
        <Empty
          icon="pulse-outline"
          title="No steps"
          detail="This reply did not read, search or use a tool."
        />
      ) : null}
    </>
  );
}

/** One reply's activity, opened from the Activity icon under it. */
export function RunActivityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Page>
      <Stack.Screen options={{ title: 'Activity' }} />
      <RunSteps runId={id} />
    </Page>
  );
}
