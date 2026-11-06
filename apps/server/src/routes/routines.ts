import { createRoute, z } from '@hono/zod-openapi';
import { describeTrigger } from '@openbots/routines';
import {
  CODING_ROUTINE_TEMPLATES,
  RoutineRunStatusSchema,
  RoutineTriggerInputSchema,
  REPO_FULL_NAME,
  RoutineTriggerSchema,
  type CodingRoutineTemplateId,
} from '@openbots/shared';
import { requireUser } from '../middleware/auth.js';
import { endpointUrl } from './webhooks.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import {
  createRoutine,
  createRoutineFromTemplate,
  deleteRoutine,
  getRoutineRecord,
  listRoutineRuns,
  listRoutines,
  runRoutineNow,
  updateRoutine,
  type RoutineRecord,
  type RoutineRunRow,
} from '../services/routines.js';

// Routines (plan 10.2, 14.1; R1, R3 to R5). Owner-scoped through the Bot;
// another user's Bot or Routine is 404. The trigger is stored as sent, with
// the cron derived from the schedule preset (an interval has none); `nextRunAt` is when the
// scheduler will next start it.

const TriggerSchema = RoutineTriggerSchema.describe(
  '`{type: "schedule", cron?, preset}` (no cron for `every_minutes`, an interval) or `{type: "event", source, endpoint_id?, match?}`; snake_case inside, as stored',
).openapi('RoutineTrigger');

const TriggerInputSchema = RoutineTriggerInputSchema.describe(
  'A schedule needs only its preset; the server derives the cron',
).openapi('RoutineTriggerInput');

const RoutineRunSchema = z
  .object({
    id: z.uuid(),
    routineId: z.uuid(),
    runId: z.uuid().nullable(),
    status: z.enum(RoutineRunStatusSchema.options),
    reason: z.enum(['schedule', 'run_now', 'event', 'retry']),
    slot: z.iso.datetime().nullable().openapi({
      description: 'The scheduled time a schedule run is for; null otherwise',
    }),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    resultMessageId: z.uuid().nullable().openapi({
      description: 'The "Routine ran" message in the transcript, once the run ended',
    }),
    exception: z.string().nullable(),
  })
  .openapi('RoutineRun');

