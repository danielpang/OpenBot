import { View } from 'react-native';
import { unwrap, type components } from '@openbots/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi, useMobile } from '../api/provider';
import { Button, Card, ErrorNote, Label, row } from '../components/ui';
import { AcceptEdits } from '../components/accept-edits';

export function SessionApprovals({ sessionId }: { sessionId: string }) {
  const api = useApi();
  const approvals = useQuery({
    queryKey: ['approvals'],
    queryFn: async () => (await unwrap(api.GET('/api/v1/approvals'))).items,
    refetchInterval: 3000,
  });
  const pending =
    approvals.data?.filter((item) => item.sessionId === sessionId && item.status === 'pending') ??
    [];
  if (!pending.length && !approvals.error) return null;
  return (
    <View testID="session-approvals" style={{ gap: 10 }}>
      <ErrorNote error={approvals.error} onRetry={() => void approvals.refetch()} />
      {pending.map((approval) => (
        <SessionApproval key={approval.id} approval={approval} />
      ))}
    </View>
  );
}

export function SessionApproval({
  approval,
}: {
  approval: components['schemas']['PendingApproval'];
}) {
  const api = useApi();
  const { connected } = useMobile();
  const cache = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny') =>
      unwrap(
        api.POST('/api/v1/approvals/{id}/decide', {
          params: { path: { id: approval.id } },
          body: { decision },
        }),
      ),
    onSuccess: async () => {
      await Promise.all(
        ['approvals', 'coding-sessions', 'inbox', 'messages'].map((key) =>
          cache.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
  });
  return (
    <Card>
      <Label weight="600" style={{ flexShrink: 1 }}>
        {approval.reason || 'Approval needed'}
      </Label>
      <Label muted size={13} style={{ flexShrink: 1 }}>
        {approval.summary || approval.toolName}
      </Label>
      <View style={row.base}>
        <Button
          title="Decline"
          variant="secondary"
          disabled={!connected || decide.isPending}
          onPress={() => decide.mutate('deny')}
        />
        <Button
          title="Approve"
          disabled={!connected || decide.isPending}
          onPress={() => decide.mutate('approve')}
        />
      </View>
      <AcceptEdits botId={approval.botId} compact />
      <ErrorNote error={decide.error} />
    </Card>
  );
}
