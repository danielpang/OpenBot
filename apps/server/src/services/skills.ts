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
import { and, asc, count, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { assertBotOwner } from '../ownership.js';
import type { Config } from '../config.js';
import { organizationSettings, raiseLimitHint } from '../workspace.js';
import { chatHandles, transcriptMessage } from './chats.js';
import { onWidgetAction } from './hooks.js';
import { widgetClosed } from './runs.js';

// Skills (S1 to S3; plan 4.6, 10.1). One library per account (S2): every
// Skill belongs to its owner and is shared by all of the owner's Bots, each
// of which enables the ones it may use (`bot_skills`). A new Skill (written,
// imported or saved from a run) starts enabled for every one of the owner's
// Bots; the owner turns it off per Bot, from the Bot's Settings or from the
// Skill's own list of Bots. A Skill is a name and
// markdown content. Only enabled Skills reach a Bot's index and `use_skill`,
// and only those can be referenced with `/` (a `skill_ref` part): in a group,
// a Skill enabled for any member Bot, whose content each Bot loads for that
// turn only if it has the Skill enabled.
//
// An imported Skill (skill-import.ts) also keeps its `origin`, where it came
// from; wherever it reaches a Bot it says so (`imported_from`, P2).

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type SkillsDeps = Pick<AppDeps, 'db' | 'config'>;

export type SkillRow = typeof schema.skills.$inferSelect;

export interface SkillUser {
  id: string;
  name: string;
  handle: string;
}

export interface SkillRecord {
  skill: SkillRow;
  /** The owner's Bots that have it enabled ("used by"). */
  usedBy: SkillUser[];
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

async function usedBy(db: Db, skillIds: string[]): Promise<Map<string, SkillUser[]>> {
  const out = new Map<string, SkillUser[]>();
  if (!skillIds.length) return out;
  const rows = await db
    .select({
      skillId: schema.botSkills.skillId,
      id: schema.bots.id,
      name: schema.bots.name,
      handle: schema.bots.handle,
    })
    .from(schema.botSkills)
    .innerJoin(schema.bots, eq(schema.bots.id, schema.botSkills.botId))
    .where(and(inArray(schema.botSkills.skillId, skillIds), eq(schema.botSkills.enabled, true)))
    .orderBy(asc(schema.bots.name));
  for (const { skillId, ...bot } of rows) {
    out.set(skillId, [...(out.get(skillId) ?? []), bot]);
  }
  return out;
}

async function withUsers(db: Db, rows: SkillRow[]): Promise<SkillRecord[]> {
  const users = await usedBy(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((skill) => ({ skill, usedBy: users.get(skill.id) ?? [] }));
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
  return withUsers(db, rows);
}

export async function getSkill(db: Db, owner: Owner, skillId: string): Promise<SkillRecord> {
  const [record] = await withUsers(db, [await ownedSkill(db, owner, skillId)]);
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
    await enableForAllBots(tx, owner, [row!.id]);
    return row!;
  });
  const [record] = await withUsers(deps.db, [row]);
  return record!;
}

/** Enables new Skills for every one of the owner's Bots in the organization. */
async function enableForAllBots(tx: Db, owner: Owner, skillIds: string[]): Promise<void> {
  if (!skillIds.length) return;
  const bots = await tx
    .select({ id: schema.bots.id })
    .from(schema.bots)
    .where(and(eq(schema.bots.ownerId, owner.id), eq(schema.bots.workspaceId, owner.workspaceId)));
  if (!bots.length) return;
  await tx
    .insert(schema.botSkills)
    .values(
      bots.flatMap((bot) =>
        skillIds.map((skillId) => ({ workspaceId: owner.workspaceId, botId: bot.id, skillId })),
      ),
    )
    .onConflictDoNothing();
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
    await enableForAllBots(
      tx,
      owner,
      out.map((r) => r.id),
    );
    return out;
  });
  return withUsers(deps.db, rows);
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

/** Deletes the Skill; its `bot_skills` rows cascade and Routines keep running without it. */
export async function deleteSkill(db: Db, owner: Owner, skillId: string): Promise<void> {
  await ownedSkill(db, owner, skillId);
  await db.delete(schema.skills).where(eq(schema.skills.id, skillId));
}

// Per-Bot enablement (S2)

/** The Skills the Bot has enabled, by id. */
export async function getBotSkills(db: Db, owner: Owner, botId: string): Promise<string[]> {
  await assertBotOwner(db, owner, botId);
  const rows = await db
    .select({ skillId: schema.botSkills.skillId })
    .from(schema.botSkills)
    .innerJoin(schema.skills, eq(schema.skills.id, schema.botSkills.skillId))
    .where(and(eq(schema.botSkills.botId, botId), eq(schema.botSkills.enabled, true)))
    .orderBy(asc(schema.skills.name));
  return rows.map((r) => r.skillId);
}

