import {
  draftSkill,
  toModelMessages,
  type ReferencedSkill,
  type SkillIndexEntry,
  type SkillServices,
} from '@openbots/agent';
import {
  SKILL_NAME_MAX,
  skillSlug,
  skillSummary,
  type MessagePart,
  type SkillSource,
} from '@openbots/shared';
import type { SkillDraftProps, SkillDraftState } from '@openbots/widgets';
import type { LanguageModel } from 'ai';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
  type AnyColumn,
} from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import type { Config } from '../config.js';
import { organizationSettings, raiseLimitHint } from '../workspace.js';
import { chatHandles, transcriptMessage } from './chats.js';
import { onWidgetAction } from './hooks.js';
import { widgetClosed } from './runs.js';

// Skills (S1 to S3; plan 4.6, 10.1). One library per account (S2): every
// Skill belongs to its owner and is on for all of the owner's Bots, present
// and future, except those the owner blocks on the Skill's page
// (`bot_skill_blocks`). A Skill is a name and markdown content. Only a
// Bot's unblocked Skills reach its index and `use_skill`, and only those can
// be referenced with `/` (a `skill_ref` part): in a group, a Skill on for
// any member Bot, whose content each Bot loads for that turn only if the
// Skill is on for it.
//
// An imported Skill (skill-import.ts) also keeps its `origin`, where it came
// from; wherever it reaches a Bot it says so (`imported_from`, P2).

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type SkillsDeps = Pick<AppDeps, 'db' | 'config'>;

export type SkillRow = typeof schema.skills.$inferSelect;

export interface SkillRecord {
  skill: SkillRow;
  /** The owner's Bots it is turned off for; it is on for every other one. */
  blockedBotIds: string[];
}

export interface SkillInput {
  name: string;
  content?: string;
}

export type SkillPatch = Partial<SkillInput>;

/** Where an imported Skill came from (S3), stored in `skills.origin`. */
export interface SkillOrigin {
  kind: 'github';
  /** The link the owner gave. */
  url: string;
  /** The Skill's file at the imported commit. */
  permalink: string;
  /** `owner/name`. */
  repo: string;
  /** The branch, tag or commit the link named, or the default branch. */
  ref: string;
  sha: string;
  /** The Skill's file in the repository. */
  path: string;
  license: string | null;
  importedAt: string;
}

/** A stored origin, or null for a Skill that was not imported. */
export function skillOrigin(value: unknown): SkillOrigin | null {
  const origin = value as Partial<SkillOrigin> | null;
  if (origin?.kind !== 'github' || typeof origin.repo !== 'string') return null;
  return origin as SkillOrigin;
}

/** A Skill as a Bot reads it in full, saying where an imported one came from. */
function readable(skill: SkillRow): ReferencedSkill {
  return {
    name: skill.name,
    content: skill.content,
    importedFrom: skillOrigin(skill.origin)?.repo ?? null,
  };
}

