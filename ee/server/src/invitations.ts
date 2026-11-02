import { and, eq, gt } from 'drizzle-orm';
import { schema, type Db } from '@openbots/server/db/client';
import { asDirectory } from '@openbots/server/db/scope';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The invitation a sign-up brings, when it is pending, unexpired and for that address. */
export async function invitationProof(db: Db, email: string, invite: unknown) {
  if (typeof invite !== 'string' || !UUID.test(invite)) return null;
  // Before the account is in its organization: the directory's to say (db/scope.ts).
  const [row] = await asDirectory(() =>
    db
      .select({
        id: schema.invites.id,
        workspaceId: schema.invites.workspaceId,
        role: schema.invites.role,
      })
      .from(schema.invites)
      .where(
        and(
          eq(schema.invites.id, invite),
          eq(schema.invites.email, email.toLowerCase()),
          eq(schema.invites.status, 'pending'),
          gt(schema.invites.expiresAt, new Date()),
        ),
      ),
  );
  return row ?? null;
}
