import { and, desc, eq, gte, like, lt, lte, sql } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { effectiveSettings } from '../workspace.js';

// The audit log (plan 17 control 9, S-11), one per organization (plan
// 21.3). Services write one row per security-relevant action: sign-in and
// sign-out, keys, invitations, members' roles and suspension, settings,
// providers, connectors, webhooks, approvals and the computer. On the
// managed service an organization's owners and admins read it through the
// managed build's route; rows older than the organization's
// `auditRetentionDays` (default 180) are trimmed by the workers.

export type AuditActorType = 'user' | 'bot' | 'system';

export interface AuditActor {
  type: AuditActorType;
  id: string | null;
}

export interface AuditRecord {
  workspaceId: string;
  actor: AuditActor;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export type AuditRow = typeof schema.auditLog.$inferSelect;

/** How often the workers trim rows past the retention period. */
export const AUDIT_TRIM_MS = 60 * 60 * 1000;

export const userActor = (user: Pick<CurrentUser, 'id'>): AuditActor => ({
  type: 'user',
  id: user.id,
});

export const SYSTEM_ACTOR: AuditActor = { type: 'system', id: null };

export async function recordAudit(db: Db, entry: AuditRecord): Promise<void> {
  await db.insert(schema.auditLog).values({
    workspaceId: entry.workspaceId,
    actorType: entry.actor.type,
    actorId: entry.actor.id,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata ?? {},
  });
}

export interface AuditFilter {
  actorId?: string;
  /** An action name, or a group prefix ending in `.` (`auth.`). */
  action?: string;
  from?: Date;
  to?: Date;
  /** The id of the last row of the previous page. */
  cursor?: string;
  limit?: number;
}

export interface AuditListing {
  items: (AuditRow & { actorLabel: string | null })[];
  nextCursor: string | null;
}

/** The workspace's audit rows, newest first, `limit` at a time. */
export async function listAudit(
  db: Db,
  workspaceId: string,
  { actorId, action, from, to, cursor, limit = 50 }: AuditFilter = {},
): Promise<AuditListing> {
  const log = schema.auditLog;
  const rows = await db
    .select({
      entry: log,
      userEmail: schema.users.email,
      botName: schema.bots.name,
    })
    .from(log)
    .leftJoin(schema.users, and(eq(log.actorType, 'user'), eq(schema.users.id, log.actorId)))
    .leftJoin(schema.bots, and(eq(log.actorType, 'bot'), eq(schema.bots.id, log.actorId)))
    .where(
      and(
        eq(log.workspaceId, workspaceId),
        actorId ? eq(log.actorId, actorId) : undefined,
        action
          ? action.endsWith('.')
            ? like(log.action, `${action.replace(/[\\%_]/g, '\\$&')}%`)
            : eq(log.action, action)
          : undefined,
        from ? gte(log.createdAt, from) : undefined,
        to ? lte(log.createdAt, to) : undefined,
        // Keyset on (created_at, id), read from the cursor row so the
        // database's microseconds are compared, not a rounded timestamp.
        cursor
          ? sql`(${log.createdAt}, ${log.id}) < (select created_at, id from audit_log where id = ${cursor})`
          : undefined,
      ),
    )
    .orderBy(desc(log.createdAt), desc(log.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({ ...r.entry, actorLabel: r.userEmail ?? r.botName ?? null })),
    nextCursor: rows.length > limit ? page[page.length - 1]!.entry.id : null,
  };
}

/** Deletes rows older than each workspace's retention period; returns how many. */
export async function trimAuditLog(
  deps: Pick<AppDeps, 'config' | 'db'>,
  now = new Date(),
): Promise<number> {
  const workspaces = await deps.db.select().from(schema.workspaces);
  let trimmed = 0;
  for (const workspace of workspaces) {
    const days = effectiveSettings(deps.config, workspace, null).auditRetentionDays;
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const deleted = await deps.db
      .delete(schema.auditLog)
      .where(
        and(eq(schema.auditLog.workspaceId, workspace.id), lt(schema.auditLog.createdAt, cutoff)),
      )
      .returning({ id: schema.auditLog.id });
    trimmed += deleted.length;
  }
  return trimmed;
}
