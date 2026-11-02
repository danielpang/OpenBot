import { and, eq, isNull } from 'drizzle-orm';
import type { AppDeps } from './context.js';
import { schema, type Db } from './db/client.js';

// What the core does when someone's access to one organization ends (plan
// 21.6): an owner or admin suspended or removed them, or they left. The
// managed build (ee/server) changes the membership and then calls this.
// Their sessions stay, since they may belong to other organizations; a
// session working in this one stops being active there, and every API
// instance closes their realtime, terminal and screen sockets for it. Their
// other organizations are untouched.

/**
 * Whether a Bot's owner still works in its organization: a member, not
 * suspended. A Bot whose owner was suspended or removed does no work there,
 * whatever starts it (a Routine, a webhook, another Bot); its data stays.
 */
export async function ownerActive(
  db: Db,
  bot: { ownerId: string; workspaceId: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.workspaceMembers.id })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, bot.workspaceId),
        eq(schema.workspaceMembers.userId, bot.ownerId),
        isNull(schema.workspaceMembers.suspendedAt),
      ),
    );
  return row !== undefined;
}

/** The bus channel that tells API instances to close a member's sockets in one organization. */
export const MEMBERSHIP_ENDED_CHANNEL = 'openbots:membership-ended';

export interface MembershipEnded {
  userId: string;
  workspaceId: string;
}

export async function endMembershipAccess(
  deps: Pick<AppDeps, 'db' | 'infra'>,
  ended: MembershipEnded & { removed: boolean },
): Promise<void> {
  if (ended.removed) {
    await deps.db
      .update(schema.sessions)
      .set({ activeOrganizationId: null })
      .where(
        and(
          eq(schema.sessions.userId, ended.userId),
          eq(schema.sessions.activeOrganizationId, ended.workspaceId),
        ),
      );
  }
  await deps.infra.bus.publish<MembershipEnded>(MEMBERSHIP_ENDED_CHANNEL, {
    userId: ended.userId,
    workspaceId: ended.workspaceId,
  });
}