/** `name`, or `name (2)`, `name (3)`, ... whichever no name in `taken` (lowercased) matches. */
export function uniqueSkillName(name: string, taken: ReadonlySet<string>): string {
  const base = name.trim();
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : ` (${n})`;
    const candidate = `${base.slice(0, SKILL_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Messages the drafter reads around the finished run. */
const DRAFT_WINDOW = 20;

export const skillLimitReached = (limit: number, config: Pick<Config, 'deployment'>) =>
  new DomainError(
    409,
    'SKILL_LIMIT_REACHED',
    `Your Skills library has reached the limit of ${limit} Skills. Delete one you no longer need, or ${raiseLimitHint(config, 'the limit')}.`,
  );

/** The stored columns for a name and content. */
function written(name: string, content: string) {
  return { name, content, summary: skillSummary(content) };
}

/** The owner's library in one organization (plan 21.3). */
const libraryOf = (owner: Owner) =>
  and(eq(schema.skills.ownerId, owner.id), eq(schema.skills.workspaceId, owner.workspaceId));

/** `base`, or `base-2`, `base-3`, ... whichever is free in the owner's library. */
async function freeSlug(tx: Db, owner: Owner, base: string, except?: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const [taken] = await tx
      .select({ id: schema.skills.id })
      .from(schema.skills)
      .where(
        and(
          libraryOf(owner),
          eq(schema.skills.slug, candidate),
          ...(except ? [ne(schema.skills.id, except)] : []),
        ),
      );
    if (!taken) return candidate;
  }
}

/** The block of a Skill for a Bot (columns or a Skill id), for a left join. */
const blockOf = (skillId: AnyColumn | string, botId: AnyColumn) =>
  and(eq(schema.botSkillBlocks.skillId, skillId), eq(schema.botSkillBlocks.botId, botId));

/** Each Skill with the Bots it is turned off for, from one read of their blocks. */
async function withBlocks(db: Db, rows: SkillRow[]): Promise<SkillRecord[]> {
  const ids = rows.map((r) => r.id);
  const blocks = ids.length
    ? await db
        .select({ skillId: schema.botSkillBlocks.skillId, botId: schema.botSkillBlocks.botId })
        .from(schema.botSkillBlocks)
        .where(inArray(schema.botSkillBlocks.skillId, ids))
    : [];
  const blocked = new Map<string, string[]>();
  for (const { skillId, botId } of blocks) {
    blocked.set(skillId, [...(blocked.get(skillId) ?? []), botId]);
  }
  return rows.map((skill) => ({ skill, blockedBotIds: blocked.get(skill.id) ?? [] }));
}

async function ownedSkill(db: Db, owner: Owner, skillId: string): Promise<SkillRow> {
  const [row] = await db
    .select()
    .from(schema.skills)
    .where(
      and(
        eq(schema.skills.id, skillId),
        eq(schema.skills.ownerId, owner.id),
        eq(schema.skills.workspaceId, owner.workspaceId),
      ),
    );
  if (!row) throw notFound('Skill not found');
  return row;
}

// Library (S1, S2)

/** The owner's library, most recently changed first. */
export async function listSkills(db: Db, owner: Owner): Promise<SkillRecord[]> {
  const rows = await db
    .select()
    .from(schema.skills)
    .where(
      and(eq(schema.skills.ownerId, owner.id), eq(schema.skills.workspaceId, owner.workspaceId)),
    )
    .orderBy(desc(schema.skills.updatedAt), asc(schema.skills.name));
  return withBlocks(db, rows);
}

export async function getSkill(db: Db, owner: Owner, skillId: string): Promise<SkillRecord> {
  const [record] = await withBlocks(db, [await ownedSkill(db, owner, skillId)]);
  return record!;
}

export async function createSkill(
  deps: SkillsDeps,
  owner: Owner,
  input: SkillInput & { source?: SkillSource; createdFromRunId?: string | null },
): Promise<SkillRecord> {
  const name = input.name.trim();
  const row = await deps.db.transaction(async (tx) => {
    const { held, limit } = await lockLibrary(deps, tx, owner);
    if (held >= limit) throw skillLimitReached(limit, deps.config);
    const slug = await freeSlug(tx, owner, skillSlug(name));
    const [row] = await tx
      .insert(schema.skills)
      .values({
        workspaceId: owner.workspaceId,
        ownerId: owner.id,
        slug,
        ...written(name, input.content ?? ''),
        source: input.source ?? 'manual',
        createdFromRunId: input.createdFromRunId ?? null,
      })
      .returning();
    return row!;
  });
  // A new Skill has no blocks: it is on for every Bot.
  return { skill: row, blockedBotIds: [] };
}

/**
 * Locks the owner's library until the transaction ends, so two creates
 * cannot both take the last slot, and counts it against the limit.
 */
async function lockLibrary(deps: SkillsDeps, tx: Db, owner: Owner) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`skills:${owner.workspaceId}:${owner.id}`}))`,
  );
  const { limits } = await organizationSettings({ ...deps, db: tx }, owner.workspaceId);
  const [held] = await tx.select({ n: count() }).from(schema.skills).where(libraryOf(owner));
  return { held: held?.n ?? 0, limit: limits.skillsPerAccount };
}

export const skillImportOverLimit = (
  count: number,
  limit: number,
  room: number,
  config: Pick<Config, 'deployment'>,
) =>
  new DomainError(
    409,
    'SKILL_LIMIT_REACHED',
    room > 0
      ? `Importing ${count} Skills would pass your library's limit of ${limit}. There is room for ${room} more: pick fewer, or delete Skills you no longer need.`
      : `Your Skills library has reached the limit of ${limit} Skills. Delete one you no longer need, or ${raiseLimitHint(config, 'the limit')}.`,
  );