const RoutineSchema = z
  .object({
    id: z.uuid(),
    botId: z.uuid(),
    name: z.string(),
    slug: z.string(),
    trigger: TriggerSchema,
    schedule: z.string().openapi({ description: 'The trigger in words, e.g. "Weekdays at 08:00"' }),
    prompt: z.string(),
    skillId: z.uuid().nullable(),
    chatId: z.uuid().nullable().openapi({ description: "Null posts into the Bot's transcript" }),
    enabled: z.boolean(),
    timezone: z.string(),
    nextRunAt: z.iso.datetime().nullable(),
    lastRunAt: z.iso.datetime().nullable(),
    lastRun: RoutineRunSchema.nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('Routine');

const name = z.string().trim().min(1).max(120);
const prompt = z.string().max(8_000);
const timezone = z.string().min(1).max(64).openapi({ description: 'IANA name; defaults to UTC' });

const TemplateIdSchema = z.enum(
  CODING_ROUTINE_TEMPLATES.map((t) => t.id) as [
    CodingRoutineTemplateId,
    ...CodingRoutineTemplateId[],
  ],
);

const FromTemplateSchema = z
  .strictObject({
    id: TemplateIdSchema,
    params: z.strictObject({
      repo: z.string().trim().regex(REPO_FULL_NAME, 'The repository as owner/name').max(200),
      label: z.string().trim().min(1).max(100).optional(),
    }),
  })
  .openapi('RoutineFromTemplate', {
    description:
      'Fills the trigger, prompt and name from a coding template (`GET /routines/templates`). The template decides them: a name, trigger or prompt sent beside it is ignored.',
  });

export const CreateRoutineSchema = z
  .strictObject({
    name: name.optional().openapi({ description: 'Required without a template' }),
    trigger: TriggerInputSchema.optional().openapi({ description: 'Required without a template' }),
    prompt: prompt.optional(),
    skillId: z.uuid().nullable().optional(),
    enabled: z.boolean().optional(),
    timezone: timezone.optional(),
    template: FromTemplateSchema.optional(),
  })
  .refine((body) => body.template || (body.name && body.trigger), {
    message: 'Send a name and a trigger, or a template',
    path: ['trigger'],
  })
  .openapi('CreateRoutine');

const TemplateSchema = z
  .object({
    id: TemplateIdSchema,
    name: z.string(),
    description: z.string(),
    trigger: z.union([
      z.object({
        type: z.literal('event'),
        source: z.literal('github'),
        event: z.enum(['label_added', 'pr_opened']),
        label: z.string().optional(),
      }),
      z.object({
        type: z.literal('schedule'),
        preset: z.literal('weekly'),
        day: z.number().int(),
        time: z.string(),
      }),
    ]),
    prompt: z
      .string()
      .openapi({ description: '`{{repo}}` and `{{label}}` are filled in on create' }),
  })
  .openapi('CodingRoutineTemplate');

const UpdateRoutineSchema = z
  .strictObject({
    name: name.optional(),
    trigger: TriggerInputSchema.optional(),
    prompt: prompt.optional(),
    skillId: z.uuid().nullable().optional(),
    enabled: z.boolean().optional(),
    timezone: timezone.optional(),
  })
  .openapi('UpdateRoutine');

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function toRoutineRun(row: RoutineRunRow): z.infer<typeof RoutineRunSchema> {
  return {
    id: row.id,
    routineId: row.routineId,
    runId: row.runId,
    status: RoutineRunStatusSchema.catch('queued').parse(row.status),
    reason: z.enum(['schedule', 'run_now', 'event', 'retry']).catch('schedule').parse(row.reason),
    slot: iso(row.slot),
    startedAt: new Date(row.startedAt).toISOString(),
    finishedAt: iso(row.finishedAt),
    resultMessageId: row.resultMessageId,
    exception: row.exception,
  };
}

function toRoutine({ routine, lastRun }: RoutineRecord): z.infer<typeof RoutineSchema> {
  const trigger = RoutineTriggerSchema.parse(routine.trigger);
  return {
    id: routine.id,
    botId: routine.botId,
    name: routine.name,
    slug: routine.slug,
    trigger,
    schedule: describeTrigger(trigger, routine.timezone),
    prompt: routine.promptMd,
    skillId: routine.skillId,
    chatId: routine.chatId,
    enabled: routine.enabled,
    timezone: routine.timezone,
    nextRunAt: iso(routine.nextRunAt),
    lastRunAt: iso(routine.lastRunAt),
    lastRun: lastRun ? toRoutineRun(lastRun) : null,
    createdAt: new Date(routine.createdAt).toISOString(),
  };
}

const params = z.object({ id: z.uuid() });
const routineResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: RoutineSchema } },
});

const CreatedRoutineSchema = RoutineSchema.extend({
  webhook: z
    .object({
      endpointId: z.uuid(),
      url: z.string().openapi({ description: 'The Payload URL to add on GitHub' }),
      token: z.string().openapi({ description: 'Shown once; the URL works with it' }),
      signingSecret: z.string().openapi({ description: 'The webhook secret to add on GitHub' }),
    })
    .optional()
    .openapi({
      description:
        'A template Routine on a repository without a GitHub App installation: the webhook the owner adds on the repository, shown once',
    }),
}).openapi('CreatedRoutine');

