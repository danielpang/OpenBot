import { withHandleSuffix } from '@openbots/shared';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '../db/client.js';

// Every Bot has an inbox (H1): `/hooks/{botHandle}`, an endpoint with no
// Routine and the slug `inbox`. It is made with the Bot (insertBot) and, for
// Bots older than that, when their endpoints are listed. Tokens are stored as
// hashes, so the inbox starts without one: ingress refuses every delivery
// until the owner generates a token (the rotate action), which is shown once.
// An event Routine's endpoint (R2, H2) is made the same way, with the Routine.

/** The slug `/hooks/{botHandle}` answers to. */
export const INBOX_SLUG = 'inbox';

/** The `token_hash` of an endpoint whose token was never generated; no token hashes to it. */
export const NO_TOKEN = 'none';

export const hasToken = (endpoint: { tokenHash: string }) => endpoint.tokenHash !== NO_TOKEN;

/** Creates the Bot's inbox unless it has one; safe to repeat. */
export async function ensureInbox(db: Db, bot: { workspaceId: string; botId: string }) {
  await db
    .insert(schema.webhookEndpoints)
    .values({
      workspaceId: bot.workspaceId,
      botId: bot.botId,
      slug: INBOX_SLUG,
      tokenHash: NO_TOKEN,
    })
    .onConflictDoNothing();
}

/**
 * Creates an event Routine's endpoint (R2, H2) without a token, as the inbox
 * starts: it refuses deliveries until the owner generates one. Its slug is
 * the Routine's, or the next free one when another endpoint of the Bot has
 * it. Returns the endpoint's id and slug.
 */
export async function insertRoutineEndpoint(
  db: Db,
  routine: { id: string; botId: string; workspaceId: string; slug: string },
): Promise<{ id: string; slug: string }> {
  const taken = new Set(
    (
      await db
        .select({ slug: schema.webhookEndpoints.slug })
        .from(schema.webhookEndpoints)
        .where(eq(schema.webhookEndpoints.botId, routine.botId))
    ).map((e) => e.slug),
  );
  let slug = routine.slug;
  for (let n = 2; taken.has(slug); n++) slug = withHandleSuffix(routine.slug, String(n));
  const [row] = await db
    .insert(schema.webhookEndpoints)
    .values({
      workspaceId: routine.workspaceId,
      botId: routine.botId,
      routineId: routine.id,
      slug,
      tokenHash: NO_TOKEN,
    })
    .returning({ id: schema.webhookEndpoints.id, slug: schema.webhookEndpoints.slug });
  return row!;
}