/** The names in the owner's library and the room left under the limit, for an import preview. */
export async function libraryRoom(
  deps: SkillsDeps,
  owner: Owner,
): Promise<{ names: string[]; room: number; limit: number }> {
  const { limits } = await organizationSettings(deps, owner.workspaceId);
  const rows = await deps.db
    .select({ name: schema.skills.name })
    .from(schema.skills)
    .where(libraryOf(owner));
  const limit = limits.skillsPerAccount;
  return { names: rows.map((r) => r.name), room: Math.max(0, limit - rows.length), limit };
}

export interface ImportedSkillInput {
  name: string;
  content: string;
  origin: SkillOrigin;
}

/**
 * Adds imported Skills, all or none (S3): the whole batch must fit
 * under the limit. A name another Skill (or an earlier one of the batch)
 * already has, in any case, gets a suffix.
 */
export async function createImportedSkills(
  deps: SkillsDeps,
  owner: Owner,
  items: ImportedSkillInput[],
): Promise<SkillRecord[]> {
  const rows = await deps.db.transaction(async (tx) => {
    const { held, limit } = await lockLibrary(deps, tx, owner);
    if (held + items.length > limit) {
      throw skillImportOverLimit(items.length, limit, Math.max(0, limit - held), deps.config);
    }
    const existing = await tx
      .select({ name: schema.skills.name })
      .from(schema.skills)
      .where(libraryOf(owner));
    const taken = new Set(existing.map((r) => r.name.toLowerCase()));
    const out: SkillRow[] = [];
    for (const item of items) {
      const name = uniqueSkillName(item.name, taken);
      taken.add(name.toLowerCase());
      const [row] = await tx
        .insert(schema.skills)
        .values({
          workspaceId: owner.workspaceId,
          ownerId: owner.id,
          slug: await freeSlug(tx, owner, skillSlug(name)),
          ...written(name, item.content),
          source: 'imported',
          origin: item.origin,
        })
        .returning();
      out.push(row!);
    }
    return out;
  });
  return rows.map((skill) => ({ skill, blockedBotIds: [] }));
}

export async function updateSkill(
  deps: SkillsDeps,
  owner: Owner,
  skillId: string,
  patch: SkillPatch,
): Promise<SkillRecord> {
  await deps.db.transaction(async (tx) => {
    const current = await ownedSkill(tx, owner, skillId);
    await writeSkill(tx, current, patch);
  });
  return getSkill(deps.db, owner, skillId);
}

/** Applies a patch to a Skill row, the slug following the name. */
async function writeSkill(tx: Db, current: SkillRow, patch: SkillPatch) {
  const name = patch.name?.trim() ?? current.name;
  const content = patch.content ?? current.content;
  const slug =
    name === current.name
      ? current.slug
      : await freeSlug(
          tx,
          { id: current.ownerId, workspaceId: current.workspaceId },
          skillSlug(name),
          current.id,
        );
  await tx
    .update(schema.skills)
    .set({
      ...written(name, content),
      slug,
      updatedAt: new Date(),
    })
    .where(eq(schema.skills.id, current.id));
}

/** Deletes the Skill; its blocks cascade and Routines keep running without it. */
export async function deleteSkill(db: Db, owner: Owner, skillId: string): Promise<void> {
  await ownedSkill(db, owner, skillId);
  await db.delete(schema.skills).where(eq(schema.skills.id, skillId));
}

// Per-Bot blocks (S2)

/**
 * Replaces the Bots the Skill is turned off for with `botIds`; every other
 * Bot of the owner's, including ones made later, has it on. An id outside
 * the owner's Skills or Bots is 404 and changes nothing. The rows are locked
 * (`FOR KEY SHARE`) as they are checked, so a Bot or Skill deleted meanwhile
 * waits for this transaction instead of failing its inserts.
 */
export async function setSkillBlocks(
  db: Db,
  owner: Owner,
  skillId: string,
  botIds: string[],
): Promise<SkillRecord> {
  const ids = [...new Set(botIds)];
  await db.transaction(async (tx) => {
    const [skill] = await tx
      .select({ id: schema.skills.id })
      .from(schema.skills)
      .where(and(eq(schema.skills.id, skillId), libraryOf(owner)))
      .for('key share');
    if (!skill) throw notFound('Skill not found');
    if (ids.length) {
      const bots = await tx
        .select({ id: schema.bots.id })
        .from(schema.bots)
        .where(
          and(
            inArray(schema.bots.id, ids),
            eq(schema.bots.ownerId, owner.id),
            eq(schema.bots.workspaceId, owner.workspaceId),
          ),
        )
        .for('key share');
      if (bots.length !== ids.length) throw notFound('Bot not found');
    }
    await tx
      .delete(schema.botSkillBlocks)
      .where(
        and(
          eq(schema.botSkillBlocks.skillId, skillId),
          ...(ids.length ? [notInArray(schema.botSkillBlocks.botId, ids)] : []),
        ),
      );
    if (ids.length) {
      await tx
        .insert(schema.botSkillBlocks)
        .values(ids.map((botId) => ({ workspaceId: owner.workspaceId, botId, skillId })))
        .onConflictDoNothing();
    }
  });
  return getSkill(db, owner, skillId);
}

