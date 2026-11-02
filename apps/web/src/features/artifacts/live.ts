import type { WsEventOf } from '@openbots/shared';
import type { ArtifactCardState } from '@openbots/widgets/react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useRealtime } from '../transcript/realtime.js';
import { artifactQuery } from './api.js';

// Live Artifacts (plan 14.2): `artifact.created` and `artifact.updated` on the
// app's one socket. The viewer and the Artifacts tab refetch what an event
// changes; a card follows the title and version it carries.

export type ArtifactEvent = WsEventOf<'artifact.created'> | WsEventOf<'artifact.updated'>;

/** Calls the latest `listener` for every Artifact event until unmount. */
function useArtifactEvents(listener: (event: ArtifactEvent) => void) {
  const { client } = useRealtime();
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => {
    if (!client) return;
    const handle = (event: ArtifactEvent) => latest.current(event);
    const offCreated = client.on('artifact.created', handle);
    const offUpdated = client.on('artifact.updated', handle);
    return () => {
      offCreated();
      offUpdated();
    };
  }, [client]);
}

/** Marks stale what an event changes: the Artifact and its versions, and its Bot's list. */
export function invalidateForEvent(queryClient: QueryClient, event: ArtifactEvent) {
  const id = event.payload.artifactId;
  void queryClient.invalidateQueries({ queryKey: ['artifacts', id], exact: true });
  void queryClient.invalidateQueries({ queryKey: ['artifacts', id, 'versions'], exact: true });
  if (event.bot_id) {
    void queryClient.invalidateQueries({ queryKey: ['bot-artifacts', event.bot_id] });
  }
}

/** Keeps one Artifact (the viewer) or one Bot's list (the tab) current. */
export function useArtifactRefresh({ artifactId, botId }: { artifactId?: string; botId?: string }) {
  const queryClient = useQueryClient();
  useArtifactEvents((event) => {
    if (
      (artifactId !== undefined && event.payload.artifactId === artifactId) ||
      (botId !== undefined && event.bot_id === botId)
    ) {
      invalidateForEvent(queryClient, event);
    }
  });
}

/** What a card shows beyond its props: the newest title and version heard of. */
export function useArtifactCardState(artifactId: string): ArtifactCardState | undefined {
  const cached = useQuery({ ...artifactQuery(artifactId), enabled: false }).data;
  const [heard, setHeard] = useState<ArtifactCardState>();
  useArtifactEvents((event) => {
    if (event.payload.artifactId !== artifactId) return;
    const version = typeof event.payload.version === 'number' ? event.payload.version : undefined;
    setHeard((prev) => newer(prev, { title: event.payload.title, version }));
  });
  const fromCache = cached && { title: cached.title, version: cached.currentVersion?.version };
  return newer(fromCache, heard);
}

function newer(
  a: ArtifactCardState | undefined,
  b: ArtifactCardState | undefined,
): ArtifactCardState | undefined {
  if (!a) return b;
  if (!b) return a;
  return (b.version ?? 0) >= (a.version ?? 0) ? { ...a, ...b } : a;
}
