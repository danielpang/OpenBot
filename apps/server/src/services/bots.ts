import { randomUUID } from 'node:crypto';
import { newBotAvatar } from '@openbots/avatars';
import {
  EventTriggerSchema,
  handleFromName,
  withHandleSuffix,
  type Avatar,
  type ModelConfig,
  type ToolPolicy,
} from '@openbots/shared';
import { and, asc, count, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { ensureInbox } from '../hooks/inbox.js';
import { assertBotOwner } from '../ownership.js';
import { seedBuiltinSkills } from './builtin-skills.js';
import { computerAvailable } from './computer.js';
import { assertBotModel } from './providers.js';
import type { Config } from '../config.js';
import { organizationSettings, raiseLimitHint } from '../workspace.js';
import { avatarFileStatus, invalidAvatar } from './files.js';
import { announceMessage, storeMessage } from './messages.js';

// Bots and the roster (B1 to B5, B7, B8). A Bot always comes with its one
// transcript (a `bot_dm` chat, B4) and its `bot_state` row. Every function
// here is owner-scoped within the active organization (plan 21.3): another
// user's Bot, or the caller's own in another organization, is not found.
// Handles, the main Bot and the roster limit are per (organization, owner).
//
// A new Bot is only a name and an avatar. It speaks first: its transcript
// opens with its own message asking what to work on (`greeting`), written
// with the Bot and costing no model call, and the owner's answer is how it
// learns its job.

/** The owner's roster lock key: one roster per (organization, owner). */
const rosterLock = (owner: Owner) => `bots:${owner.workspaceId}:${owner.id}`;

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type BotsDeps = Pick<AppDeps, 'db' | 'config' | 'infra' | 'logger'>;

export type BotRow = typeof schema.bots.$inferSelect;
export type BotStateRow = typeof schema.botState.$inferSelect;

export interface BotRecord {
  bot: BotRow;
  state: BotStateRow;
  chatId: string;
}

export interface BotInput {
  handle?: string;
  name: string;
  label?: string | null;
  description?: string;
  avatar?: Avatar;
  modelConfig?: ModelConfig | null;
  toolPolicy?: ToolPolicy;
}

export type BotPatch = Partial<BotInput> & {
  /** Make it the owner's main Bot (K8), or stop it being that. */
  isMain?: boolean;
};

export const botLimitReached = (limit: number, config: Pick<Config, 'deployment'>) =>
  new DomainError(
    409,
    'BOT_LIMIT_REACHED',
    `You have reached the limit of ${limit} Bots. Delete or hide one, or ${raiseLimitHint(config)}.`,
  );

export const handleTaken = (handle: string) =>
  new DomainError(409, 'HANDLE_TAKEN', `The handle @${handle} is already taken`);

/** Each Bot with its state and its transcript's id. */
function selectRecords(db: Db) {
  return db
    .select({ bot: schema.bots, state: schema.botState, chatId: schema.chats.id })
    .from(schema.bots)
    .innerJoin(schema.botState, eq(schema.botState.botId, schema.bots.id))
    .innerJoin(
      schema.chats,
      and(
        eq(schema.chats.botId, schema.bots.id),
        eq(schema.chats.type, 'bot_dm'),
        eq(schema.chats.ownerId, schema.bots.ownerId),
      ),
    );
}

export function listBots(db: Db, owner: Owner): Promise<BotRecord[]> {
  return (
    selectRecords(db)
      .where(and(eq(schema.bots.ownerId, owner.id), eq(schema.bots.workspaceId, owner.workspaceId)))
      // Pinned Bots stay at the top (B1).
      .orderBy(desc(schema.bots.pinned), asc(schema.bots.createdAt), asc(schema.bots.id))
  );
}

export async function getBot(db: Db, owner: Owner, botId: string): Promise<BotRecord> {
  await assertBotOwner(db, owner, botId);
  const [row] = await selectRecords(db).where(eq(schema.bots.id, botId));
  if (!row) throw notFound('Bot not found');
  return row;
}

/** The first message in a new Bot's transcript, from the Bot. */
export const greeting = (name: string) => `Hi, I'm ${name}. What would you like me to work on?`;

/** A new Bot with its transcript, which opens with the Bot's greeting. */
export async function createBot(deps: BotsDeps, owner: Owner, input: BotInput): Promise<BotRecord> {
  await assertOwnRefs(deps.db, owner, input);
  if (input.modelConfig) await assertBotModel(deps.db, input.modelConfig);
  const { botId, hello } = await deps.db.transaction(async (tx) => {
    await reserveSlot(deps, tx, owner);
    const handle = input.handle
      ? await assertHandleFree(tx, owner, input.handle)
      : await freeHandle(tx, owner, handleFromName(input.name));
    const bot = await insertBot(tx, owner, {
      handle,
      name: input.name,
      label: input.label ?? null,
      description: input.description ?? '',
      // One of the Bot shapes (Moon, Box, Egg), pinned, like New picks.
      avatar: input.avatar ?? newBotAvatar(randomUUID()),
      modelConfig: input.modelConfig ?? {},
      toolPolicy: input.toolPolicy ?? {},
    });
    await audit(tx, owner, 'bot.create', bot.id, { handle, name: bot.name });
    // "Working in a repository" (CA12), enabled for it, where Bots can code:
    // `code_task` is offered only on an install with a computer.
    if (computerAvailable(deps as AppDeps)) await seedBuiltinSkills(tx, owner, bot.id);
    return { botId: bot.id, hello: await storeGreeting(tx, owner, bot) };
  });
  await announceMessage(deps, hello);
  return getBot(deps.db, owner, botId);
}

export async function updateBot(
  db: Db,
  owner: Owner,
  botId: string,
  patch: BotPatch,
): Promise<BotRecord> {
  await assertBotOwner(db, owner, botId);
  await assertOwnRefs(db, owner, patch);
  if (patch.modelConfig) {
    const [current] = await db
      .select({ modelConfig: schema.bots.modelConfig })
      .from(schema.bots)
      .where(eq(schema.bots.id, botId));
    await assertBotModel(db, patch.modelConfig, current?.modelConfig);
  }
  await db.transaction(async (tx) => {
    const set: Partial<typeof schema.bots.$inferInsert> = {};
    if (patch.handle !== undefined)
      set.handle = await assertHandleFree(tx, owner, patch.handle, botId);
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.label !== undefined) set.label = patch.label;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.avatar !== undefined) set.avatar = patch.avatar;
    if (patch.modelConfig !== undefined) set.modelConfig = patch.modelConfig ?? {};
    if (patch.toolPolicy !== undefined) set.toolPolicy = patch.toolPolicy;
    if (patch.isMain !== undefined) {
      if (patch.isMain) await clearMain(tx, owner, botId);
      set.isMain = patch.isMain;
    }
    if (Object.keys(set).length) {
      await tx.update(schema.bots).set(set).where(eq(schema.bots.id, botId));
    }
  });
  return getBot(db, owner, botId);
}