/** Replaces the Bot's enabled Skills with `skillIds`; an id outside the owner's library is 404. */
export async function setBotSkills(
  db: Db,
  owner: Owner,
  botId: string,
  skillIds: string[],
): Promise<string[]> {
  await replaceEnabled(db, owner, { botId, skillIds });
  return getBotSkills(db, owner, botId);
}

/**
 * Replaces the Bots that have the Skill enabled with `botIds`, from the
 * Skill's side; an id outside the owner's Bots (or Skill) is 404.
 */
export async function setSkillBots(
  db: Db,
  owner: Owner,
  skillId: string,
  botIds: string[],
): Promise<SkillRecord> {
  await replaceEnabled(db, owner, { skillId, botIds });
  return getSkill(db, owner, skillId);
}

/** One side of `bot_skills`: a Bot's enabled Skills, or the Bots a Skill is enabled for. */
type Enablement = { botId: string; skillIds: string[] } | { skillId: string; botIds: string[] };

/**
 * Replaces one side of `bot_skills` with exactly the ids given. Every id must
 * be the owner's (the fixed side's checked first), or the call is 404 and
 * nothing changes. Rows are locked (`FOR KEY SHARE`) as they are checked, so
 * a Bot or Skill deleted meanwhile waits for this transaction instead of
 * failing its inserts.
 */
async function replaceEnabled(db: Db, owner: Owner, side: Enablement): Promise<void> {
  const bySkill = 'skillId' in side;
  const botIds = bySkill ? [...new Set(side.botIds)] : [side.botId];
  const skillIds = bySkill ? [side.skillId] : [...new Set(side.skillIds)];
  await db.transaction(async (tx) => {
    const lockBots = async () => {
      if (!botIds.length) return;
      const rows = await tx
        .select({ id: schema.bots.id })
        .from(schema.bots)
        .where(
          and(
            inArray(schema.bots.id, botIds),
            eq(schema.bots.ownerId, owner.id),
            eq(schema.bots.workspaceId, owner.workspaceId),
          ),
        )
        .for('key share');
      if (rows.length !== botIds.length) throw notFound('Bot not found');
    };
    const lockSkills = async () => {
      if (!skillIds.length) return;
      const rows = await tx
        .select({ id: schema.skills.id })
        .from(schema.skills)
        .where(and(inArray(schema.skills.id, skillIds), libraryOf(owner)))
        .for('key share');
      if (rows.length !== skillIds.length) throw notFound('Skill not found');
    };
    if (bySkill) {
      await lockSkills();
      await lockBots();
    } else {
      await lockBots();
      await lockSkills();
    }

    const { botSkills } = schema;
    await tx
      .delete(botSkills)
      .where(
        bySkill
          ? and(
              eq(botSkills.skillId, side.skillId),
              ...(botIds.length ? [notInArray(botSkills.botId, botIds)] : []),
            )
          : and(
              eq(botSkills.botId, side.botId),
              ...(skillIds.length ? [notInArray(botSkills.skillId, skillIds)] : []),
            ),
      );
    const rows = botIds.flatMap((botId) =>
      skillIds.map((skillId) => ({ workspaceId: owner.workspaceId, botId, skillId })),
    );
    if (rows.length) {
      await tx
        .insert(botSkills)
        .values(rows)
        .onConflictDoUpdate({
          target: [botSkills.botId, botSkills.skillId],
          set: { enabled: true },
        });
    }
  });
}

// For runs (plan 5.3 item 4, 10.1)

/** The Bot's enabled Skills. */
async function enabledSkills(db: Db, botId: string) {
  return db
    .select({ skill: schema.skills })
    .from(schema.botSkills)
    .innerJoin(schema.skills, eq(schema.skills.id, schema.botSkills.skillId))
    .where(and(eq(schema.botSkills.botId, botId), eq(schema.botSkills.enabled, true)))
    .orderBy(asc(schema.skills.name));
}

/** The Skills index in the Bot's system prompt: each name and the first line of its content. */
export async function skillIndex(db: Db, botId: string): Promise<SkillIndexEntry[]> {
  const rows = await enabledSkills(db, botId);
  return rows.map(({ skill }) => ({ name: skill.name, summary: skill.summary }));
}

/**
 * The Skills referenced with `/` (`skill_ref` parts) in `parts` that the Bot
 * has enabled, in full (S2). A deleted Skill and a Skill only another Bot of
 * the group has enabled are skipped.
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
 * The Skill the owner references with `/` in a chat: theirs and enabled
 * for one of `botIds` (the chat's Bots).
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
  const [enabled] = botIds.length
    ? await db
        .select({ botId: schema.botSkills.botId })
        .from(schema.botSkills)
        .where(
          and(
            eq(schema.botSkills.skillId, skill.id),
            inArray(schema.botSkills.botId, botIds),
            eq(schema.botSkills.enabled, true),
          ),
        )
        .limit(1)
    : [];
  if (!enabled) {
    throw new DomainError(
      400,
      'SKILL_UNAVAILABLE',
      "Enable the Skill in the Bot's Settings before using it with /",
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
        throw new Error(`No enabled Skill named "${name}". Your Skills: ${names}`);
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
