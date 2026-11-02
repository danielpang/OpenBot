import { createRoute, z } from '@hono/zod-openapi';
import { EVENTS_CHANNEL, RunStatusSchema, RunStepTypeSchema, type WsEvent } from '@openbots/shared';
import { streamSSE } from 'hono/streaming';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import {
  actOnWidget,
  cancelRun,
  getRunForOwner,
  listRunSteps,
  TERMINAL_STATUSES,
  toRunStep,
  type RunRow,
  type RunState,
} from '../services/runs.js';

// Runs (plan 14.1 "Runs"; I4, C3) and widget actions (plan 12.2, W2).
// Owner-scoped through the run's Bot: another user's run answers 404.

const UsageSchema = z
  .object({
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    cachedInputTokens: z.number().int(),
    steps: z.number().int().openapi({ description: 'Model calls made' }),
    costUsd: z.number().nullable().openapi({
      description: 'Estimated from the model pricing; null when the model has none (no estimate)',
    }),
  })
  .openapi('RunUsage');

const RunSchema = z
  .object({
    id: z.uuid(),
    botId: z.uuid(),
    chatId: z.uuid().nullable(),
    trigger: z.enum([
      'message',
      'mention',
      'bot_message',
      'bot_dm',
      'widget_action',
      'webhook',
      'routine',
      'resume',
    ]),
    priority: z.number().int().openapi({ description: '1 runs first (plan 5.1)' }),
    status: RunStatusSchema,
    parentRunId: z.uuid().nullable(),
    depth: z.number().int(),
    model: z.string().nullable(),
    usage: UsageSchema.nullable(),
    error: z.string().nullable(),
    waiting: z
      .object({
        reason: z.enum(['question', 'approval', 'widget']),
        label: z.string(),
        messageId: z.uuid().nullable(),
        partIndex: z.number().int().nullable(),
      })
      .nullable()
      .openapi({ description: 'What the run waits for, while `status` is `waiting`' }),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .openapi('Run');

const RunStepSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    idx: z.number().int(),
    type: RunStepTypeSchema,
    label: z.string().openapi({ description: 'The activity log line (I4)' }),
    payload: z.unknown(),
    tokensIn: z.number().int().nullable(),
    tokensOut: z.number().int().nullable(),
    durationMs: z.number().int().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('RunStep');

const WidgetStateSchema = z
  .object({
    messageId: z.uuid(),
    partIndex: z.number().int(),
    state: z.unknown(),
    pendingRunId: z.uuid().nullable(),
  })
  .openapi('WidgetState');

const WidgetActionSchema = z
  .object({
    action: z.record(z.string(), z.unknown()).openapi({
      description:
        "Validated against the widget kind's action schema, e.g. `{type: 'answer', option_id}`",
    }),
  })
  .openapi('WidgetAction');

const WidgetActionResultSchema = z
  .object({
    widget: WidgetStateSchema,
    resumedRunId: z.uuid().nullable().openapi({ description: 'The waiting run this answered' }),
    startedRunId: z.uuid().nullable().openapi({
      description: 'A `widget_action` run, when no run was waiting on the widget',
    }),
  })
  .openapi('WidgetActionResult');

const iso = (date: Date | null) => (date ? new Date(date).toISOString() : null);

export function toRun(row: RunRow): z.infer<typeof RunSchema> {
  const pending = row.status === 'waiting' ? (row.state as RunState | null)?.pending : undefined;
  return {
    id: row.id,
    botId: row.botId,
    chatId: row.chatId,
    trigger: row.trigger,
    priority: row.priority,
    status: row.status,
    parentRunId: row.parentRunId,
    depth: row.depth,
    model: row.model,
    usage: UsageSchema.nullable()
      .catch(null)
      .parse(row.usage ?? null),
    error: row.error,
    waiting: pending
      ? {
          reason: pending.reason,
          label: pending.label,
          messageId: pending.messageId ?? null,
          partIndex: pending.partIndex ?? null,
        }
      : null,
    createdAt: iso(row.createdAt)!,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
  };
}

const params = z.object({ id: z.uuid() });
const runResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: RunSchema } },
});
const notFoundRun = { 404: problemResponse('No such run') };