/**
 * K8: an owner has one main Bot at most (a partial unique index). Before
 * another becomes it, the current one stops being it, in the same
 * transaction and under the owner's roster lock, so two at once still
 * leave one.
 */
async function clearMain(tx: Db, owner: Owner, exceptBotId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${rosterLock(owner)}))`);
  await tx
    .update(schema.bots)
    .set({ isMain: false })
    .where(
      and(
        eq(schema.bots.ownerId, owner.id),
        eq(schema.bots.workspaceId, owner.workspaceId),
        eq(schema.bots.isMain, true),
        ne(schema.bots.id, exceptBotId),
      ),
    );
}

/** The owner's main Bot (K8) in an organization, if they have one. */
export async function mainBotOf(db: Db, owner: Owner): Promise<BotRow | null> {
  const [row] = await db
    .select()
    .from(schema.bots)
    .where(
      and(
        eq(schema.bots.ownerId, owner.id),
        eq(schema.bots.workspaceId, owner.workspaceId),
        eq(schema.bots.isMain, true),
      ),
    );
  return row ?? null;
}

/**
 * 404 unless an uploaded avatar is the owner's file (S-18 G1) and the model's
 * provider is one they may use: instance-level or their own (G2). 400 unless
 * the avatar is a raster image (PNG, JPEG, WebP or GIF; never SVG).
 */
async function assertOwnRefs(db: Db, owner: Owner, input: BotPatch) {
  if (input.avatar?.kind === 'upload') {
    const status = await avatarFileStatus(db, owner, input.avatar.file_id);
    if (status === 'missing') throw notFound('File not found');
    if (status === 'not_image') throw invalidAvatar();
  }
  const providerId = input.modelConfig?.provider_id;
  if (providerId && !(await canUseProvider(db, owner, providerId))) {
    throw notFound('Provider not found');
  }
}

export async function canUseProvider(db: Db, owner: Owner, providerId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.providers.id })
    .from(schema.providers)
    .where(
      and(
        eq(schema.providers.id, providerId),
        eq(schema.providers.workspaceId, owner.workspaceId),
        or(isNull(schema.providers.ownerId), eq(schema.providers.ownerId, owner.id)),
      ),
    );
  return !!row;
}

/** Pin or unpin (B1). */
export async function setPinned(db: Db, owner: Owner, botId: string, pinned: boolean) {
  await assertBotOwner(db, owner, botId);
  await db.update(schema.bots).set({ pinned }).where(eq(schema.bots.id, botId));
  return getBot(db, owner, botId);
}

/** Hide from the sidebar without deleting (B1). */
export async function setHidden(db: Db, owner: Owner, botId: string, hidden: boolean) {
  await assertBotOwner(db, owner, botId);
  await db.update(schema.bots).set({ hidden }).where(eq(schema.bots.id, botId));
  return getBot(db, owner, botId);
}

/**
 * B7: the profile, its transcript and every message in it, Bot to Bot chats,
 * Routines, memories, runs, state and per-Bot settings go with it (all by
 * foreign-key cascade); group memberships are removed here. Artifacts and
 * files outlive the Bot.
 */
export async function deleteBot(db: Db, owner: Owner, botId: string): Promise<void> {
  await assertBotOwner(db, owner, botId);
  await db.transaction(async (tx) => {
    const [bot] = await tx.delete(schema.bots).where(eq(schema.bots.id, botId)).returning();
    await tx
      .delete(schema.chatMembers)
      .where(and(eq(schema.chatMembers.memberType, 'bot'), eq(schema.chatMembers.memberId, botId)));
    await audit(tx, owner, 'bot.delete', botId, { handle: bot!.handle, name: bot!.name });
  });
}

/**
 * B5: a new Bot with the same profile, settings, avatar, model, tool policy,
 * per-Bot connector settings, enabled Skills and Routines. Conversation
 * history, memories and attachments are not copied. Nor are webhook
 * endpoints: the copy gets its own inbox, and its event Routines start
 * without an endpoint until the owner adds one. Like any new Bot, the copy
 * opens its transcript with its greeting.
 */
export async function duplicateBot(
  deps: BotsDeps,
  owner: Owner,
  botId: string,
): Promise<BotRecord> {
  const source = await getBot(deps.db, owner, botId);
  const { copyId, hello } = await deps.db.transaction(async (tx) => {
    await reserveSlot(deps, tx, owner);
    const { bot } = source;
    const handle = await freeHandle(tx, owner, withHandleSuffix(bot.handle, 'copy'));
    const copy = await insertBot(tx, owner, {
      handle,
      name: `${bot.name} copy`,
      label: bot.label,
      description: bot.description,
      avatar: bot.avatar,
      modelConfig: bot.modelConfig,
      toolPolicy: bot.toolPolicy,
    });

    const skills = await tx
      .select()
      .from(schema.botSkills)
      .where(and(eq(schema.botSkills.botId, bot.id), eq(schema.botSkills.enabled, true)));
    if (skills.length) {
      await tx.insert(schema.botSkills).values(
        skills.map((s) => ({
          workspaceId: s.workspaceId,
          botId: copy.id,
          skillId: s.skillId,
          enabled: true,
        })),
      );
    }

    const connectors = await tx
      .select()
      .from(schema.botConnectors)
      .where(eq(schema.botConnectors.botId, bot.id));
    if (connectors.length) {
      await tx.insert(schema.botConnectors).values(
        connectors.map((c) => ({
          workspaceId: c.workspaceId,
          botId: copy.id,
          connectorId: c.connectorId,
          toolAllowlist: c.toolAllowlist,
          toolDenylist: c.toolDenylist,
          approvalOverride: c.approvalOverride,
        })),
      );
    }

    const routines = await tx
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.botId, bot.id));
    if (routines.length) {
      await tx.insert(schema.routines).values(
        routines.map((r) => ({
          workspaceId: r.workspaceId,
          botId: copy.id,
          name: r.name,
          slug: r.slug,
          trigger: withoutEndpoint(r.trigger),
          promptMd: r.promptMd,
          skillId: r.skillId,
          // A Routine posting to the source's transcript posts to the copy's.
          chatId: r.chatId === source.chatId ? copy.chatId : null,
          enabled: r.enabled,
          timezone: r.timezone,
          nextRunAt: r.nextRunAt,
        })),
      );
    }

    await audit(tx, owner, 'bot.duplicate', copy.id, { sourceBotId: bot.id, handle });
    return { copyId: copy.id, hello: await storeGreeting(tx, owner, copy) };
  });
  await announceMessage(deps, hello);
  return getBot(deps.db, owner, copyId);
}

/**
 * Stores the Bot's greeting in its new transcript, inside the transaction
 * that creates the Bot; the caller announces it once that has committed.
 */
function storeGreeting(
  tx: Db,
  owner: Owner,
  bot: Pick<BotRow, 'id' | 'name'> & { chatId: string },
) {
  return storeMessage(
    tx,
    { id: bot.chatId, workspaceId: owner.workspaceId },
    { authorType: 'bot', authorId: bot.id, parts: [{ type: 'text', text: greeting(bot.name) }] },
  );
}

/**
 * An event trigger with its `endpoint_id` cleared. The endpoint belongs to
 * the source Bot, and ingress refuses a delivery whose Routine names another
 * endpoint, so a copy that kept it could never start.
 */
function withoutEndpoint(trigger: unknown): unknown {
  const event = EventTriggerSchema.safeParse(trigger);
  return event.success ? { ...event.data, endpoint_id: null } : trigger;
}

/**
 * Inserts a Bot with its transcript, state and inbox. Callers hold the
 * owner's roster lock (reserveSlot). K8: the Bot becomes the owner's main Bot
 * when they have none, so their first Bot is it, and so is one made after
 * the main Bot was deleted or unmarked.
 */
export async function insertBot(
  tx: Db,
  owner: Owner,
  values: Pick<
    typeof schema.bots.$inferInsert,
    'handle' | 'name' | 'label' | 'description' | 'avatar' | 'modelConfig' | 'toolPolicy'
  >,
): Promise<BotRow & { chatId: string }> {
  const ids = { workspaceId: owner.workspaceId, ownerId: owner.id };
  const isMain = !(await mainBotOf(tx, owner));
  let bot: BotRow;
  try {
    [bot] = (await tx
      .insert(schema.bots)
      .values({ ...ids, ...values, isMain })
      .returning()) as [BotRow];
  } catch (error) {
    if (isUniqueViolation(error)) throw handleTaken(values.handle);
    throw error;
  }
  const [chat] = await tx
    .insert(schema.chats)
    .values({ ...ids, type: 'bot_dm', botId: bot.id })
    .returning({ id: schema.chats.id });
  await tx
    .insert(schema.botState)
    .values({ workspaceId: owner.workspaceId, botId: bot.id, state: 'idle' });
  await ensureInbox(tx, { workspaceId: owner.workspaceId, botId: bot.id });
  return { ...bot, chatId: chat!.id };
}

/**
 * Takes the owner's roster lock for the transaction and fails when the Bot
 * limit (B8, admin-overridable) is reached.
 */
export async function reserveSlot(deps: BotsDeps, tx: Db, owner: Owner) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${rosterLock(owner)}))`);
  const { limits } = await organizationSettings({ ...deps, db: tx }, owner.workspaceId);
  const [row] = await tx
    .select({ n: count() })
    .from(schema.bots)
    .where(and(eq(schema.bots.ownerId, owner.id), eq(schema.bots.workspaceId, owner.workspaceId)));
  if ((row?.n ?? 0) >= limits.botsPerAccount)
    throw botLimitReached(limits.botsPerAccount, deps.config);
}

