import { z } from 'zod';
import { defineWidget } from './types.js';

// A file card (plan 12.1, 12.2): opens or downloads `GET /api/v1/files/{file_id}`.
// Opening and downloading happen in the client, so the kind has no actions.

export const FilePropsSchema = z.strictObject({
  file_id: z.string().min(1),
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(255),
  size: z.number().int().nonnegative().optional(),
  description: z.string().max(500).optional(),
});

export const fileWidget = defineWidget({
  kind: 'file',
  description: 'A card for an uploaded file, with open and download',
  props: FilePropsSchema,
  botEmits: true,
});