export const routineRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/routines/templates',
      tags: ['routines'],
      summary: 'The coding Routine templates (CA11), for `template` on create',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: {
          description: 'Templates',
          content: {
            'application/json': { schema: z.object({ templates: z.array(TemplateSchema) }) },
          },
        },
        ...authProblems,
      },
    }),
    (c) => c.json({ templates: [...CODING_ROUTINE_TEMPLATES] }, 200),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/bots/{id}/routines',
      tags: ['routines'],
      summary: "A Bot's Routines, oldest first, with their latest run",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: {
          description: 'Routines',
          content: { 'application/json': { schema: z.object({ items: z.array(RoutineSchema) }) } },
        },
        ...authProblems,
        404: problemResponse('No such Bot'),
      },
    }),
    async (c) => {
      const rows = await listRoutines(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.json({ items: rows.map(toRoutine) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/bots/{id}/routines',
      tags: ['routines'],
      summary: 'Create a Routine',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params,
        body: { content: { 'application/json': { schema: CreateRoutineSchema } }, required: true },
      },
      responses: {
        201: {
          description: 'The Routine',
          content: { 'application/json': { schema: CreatedRoutineSchema } },
        },
        400: problemResponse('INVALID_SCHEDULE, EMPTY_ROUTINE or UNKNOWN_TEMPLATE'),
        ...authProblems,
        404: problemResponse('No such Bot, Skill, or webhook endpoint of this Bot'),
        409: problemResponse('ROUTINE_LIMIT_REACHED: 50 per Bot'),
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const { template, name, trigger, ...rest } = c.req.valid('json');
      if (template) {
        // The template decides the name, trigger and prompt.
        const { prompt: _prompt, ...kept } = rest;
        const made = await createRoutineFromTemplate(c.var.deps, c.var.user, id, {
          ...kept,
          template,
        });
        const routine = toRoutine({ routine: made.routine, lastRun: null });
        if (!made.webhook) return c.json(routine, 201);
        const { endpointId, slug, token, signingSecret, bot } = made.webhook;
        // GitHub cannot set a header, so the token is the path's last segment.
        const url = `${endpointUrl(c.var.deps.config, bot, slug)}/${token}`;
        return c.json({ ...routine, webhook: { endpointId, url, token, signingSecret } }, 201);
      }
      const row = await createRoutine(c.var.deps, c.var.user, id, {
        ...rest,
        name: name!,
        trigger: trigger!,
      });
      return c.json(toRoutine({ routine: row, lastRun: null }), 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/routines/{id}',
      tags: ['routines'],
      summary: 'A Routine',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: routineResponse('The Routine'),
        ...authProblems,
        404: problemResponse('No such Routine'),
      },
    }),
    async (c) => {
      const record = await getRoutineRecord(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.json(toRoutine(record), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/routines/{id}',
      tags: ['routines'],
      summary: 'Edit, enable or pause a Routine',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params,
        body: { content: { 'application/json': { schema: UpdateRoutineSchema } }, required: true },
      },
      responses: {
        200: routineResponse('The Routine'),
        400: problemResponse('INVALID_SCHEDULE or EMPTY_ROUTINE'),
        ...authProblems,
        404: problemResponse('No such Routine, Skill, or webhook endpoint of its Bot'),
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      await updateRoutine(c.var.deps, c.var.user, id, c.req.valid('json'));
      return c.json(toRoutine(await getRoutineRecord(c.var.deps.db, c.var.user, id)), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/routines/{id}',
      tags: ['routines'],
      summary: 'Delete a Routine and its run records',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        204: { description: 'Deleted' },
        ...authProblems,
        404: problemResponse('No such Routine'),
      },
    }),
    async (c) => {
      await deleteRoutine(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/routines/{id}/run-now',
      tags: ['routines'],
      summary: 'Run a Routine now, outside its schedule',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        201: {
          description: 'The run record; the run is queued at background priority',
          content: { 'application/json': { schema: RoutineRunSchema } },
        },
        ...authProblems,
        404: problemResponse('No such Routine'),
      },
    }),
    async (c) => {
      const row = await runRoutineNow(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json(toRoutineRun(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/routines/{id}/runs',
      tags: ['routines'],
      summary: "A Routine's run records, newest first (the 20 most recent are kept)",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: {
          description: 'Run records',
          content: {
            'application/json': { schema: z.object({ items: z.array(RoutineRunSchema) }) },
          },
        },
        ...authProblems,
        404: problemResponse('No such Routine'),
      },
    }),
    async (c) => {
      const rows = await listRoutineRuns(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.json({ items: rows.map(toRoutineRun) }, 200);
    },
  );
