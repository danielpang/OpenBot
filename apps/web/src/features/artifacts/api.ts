import { ApiError, unwrap, type components } from '@openbots/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../app/api.js';

// The REST calls behind the Artifact cards, the viewer and the Bot's
// Artifacts tab (plan 12.1, 14.1; A2, A4). Version content is immutable, so
// it is cached for good; the Artifact, its versions and the Bot's list are
// refetched when an `artifact.*` event arrives.

export type Artifact = components['schemas']['Artifact'];
export type ArtifactKind = components['schemas']['ArtifactKind'];
export type ArtifactVersion = NonNullable<components['schemas']['ArtifactVersion']>;

export const artifactQuery = (artifactId: string) =>
  queryOptions({
    queryKey: ['artifacts', artifactId],
    queryFn: () =>
      unwrap(api.GET('/api/v1/artifacts/{id}', { params: { path: { id: artifactId } } })),
  });

/** Every version, newest first. */
export const artifactVersionsQuery = (artifactId: string) =>
  queryOptions({
    queryKey: ['artifacts', artifactId, 'versions'],
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/api/v1/artifacts/{id}/versions', { params: { path: { id: artifactId } } }),
        )
      ).items as ArtifactVersion[],
  });

/** One version's text, for the text kinds and the diff. */
export const artifactTextQuery = (artifactId: string, version: number) =>
  queryOptions({
    queryKey: ['artifacts', artifactId, 'versions', version, 'text'],
    queryFn: async () => (await fetchContent(artifactId, version)).text(),
    staleTime: Infinity,
  });

/** One version as a Blob, for previews the browser renders itself (PDF). */
export const artifactBlobQuery = (artifactId: string, version: number) =>
  queryOptions({
    queryKey: ['artifacts', artifactId, 'versions', version, 'blob'],
    queryFn: async () => (await fetchContent(artifactId, version)).blob(),
    staleTime: Infinity,
  });

export const botArtifactsQuery = (botId: string) =>
  queryOptions({
    queryKey: ['bot-artifacts', botId],
    queryFn: async () =>
      (await unwrap(api.GET('/api/v1/bots/{id}/artifacts', { params: { path: { id: botId } } })))
        .items,
  });

/** The owner's edit (A2): a new version attributed to the user; 409 if `baseVersion` is stale. */
export function saveArtifact(artifactId: string, content: string, baseVersion?: number) {
  return unwrap(
    api.PUT('/api/v1/artifacts/{id}', {
      params: { path: { id: artifactId } },
      body: { content, ...(baseVersion !== undefined ? { baseVersion } : {}) },
    }),
  );
}

export function contentUrl(artifactId: string, version: number) {
  return `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${version}/content`;
}

async function fetchContent(artifactId: string, version: number) {
  const response = await fetch(contentUrl(artifactId, version), { credentials: 'include' });
  if (!response.ok) {
    throw new ApiError(response.status, (await response.json().catch(() => undefined)) as never);
  }
  return response;
}
