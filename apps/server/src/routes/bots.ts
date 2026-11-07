import { createRoute, z } from '@hono/zod-openapi';
import {
  AvatarSchema,
  botModelNeeds,
  BotHandleSchema,
  BotStateKindSchema,
  ModelConfigSchema,
  ToolPolicySchema,
  type Avatar,
} from '@openbots/shared';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import {
  createBot,
  deleteBot,
  duplicateBot,
  getBot,
  listBots,
  setHidden,
  setPinned,
  updateBot,
  type BotRecord,
  type BotStateRow,
} from '../services/bots.js';
import { computerAvailable, screenOf, stopDeletedBotScreen } from '../services/computer.js';
import { defaultModelConfig } from '../services/providers.js';
import { botUsage, USAGE_DAYS, type UsageSums } from '../services/usage.js';

// Bots and the roster (B1 to B5, B7, B8; plan 14.1). Owner-scoped: another
// user's Bot answers 404. Deleting is final; the UI recommends hiding instead.

const BotStateSchema = z
  .object({
    botId: z.uuid(),
    state: BotStateKindSchema,
    currentAction: z
      .string()
      .nullable()
      .openapi({ description: 'One-line activity label shown on hover (I3)' }),
    runId: z.uuid().nullable(),
    // Always sent; optional in the schema so older clients' generated types still check.
    currentTool: z.string().nullable().optional().openapi({
      description:
        'The tool running while `working`; a computer tool shows a dot on the Preview button (I5)',
    }),
    updatedAt: z.iso.datetime(),
  })
  .openapi('BotState');

export const BotSchema = z
  .object({
    id: z.uuid(),
    handle: z.string().openapi({ description: 'The `@slug`, without the `@`' }),
    name: z.string(),
    label: z.string().nullable().openapi({ description: 'Title shown under the name' }),
    description: z.string().openapi({ description: 'Standing rules that should remain true (B3)' }),
    avatar: AvatarSchema,
    modelConfig: ModelConfigSchema.nullable().openapi({
      description: 'Null until a model is picked',
    }),
    toolPolicy: ToolPolicySchema,
    pinned: z.boolean(),
    hidden: z.boolean(),
    isMain: z.boolean().openapi({
      description:
        "The owner's main Bot, at most one (K8): other Bots' sign-in requests go to its transcript. A new Bot is it when the owner has none",
    }),
    chatId: z.uuid().openapi({ description: "The Bot's one transcript (B4)" }),
    state: BotStateSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Bot');

const profileFields = {
  handle: BotHandleSchema.optional().openapi({
    description: 'Made from the name when omitted; a leading `@` is ignored',
  }),
  label: z.string().trim().max(80).nullable().optional(),
  description: z.string().max(20_000).optional(),
  avatar: AvatarSchema.optional().openapi({
    description: 'A random generated avatar when omitted',
  }),
  modelConfig: ModelConfigSchema.nullable().optional().openapi({
    description:
      "On create, omitted gives the first usable provider's catalog default model (adaptive thinking on Anthropic); null leaves the Bot without one",
  }),
  toolPolicy: ToolPolicySchema.optional(),
};

const CreateBotSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    ...profileFields,
  })
  .openapi('CreateBot');

const UpdateBotSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80).optional(),
    ...profileFields,
    isMain: z.boolean().optional().openapi({
      description: 'Make it the main Bot, which stops any other being it, or stop it being that',
    }),
  })
  .openapi('UpdateBot');

const params = z.object({ id: z.uuid() });

const usageSums = {
  runs: z.number().int().openapi({ description: 'Runs that called a model' }),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cachedInputTokens: z.number().int(),
  steps: z.number().int().openapi({ description: 'Model calls made' }),
  costUsd: z.number().nullable().openapi({
    description: "The sum of the runs' estimates in US dollars; null when no run had one",
  }),
  unpricedRuns: z.number().int().openapi({
    description: 'Runs whose model has no pricing, which the estimate leaves out',
  }),
};

const BotUsageSchema = z
  .object({
    days: z.number().int(),
    since: z.iso.datetime().openapi({ description: 'Midnight UTC on the first day counted' }),
    totals: z.object(usageSums),
    daily: z
      .array(z.object({ date: z.string().openapi({ example: '2026-10-29' }), ...usageSums }))
      .openapi({ description: 'Days with runs, oldest first (UTC dates)' }),
    models: z
      .array(z.object({ model: z.string().nullable(), ...usageSums }))
      .openapi({ description: 'By model, most expensive first' }),
    coding: z
      .object({
        sessions: z
          .number()
          .int()
          .openapi({ description: 'Coding sessions started in the window' }),
        inputTokens: z.number().int(),
        outputTokens: z.number().int(),
        costUsd: z.number().nullable().openapi({
          description:
            'What API billed sessions reported in US dollars; null when none did. Plan sessions are left out',
        }),
        onPlanSessions: z
          .number()
          .int()
          .openapi({ description: 'Sessions billed to a plan sign-in, which cost nothing extra' }),
      })
      .openapi('BotCodingUsage'),
  })
  .openapi('BotUsage');

