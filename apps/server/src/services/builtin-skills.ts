import { BUILTIN_SKILLS } from '@openbots/agent';
import { skillSummary } from '@openbots/shared';
import type { CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';

// The built-in Skills (CA12): "Working in a repository", for now. Each is
// seeded into the owner's library when they make a Bot on an install with a
// computer (where `code_task` exists), inside the Bot's own transaction, and
// like any Skill is on for all of the owner's Bots. A built-in is an ordinary
// `manual` Skill the owner can edit or delete; its `origin` says it was
// built in (`{ kind: 'builtin', slug }`), and its library slug is the
// built-in's own. One the owner already has (by that slug) is never added
// twice; one they deleted comes back with their next Bot.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;

/** Adds the built-in Skills the owner's library lacks. */
export async function seedBuiltinSkills(tx: Db, owner: Owner): Promise<void> {
  if (!BUILTIN_SKILLS.length) return;
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
}