async function assertHandleFree(tx: Db, owner: Owner, handle: string, exceptBotId?: string) {
  const [taken] = await tx
    .select({ id: schema.bots.id })
    .from(schema.bots)
    .where(
      and(
        eq(schema.bots.workspaceId, owner.workspaceId),
        eq(schema.bots.ownerId, owner.id),
        eq(schema.bots.handle, handle),
      ),
    );
  if (taken && taken.id !== exceptBotId) throw handleTaken(handle);
  return handle;
}

/** `base`, or `base-2`, `base-3`, ... whichever is free in the owner's roster. */
export async function freeHandle(tx: Db, owner: Owner, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : withHandleSuffix(base, String(n));
    const [taken] = await tx
      .select({ id: schema.bots.id })
      .from(schema.bots)
      .where(
        and(
          eq(schema.bots.workspaceId, owner.workspaceId),
          eq(schema.bots.ownerId, owner.id),
          eq(schema.bots.handle, candidate),
        ),
      );
    if (!taken) return candidate;
  }
}

export async function audit(
  tx: Db,
  owner: Owner,
  action: 'bot.create' | 'bot.delete' | 'bot.duplicate',
  botId: string,
  metadata: Record<string, unknown>,
) {
  await tx.insert(schema.auditLog).values({
    workspaceId: owner.workspaceId,
    actorType: 'user',
    actorId: owner.id,
    action,
    targetType: 'bot',
    targetId: botId,
    metadata,
  });
}

function isUniqueViolation(error: unknown): boolean {
  for (let e = error; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}
