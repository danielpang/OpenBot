import { z } from 'zod';

// Artifact kinds (plan 4.8, A1). The pg enum `artifact_kind` holds the same
// values; document, code and data are text and get line diffs, inline
// editing and patches (plan 12.1).

export const ARTIFACT_KINDS = ['document', 'code', 'data', 'design', 'file'] as const;

export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);

export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const TEXT_ARTIFACT_KINDS: readonly ArtifactKind[] = ['document', 'code', 'data'];

export function isTextArtifactKind(kind: ArtifactKind): boolean {
  return TEXT_ARTIFACT_KINDS.includes(kind);
}
