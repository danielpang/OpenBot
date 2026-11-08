import { ActivityIndicator, Linking, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { unwrap } from '@openbots/api-client';
import { CODER_AGENT_LABELS, CODING_SESSION_ENDED } from '@openbots/shared';
import { sessionErrorWords, sessionStatusWords, usageWords } from '@openbots/widgets';
import { useApi, useMobile } from '../api/provider';
import { Button, Card, ErrorNote, Label, Page, Section } from '../components/ui';
import { useCodingSession } from './data';

export function CodingSessionDetailsScreen({ id }: { id: string }) {
  const session = useCodingSession(id);
  const api = useApi();
  const { connected } = useMobile();
  const cache = useQueryClient();
  const stop = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/v1/coding-sessions/{id}/stop', { params: { path: { id } } })),
    onSuccess: () => cache.invalidateQueries({ queryKey: ['coding-sessions'] }),
  });
  const current = session.data;
  return (
    <>
      <Stack.Screen options={{ title: 'Session details' }} />
      <Page>
        <ErrorNote error={session.error} onRetry={() => void session.refetch()} />
        {!current ? (
          session.isPending ? (
            <ActivityIndicator />
          ) : null
        ) : (
          <>
            <Label size={24} weight="700">
              {current.title || 'Code'}
            </Label>
            <Card>
              <Detail label="Agent" value={CODER_AGENT_LABELS[current.agent]} />
              <Detail label="Status" value={sessionStatusWords[current.status]} />
              <Detail label="Repository" value={current.repoFullName} />
              <Detail label="Branch" value={current.branch} />
              <Detail label="Base branch" value={current.base} />
              <Detail
                label="Mode"
                value={{ plan: 'Plan', edit: 'Edit', pr: 'Pull request' }[current.mode]}
              />
              <Detail
                label="Started"
                value={current.startedAt && new Date(current.startedAt).toLocaleString()}
              />
              <Detail
                label="Finished"
                value={current.finishedAt && new Date(current.finishedAt).toLocaleString()}
              />
            </Card>
            {current.error && (
              <Section title="Session error">
                <Label selectable>{sessionErrorWords(current.error)}</Label>
              </Section>
            )}
            {current.summary && (
              <Section title="Summary">
                <Label selectable>{current.summary}</Label>
              </Section>
            )}
            {current.usage && <Label muted>{usageWords(current.usage, current.agent)}</Label>}
            {current.prUrl && (
              <Button
                title="Open pull request"
                variant="secondary"
                onPress={() => void Linking.openURL(current.prUrl!)}
              />
            )}
            {current.diffArtifactId && (
              <Button
                title="View diff"
                variant="secondary"
                onPress={() => router.push(`/artifact/${current.diffArtifactId}`)}
              />
            )}
            {!CODING_SESSION_ENDED.includes(current.status) && (
              <Button
                title="Stop"
                variant="danger"
                disabled={!connected}
                loading={stop.isPending}
                onPress={() => stop.mutate()}
              />
            )}
            <ErrorNote error={stop.error} />
          </>
        )}
      </Page>
    </>
  );
}

function Detail({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <View style={{ gap: 4 }}>
      <Label muted size={13}>
        {label}
      </Label>
      <Label selectable>{value}</Label>
    </View>
  );
}
