import { BUILTIN_SKILLS } from '@openbots/agent';
import { skillSummary } from '@openbots/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';

// The built-in Skills (CA12): "Working in a repository", for now. Each is
// seeded into the owner's library when they make a Bot on an install with a
// computer (where `code_task` exists), and enabled for that Bot, inside the
// Bot's own transaction. A built-in is an ordinary
// `manual` Skill the owner can edit or delete; its `origin` says it was
// built in (`{ kind: 'builtin', slug }`), and its library slug is the
// built-in's own. One the owner already has (by that slug) is never added
// twice; one they deleted comes back with their next Bot.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;

/** Adds the built-in Skills the owner's library lacks and enables them all for `botId`. */
export async function seedBuiltinSkills(tx: Db, owner: Owner, botId: string): Promise<void> {
  if (!BUILTIN_SKILLS.length) return;
  const slugs = BUILTIN_SKILLS.map((s) => s.slug);
  await tx
    .insert(schema.skills)
    .values(
      BUILTIN_SKILLS.map((s) => ({
        workspaceId: owner.workspaceId,
        ownerId: owner.id,
        slug: s.slug,
        name: s.name,
        content: s.content,
        summary: skillSummary(s.content),
        source: 'manual' as const,
        origin: { kind: 'builtin', slug: s.slug },
      })),
    )
    .onConflictDoNothing({
      target: [schema.skills.workspaceId, schema.skills.ownerId, schema.skills.slug],
    });
  const rows = await tx
    .select({ id: schema.skills.id })
    .from(schema.skills)
    .where(
      and(
        eq(schema.skills.ownerId, owner.id),
        eq(schema.skills.workspaceId, owner.workspaceId),
        inArray(schema.skills.slug, slugs),
      ),
    );
  if (!rows.length) return;
  await tx
    .insert(schema.botSkills)
    .values(rows.map((r) => ({ workspaceId: owner.workspaceId, botId, skillId: r.id })))
    .onConflictDoNothing();
}
