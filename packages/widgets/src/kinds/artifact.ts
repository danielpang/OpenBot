import { ArtifactKindSchema } from '@openbots/shared';
import { z } from 'zod';
import { defineWidget } from './types.js';

// An Artifact card (plan 12.1, 12.2, A2): title, kind and version, with open
// (the viewer in the right panel) and download (`GET /api/v1/artifacts/{id}/
// download?version=`). Both happen in the client, so the kind has no actions.
// The artifact tools post the same fields as an `artifact` message part.

export const ArtifactPropsSchema = z.strictObject({
  artifact_id: z.string().min(1),
  title: z.string().min(1).max(200),
  kind: ArtifactKindSchema,
  /** The version the card shows; open and download use it, absent means current. */
  version: z.number().int().positive().optional(),
});

export const artifactWidget = defineWidget({
  kind: 'artifact',
  description: 'A card for an Artifact, with open and download',
  props: ArtifactPropsSchema,
  // Posted by create_artifact and update_artifact, never invented by the model.
  botEmits: false,
});
