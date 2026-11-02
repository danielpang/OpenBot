import { z } from 'zod';

// Bot profile values stored in `bots` jsonb columns (plan 4.1). The server,
// the avatars package and the web app read the same shapes. Keys inside these
// values are snake_case, as the plan writes them, because they are stored
// as-is; the Bot object around them is camelCase like the rest of the API.

/** A Bot's handle without the `@`: lowercase letters, digits, `-` and `_`. */
export const HANDLE_MAX_LENGTH = 32;
export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

export const BotHandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/^@/, ''))
  .pipe(
    z
      .string()
      .min(1)
      .max(HANDLE_MAX_LENGTH)
      .regex(
        HANDLE_PATTERN,
        'A handle uses lowercase letters, digits, - and _, and starts and ends with a letter or digit',
      ),
  );

/**
 * A handle made from a Bot's name: "Ada Lovelace!" becomes `ada-lovelace`.
 * Falls back to `bot` when the name has nothing usable.
 */
export function handleFromName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, HANDLE_MAX_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug || 'bot';
}

/**
 * `base` with `suffix` appended, trimmed so the result still fits:
 * `withHandleSuffix('ada', 'copy')` is `ada-copy`.
 */
export function withHandleSuffix(base: string, suffix: string): string {
  const tail = `-${suffix}`;
  const head = base.slice(0, HANDLE_MAX_LENGTH - tail.length).replace(/[-_]+$/, '');
  return `${head || 'bot'}${tail}`;
}

/** Generator params (`packages/avatars`) or an uploaded image (I1). */
export const AvatarSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('generated'),
    seed: z.string().min(1).max(128),
    shape: z.string().max(64).optional(),
    palette: z.string().max(64).optional(),
    eyes: z.string().max(64).optional(),
    accessory: z.string().max(64).optional(),
  }),
  z.object({ kind: z.literal('upload'), file_id: z.uuid() }),
]);

export type Avatar = z.infer<typeof AvatarSchema>;

/** Which model a Bot runs on (L1 to L5); `provider_id` is a `providers.id`. */
export const ModelConfigSchema = z.object({
  provider_id: z.uuid(),
  model_id: z.string().min(1).max(256),
  temperature: z.number().min(0).max(2).optional(),
  reasoning: z.union([z.boolean(), z.enum(['low', 'medium', 'high'])]).optional(),
  max_steps: z.number().int().min(1).max(500).optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

// The per-Bot tool policy (`bots.tool_policy`) is `ToolPolicySchema` in policy.ts.
