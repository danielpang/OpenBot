import { z } from 'zod';
import { defineWidget } from './types.js';

// A system event notification (plan 12.2, W3): Routine ran, computer started,
// connector needs login, run blocked. Read only. The compact transcript row
// itself is the `event` message part; this kind is the same content as a card.
// Only the system posts it, so a Bot cannot pass prose off as a system notice.

export const EventPropsSchema = z.strictObject({
  /** `blocked`, `routine_ran`, `computer_started`, `connector_login`, ... */
  event: z.string().min(1).max(64),
  text: z.string().min(1).max(2_000),
  /** A follow-up the owner can take, e.g. "Choose a model with tool calling in Settings". */
  fix: z.string().max(500).optional(),
});

export const eventWidget = defineWidget({
  kind: 'event',
  description: 'A one-line notice that something happened',
  props: EventPropsSchema,
  botEmits: false,
});