const toSums = (row: UsageSums): UsageSums => ({
  runs: row.runs,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cachedInputTokens: row.cachedInputTokens,
  steps: row.steps,
  costUsd: row.costUsd,
  unpricedRuns: row.unpricedRuns,
});

const iso = (date: Date) => new Date(date).toISOString();

function toBotState(row: BotStateRow): z.infer<typeof BotStateSchema> {
  return {
    botId: row.botId,
    state: row.state,
    currentAction: row.currentAction,
    runId: row.runId,
    currentTool: row.currentTool,
    updatedAt: iso(row.updatedAt),
  };
}

export function toBot({ bot, state, chatId }: BotRecord): z.infer<typeof BotSchema> {
  const avatar = AvatarSchema.safeParse(bot.avatar);
  const modelConfig = ModelConfigSchema.safeParse(bot.modelConfig);
  return {
    id: bot.id,
    handle: bot.handle,
    name: bot.name,
    label: bot.label,
    description: bot.description,
    // Rows written before a value was set fall back rather than fail the roster.
    avatar: avatar.success ? avatar.data : ({ kind: 'generated', seed: bot.id } satisfies Avatar),
    modelConfig: modelConfig.success ? modelConfig.data : null,
    toolPolicy: ToolPolicySchema.catch({}).parse(bot.toolPolicy),
    pinned: bot.pinned,
    hidden: bot.hidden,
    isMain: bot.isMain,
    chatId,
    state: toBotState(state),
    createdAt: iso(bot.createdAt),
    updatedAt: iso(bot.updatedAt),
  };
}

const botResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: BotSchema } },
});

const notFoundProblem = { 404: problemResponse('No such Bot') };

/** `POST /bots/{id}/<action>` routes that flip a roster flag and return the Bot. */
function flagRoute(action: 'pin' | 'unpin' | 'hide' | 'unhide', summary: string) {
  return createRoute({
    method: 'post',
    path: `/bots/{id}/${action}`,
    tags: ['bots'],
    summary,
    middleware: [requireUser] as const,
    security: authenticated,
    request: { params },
    responses: { 200: botResponse('The Bot'), ...notFoundProblem, ...authProblems },
  });
}

