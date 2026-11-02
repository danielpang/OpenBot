import { Widget } from '@openbots/widgets/react';
import { useArtifactCardState } from './live.js';

// An `artifact` message part in the transcript (plan 12.1, A2): the widgets
// package's card, kept current from `artifact.updated`, opening the viewer.

export interface ArtifactPartProps {
  part: { artifact_id: string; title: string; kind?: string; version?: number };
  onOpen?: (artifactId: string, version?: number) => void;
}

export function ArtifactPart({ part, onOpen }: ArtifactPartProps) {
  const live = useArtifactCardState(part.artifact_id);
  const { artifact_id, title, kind, version } = part;
  return (
    <Widget
      kind="artifact"
      props={{ artifact_id, title, kind, ...(version !== undefined ? { version } : {}) }}
      state={live}
      onOpenArtifact={onOpen}
    />
  );
}