// For runs (plan 5.3 item 4, 10.1)

/** The Skills on for the Bot: every one in its owner's library that does not block it. */
async function enabledSkills(db: Db, botId: string) {
  return db
    .select({ skill: schema.skills })
    .from(schema.skills)
    .innerJoin(
      schema.bots,
      and(
        eq(schema.bots.id, botId),
        eq(schema.bots.ownerId, schema.skills.ownerId),
        eq(schema.bots.workspaceId, schema.skills.workspaceId),
      ),
    )
    .leftJoin(schema.botSkillBlocks, blockOf(schema.skills.id, schema.bots.id))
    .where(isNull(schema.botSkillBlocks.id))
    .orderBy(asc(schema.skills.name));
}

/** The Skills index in the Bot's system prompt: each name and the first line of its content. */
export async function skillIndex(db: Db, botId: string): Promise<SkillIndexEntry[]> {
  const rows = await enabledSkills(db, botId);
  return rows.map(({ skill }) => ({ name: skill.name, summary: skill.summary }));
}

/**
 * The Skills referenced with `/` (`skill_ref` parts) in `parts` that are on
 * for the Bot, in full (S2). A deleted Skill and a Skill turned off for this
 * Bot (on only for another Bot of the group) are skipped.
 */
export async function referencedSkills(
  db: Db,
  botId: string,
  parts: MessagePart[],
): Promise<ReferencedSkill[]> {
  const ids = [...new Set(parts.filter((p) => p.type === 'skill_ref').map((p) => p.skill_id))];
  if (!ids.length) return [];
  const rows = (await enabledSkills(db, botId)).filter(({ skill }) => ids.includes(skill.id));
  const byId = new Map(rows.map(({ skill }) => [skill.id, skill]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [readable(row)] : [];
  });
}

/**
 * The Skill the owner references with `/` in a chat: theirs and on for one
 * of `botIds` (the chat's Bots).
 */
export async function referableSkill(
  db: Db,
  owner: Owner,
  skillId: string,
  botIds: string[],
): Promise<{ id: string; name: string }> {
  const [skill] = await db
    .select({ id: schema.skills.id, name: schema.skills.name })
    .from(schema.skills)
    .where(and(eq(schema.skills.id, skillId), libraryOf(owner)));
  if (!skill) throw notFound('Skill not found');
  const [usable] = botIds.length
    ? await db
        .select({ botId: schema.bots.id })
        .from(schema.bots)
        .leftJoin(schema.botSkillBlocks, blockOf(skill.id, schema.bots.id))
        .where(
          and(
            inArray(schema.bots.id, botIds),
            eq(schema.bots.ownerId, owner.id),
            eq(schema.bots.workspaceId, owner.workspaceId),
            isNull(schema.botSkillBlocks.id),
          ),
        )
        .limit(1)
    : [];
  if (!usable) {
    throw new DomainError(
      400,
      'SKILL_UNAVAILABLE',
      "This Skill is turned off for the Bots in this chat. Turn it on for one on the Skill's page before using it with /",
    );
  }
  return { id: skill.id, name: skill.name };
}

export interface SkillRunContext {
  run: { id: string; workspaceId: string; chatId: string | null };
  bot: { id: string; ownerId: string; handle: string };
  /** The small model that drafts with `save_skill`; null when none is configured. */
  smallModel(): Promise<LanguageModel | null>;
}