export const botRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/bots',
      tags: ['bots'],
      summary: "The caller's Bots, pinned first",
      description: 'Hidden Bots are included with `hidden: true`; the sidebar leaves them out.',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: {
          description: 'Bots, pinned first, then oldest first',
          content: { 'application/json': { schema: z.object({ items: z.array(BotSchema) }) } },
        },
        ...authProblems,
      },
    }),
    async (c) => {
      const rows = await listBots(c.var.deps.db, c.var.user);
      return c.json({ items: rows.map(toBot) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/bots',
      tags: ['bots'],
      summary: 'Create a Bot with its transcript',
      description:
        "A name and an avatar are all a Bot needs; everything else has defaults and is editable later. The transcript opens with the Bot's own message asking what to work on, also published as `message.created`.",
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: { required: true, content: { 'application/json': { schema: CreateBotSchema } } },
      },
      responses: {
        201: botResponse('The new Bot'),
        400: problemResponse(
          'Invalid request, or a model its provider does not list or has turned off (`UNKNOWN_MODEL`, `MODEL_DISABLED`)',
        ),
        404: problemResponse("An avatar file or model provider that is not the caller's"),
        409: problemResponse(
          'Bot limit reached (`BOT_LIMIT_REACHED`) or handle taken (`HANDLE_TAKEN`)',
        ),
        ...authProblems,
      },
    }),
    async (c) => {
      const { deps, user } = c.var;
      const body = c.req.valid('json');
      // Without a model the Bot gets the default one (plan 3); null keeps it without.
      const modelConfig =
        body.modelConfig !== undefined
          ? body.modelConfig
          : await defaultModelConfig(
              deps.db,
              user,
              botModelNeeds(body.toolPolicy, computerAvailable(deps)),
            );
      const record = await createBot(deps, user, { ...body, modelConfig });
      return c.json(toBot(record), 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/bots/{id}',
      tags: ['bots'],
      summary: 'One Bot',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: { 200: botResponse('The Bot'), ...notFoundProblem, ...authProblems },
    }),
    async (c) => {
      const record = await getBot(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.json(toBot(record), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/bots/{id}',
      tags: ['bots'],
      summary: "Edit a Bot's profile and settings",
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params,
        body: { required: true, content: { 'application/json': { schema: UpdateBotSchema } } },
      },
      responses: {
        200: botResponse('The updated Bot'),
        400: problemResponse(
          'Invalid request, or a new model its provider does not list or has turned off (`UNKNOWN_MODEL`, `MODEL_DISABLED`)',
        ),
        409: problemResponse('Handle taken (`HANDLE_TAKEN`)'),
        404: problemResponse(
          "No such Bot, or an avatar file or model provider that is not the caller's",
        ),
        ...authProblems,
      },
    }),
    async (c) => {
      const { db } = c.var.deps;
      const record = await updateBot(db, c.var.user, c.req.valid('param').id, c.req.valid('json'));
      return c.json(toBot(record), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/bots/{id}',
      tags: ['bots'],
      summary: 'Delete a Bot with its transcript, Routines and memories',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: { 204: { description: 'Deleted' }, ...notFoundProblem, ...authProblems },
    }),
    async (c) => {
      const { deps, user } = c.var;
      const id = c.req.valid('param').id;
      // Read first: the screen row goes with the Bot.
      const screen = await screenOf(deps, id);
      await deleteBot(deps.db, user, id);
      await stopDeletedBotScreen(deps, screen);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/bots/{id}/duplicate',
      tags: ['bots'],
      summary: 'Duplicate a Bot without its history, memories or attachments',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        201: botResponse('The copy'),
        409: problemResponse('Bot limit reached (`BOT_LIMIT_REACHED`)'),
        ...notFoundProblem,
        ...authProblems,
      },
    }),
    async (c) => {
      const record = await duplicateBot(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json(toBot(record), 201);
    },
  )
  .openapi(flagRoute('pin', 'Pin a Bot to the top of the sidebar'), async (c) => {
    const record = await setPinned(c.var.deps.db, c.var.user, c.req.valid('param').id, true);
    return c.json(toBot(record), 200);
  })
  .openapi(flagRoute('unpin', 'Unpin a Bot'), async (c) => {
    const record = await setPinned(c.var.deps.db, c.var.user, c.req.valid('param').id, false);
    return c.json(toBot(record), 200);
  })
  .openapi(flagRoute('hide', 'Hide a Bot from the sidebar without deleting it'), async (c) => {
    const record = await setHidden(c.var.deps.db, c.var.user, c.req.valid('param').id, true);
    return c.json(toBot(record), 200);
  })
  .openapi(flagRoute('unhide', 'Show a hidden Bot in the sidebar again'), async (c) => {
    const record = await setHidden(c.var.deps.db, c.var.user, c.req.valid('param').id, false);
    return c.json(toBot(record), 200);
  })
  .openapi(
    createRoute({
      method: 'get',
      path: '/bots/{id}/state',
      tags: ['bots'],
      summary: "A Bot's roster state and current action",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: {
          description: 'The state; `bot.state` events carry the same fields',
          content: { 'application/json': { schema: BotStateSchema } },
        },
        ...notFoundProblem,
        ...authProblems,
      },
    }),
    async (c) => {
      const { state } = await getBot(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.json(toBotState(state), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/bots/{id}/usage',
      tags: ['bots'],
      summary: "A Bot's tokens and estimated cost over recent days (plan 5.8)",
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params,
        query: z.object({
          days: z.coerce
            .number()
            .int()
            .min(1)
            .max(USAGE_DAYS.max)
            .default(USAGE_DAYS.default)
            .openapi({ description: 'Days counted, today included (UTC)' }),
        }),
      },
      responses: {
        200: {
          description: 'Totals, by day and by model',
          content: { 'application/json': { schema: BotUsageSchema } },
        },
        ...notFoundProblem,
        ...authProblems,
      },
    }),
    async (c) => {
      const usage = await botUsage(
        c.var.deps.db,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('query').days,
      );
      return c.json(
        {
          days: usage.days,
          since: iso(usage.since),
          totals: toSums(usage.totals),
          daily: usage.daily.map((d) => ({ date: d.date, ...toSums(d) })),
          models: usage.models.map((m) => ({ model: m.model, ...toSums(m) })),
          coding: usage.coding,
        },
        200,
      );
    },
  );
