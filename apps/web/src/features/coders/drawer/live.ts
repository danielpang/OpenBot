import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useRealtime } from '../../transcript/realtime.js';
import { codingSessionsQuery, pendingApprovalsQuery, type CodingSession } from '../api.js';

// The drawer's sessions kept current from the shared socket (CA15):
// `coding_session.updated` carries the session's view, which replaces its
// row or becomes the newest; an approval asked or answered refetches the
// pending approvals the session view matches its requests against. Mounted
// with the sidebar button, so the live count follows while the drawer is shut.

/** `sessions` with `session` in place of its row, or first when it is new. */
export function upsertSession(sessions: CodingSession[], session: CodingSession): CodingSession[] {
  const at = sessions.findIndex((s) => s.id === session.id);
  if (at === -1) return [session, ...sessions];
  return sessions.map((s, i) => (i === at ? { ...s, ...session } : s));
}

export function useCodingSessionsLive() {
  const { client } = useRealtime();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!client) return;
    const offUpdated = client.on('coding_session.updated', (event) => {
      const session = event.payload.session as unknown as CodingSession;
      const { queryKey } = codingSessionsQuery;
      if (!queryClient.getQueryData(queryKey)) {
        void queryClient.invalidateQueries({ queryKey, exact: true });
        return;
      }
      // A read in flight began before this change and would put the old row back.
      void queryClient
        .cancelQueries({ queryKey, exact: true })
        .then(() =>
          queryClient.setQueryData(queryKey, (current) =>
            current ? upsertSession(current, session) : current,
          ),
        );
    });
    const refetchApprovals = () =>
      void queryClient.invalidateQueries({ queryKey: pendingApprovalsQuery.queryKey });
    const offRequested = client.on('approval.requested', refetchApprovals);
    const offResolved = client.on('approval.resolved', refetchApprovals);
    return () => {
      offUpdated();
      offRequested();
      offResolved();
    };
  }, [client, queryClient]);
}