/** The Skills library behind `use_skill` and `save_skill` for one run. */
export function skillServices(deps: SkillsDeps, ctx: SkillRunContext): SkillServices {
  const owner = { id: ctx.bot.ownerId, workspaceId: ctx.run.workspaceId };
  return {
    async load(name) {
      const wanted = name.trim().toLowerCase();
      const rows = await enabledSkills(deps.db, ctx.bot.id);
      const found = rows.find(
        ({ skill }) => skill.name.toLowerCase() === wanted || skill.slug === wanted,
      );
      if (!found) {
        const names = rows.map(({ skill }) => skill.name).join(', ') || 'none';
        throw new Error(`No Skill named "${name}" is on for you. Your Skills: ${names}`);
      }
      const { content, importedFrom } = readable(found.skill);
      return {
        skill_id: found.skill.id,
        name: found.skill.name,
        content,
        ...(importedFrom ? { imported_from: importedFrom } : {}),
      };
    },
    async draft({ name, notes }) {
      const model = await ctx.smallModel();
      if (!model) {
        throw new Error(
          deps.config.deployment === 'managed'
            ? 'No small model is configured to draft Skills; ask an admin to set one'
            : 'No small model is configured to draft Skills. Set one in Settings > Models.',
        );
      }
      const source = await finishedRun(deps.db, ctx);
      const steps = await deps.db
        .select({ label: schema.runSteps.label })
        .from(schema.runSteps)
        .where(and(eq(schema.runSteps.runId, source), eq(schema.runSteps.type, 'tool_call')))
        .orderBy(asc(schema.runSteps.idx));
      const draft = await draftSkill({
        model,
        transcript: await transcriptLines(deps.db, ctx),
        steps: steps.map((s) => s.label),
        ...(name ? { name } : {}),
        ...(notes ? { notes } : {}),
      });
      const { skill } = await createSkill(deps, owner, {
        name: draft.name,
        content: draft.content,
        source: 'saved_from_run',
        createdFromRunId: source,
      });
      return { skill_id: skill.id, name: skill.name, content: skill.content };
    },
  };
}

/**
 * The run whose work is saved: the Bot's last completed run in this chat, or
 * this run when there is none (the work and the request in one run).
 */
async function finishedRun(db: Db, ctx: SkillRunContext): Promise<string> {
  if (!ctx.run.chatId) return ctx.run.id;
  const [last] = await db
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.botId, ctx.bot.id),
        eq(schema.runs.chatId, ctx.run.chatId),
        eq(schema.runs.status, 'completed'),
        ne(schema.runs.id, ctx.run.id),
      ),
    )
    .orderBy(desc(schema.runs.finishedAt))
    .limit(1);
  return last?.id ?? ctx.run.id;
}

/** The end of the chat's top level as author-prefixed lines, oldest first. */
async function transcriptLines(db: Db, ctx: SkillRunContext): Promise<string[]> {
  if (!ctx.run.chatId) return [];
  const [chat] = await db.select().from(schema.chats).where(eq(schema.chats.id, ctx.run.chatId));
  if (!chat) return [];
  const rows = (
    await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.chatId, chat.id), isNull(schema.messages.threadRootId)))
      .orderBy(desc(schema.messages.seq))
      .limit(DRAFT_WINDOW)
  ).reverse();
  const handles = await chatHandles(
    db,
    chat,
    rows.map((r) => r.authorId),
  );
  // Without a `self`, every message (the Bot's too) is one prefixed text turn.
  return toModelMessages(rows.map((r) => transcriptMessage(r, null, handles)))
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((t) => t.trim());
}

// The skill_draft widget (S3)

/**
 * Registers the `skill_draft` widget hook: each action writes the draft's
 * saved state through to its Skill, inside the action's transaction, and a
 * deleted Skill refuses the action. Call once per process (main.ts), like
 * `registerRunHooks`. Returns the unregister function.
 */
export function registerSkillHooks(): () => void {
  return onWidgetAction('skill_draft', async (_deps, tx, { message, props, state }) => {
    const [chat] = await tx
      .select({ id: schema.chats.ownerId, workspaceId: schema.chats.workspaceId })
      .from(schema.chats)
      .where(eq(schema.chats.id, message.chatId));
    const { skill_id: skillId } = props as SkillDraftProps;
    const [current] = await tx
      .select()
      .from(schema.skills)
      .where(and(eq(schema.skills.id, skillId), libraryOf(chat!)))
      .for('update');
    if (!current) throw widgetClosed('This Skill was deleted');
    const draft = state as SkillDraftState;
    await writeSkill(tx, current, {
      ...(draft.name ? { name: draft.name } : {}),
      ...(draft.content !== undefined ? { content: draft.content } : {}),
    });
  });
}