/** Whether a realtime event belongs to the run; message events are matched by id. */
function belongsToRun(event: WsEvent, runId: string, messageIds: Set<string>): boolean {
  switch (event.type) {
    case 'message.created':
      if (event.payload.message.runId !== runId) return false;
      messageIds.add(event.payload.message.id);
      return true;
    case 'message.delta':
    case 'message.completed':
    case 'message.deleted':
      return messageIds.has(event.payload.messageId);
    case 'run.step':
      return event.payload.step.runId === runId;
    case 'run.status':
    case 'bot.state':
      return event.payload.runId === runId;
    case 'widget.updated':
      return event.payload.widget.pendingRunId === runId;
    default:
      return false;
  }
}

export const runRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/runs/{id}',
      tags: ['runs'],
      summary: 'A run, with usage and estimated cost (plan 5.8)',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: { 200: runResponse('The run'), ...authProblems, ...notFoundRun },
    }),
    async (c) => {
      const row = await getRunForOwner(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.json(toRun(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/runs/{id}/steps',
      tags: ['runs'],
      summary: "The run's activity log, oldest first (I4)",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: {
          description: 'Steps with labels, durations and tokens',
          content: { 'application/json': { schema: z.object({ items: z.array(RunStepSchema) }) } },
        },
        ...authProblems,
        ...notFoundRun,
      },
    }),
    async (c) => {
      const rows = await listRunSteps(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.json({ items: rows.map(toRunStep) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/runs/{id}/events',
      tags: ['runs'],
      summary: "Server-sent events: the run's realtime events, ending when it finishes",
      description:
        'Each SSE `data` is a plan 14.2 event (`run.status`, `run.step`, `bot.state`, and the ' +
        "`message.*` events of the run's messages). The first event is the current `run.status`.",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: {
          description: 'An event stream',
          content: { 'text/event-stream': { schema: z.string() } },
        },
        ...authProblems,
        ...notFoundRun,
      },
    }),
    async (c) => {
      const { deps, user } = c.var;
      const run = await getRunForOwner(deps.db, user, c.req.valid('param').id);
      return streamSSE(c, async (stream) => {
        const messageIds = new Set<string>();
        let done: () => void = () => {};
        const finished = new Promise<void>((resolve) => (done = resolve));
        const queue: WsEvent[] = [];
        let wake: () => void = () => {};
        const unsubscribe = await deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (event) => {
          if (!belongsToRun(event, run.id, messageIds)) return;
          queue.push(event);
          wake();
        });
        stream.onAbort(done);
        try {
          // Read after subscribing, so nothing between the two is lost.
          const current = await getRunForOwner(deps.db, user, run.id);
          await stream.writeSSE({
            event: 'run.status',
            data: JSON.stringify({
              type: 'run.status',
              ts: Date.now(),
              bot_id: current.botId,
              payload: { runId: current.id, status: current.status, error: current.error },
            }),
          });
          let ended = TERMINAL_STATUSES.includes(current.status);
          while (!ended && !stream.aborted) {
            const next = queue.shift();
            if (!next) {
              await Promise.race([new Promise<void>((resolve) => (wake = resolve)), finished]);
              continue;
            }
            await stream.writeSSE({ event: next.type, data: JSON.stringify(next) });
            if (next.type === 'run.status' && TERMINAL_STATUSES.includes(next.payload.status)) {
              ended = true;
            }
          }
        } finally {
          await unsubscribe();
        }
      });
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/runs/{id}/cancel',
      tags: ['runs'],
      summary: 'Cancel a queued, running or waiting run (plan 5.7)',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: runResponse('The run; finished runs are returned unchanged'),
        ...authProblems,
        ...notFoundRun,
      },
    }),
    async (c) => {
      const row = await cancelRun(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json(toRun(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/messages/{id}/widgets/{part}/action',
      tags: ['chats'],
      summary: 'Act on an interactive widget (answer a question, ...)',
      description:
        'Updates the widget state. If a run is waiting on the widget it resumes with the ' +
        'answer as the tool result; otherwise the action starts a `widget_action` run.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: z.object({ id: z.uuid(), part: z.coerce.number().int().min(0) }),
        body: { content: { 'application/json': { schema: WidgetActionSchema } }, required: true },
      },
      responses: {
        200: {
          description: 'The new widget state',
          content: { 'application/json': { schema: WidgetActionResultSchema } },
        },
        400: problemResponse('The action or its values do not fit the widget (a missing field)'),
        ...authProblems,
        404: problemResponse('No such message or widget'),
        409: problemResponse('The widget no longer takes this action (already answered)'),
      },
    }),
    async (c) => {
      const { id, part } = c.req.valid('param');
      const result = await actOnWidget(
        c.var.deps,
        c.var.user,
        id,
        part,
        c.req.valid('json').action,
      );
      return c.json(result, 200);
    },
  );
