import { createRoute, z } from '@hono/zod-openapi';
import { ApprovalStatusSchema } from '@openbots/shared';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import { decideApproval, listPendingApprovals } from '../services/approvals.js';

// Approvals (plan 14.1 "Runs", P1). The owner decides a pending request here
// or through the approval widget's action route; both take the same path.
// Owner-scoped through the run's Bot, or the coding session's owner when there
// is no run: another user's approval answers 404.
// `GET /approvals` lists the caller's pending requests (the Mac app's tray).

const ApprovalSchema = z
  .object({
    id: z.uuid(),
    runId: z
      .uuid()
      .nullable()
      .openapi({ description: "Null for a coding session's request on the owner's own turn" }),
    messageId: z.uuid().nullable().openapi({ description: 'The message holding the widget' }),
    sessionId: z
      .uuid()
      .nullable()
      .openapi({ description: 'The coding session that asked, when one did' }),
    toolName: z.string(),
    args: z.unknown(),
    summary: z.string().openapi({ description: 'The arguments in one readable line' }),
    reason: z.string().nullable().openapi({ description: 'Why the policy asked' }),
    status: ApprovalStatusSchema,
    note: z.string().nullable().openapi({ description: "The owner's note with the decision" }),
    decidedBy: z.uuid().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('Approval');

const DecideApprovalSchema = z
  .strictObject({
    decision: z.enum(['approve', 'deny']),
    note: z.string().trim().min(1).max(2_000).optional().openapi({
      description: 'Passed to the Bot with the decision (with a denial, in the tool result)',
    }),
  })
  .openapi('DecideApproval');

const PendingApprovalSchema = ApprovalSchema.extend({
  botId: z.uuid(),
  chatId: z.uuid().nullable(),
  seq: z.number().int().nullable().openapi({ description: "The approval message's seq" }),
}).openapi('PendingApproval');

const ApprovalDecisionSchema = z
  .object({
    approval: ApprovalSchema,
    resumedRunId: z.uuid().nullable().openapi({ description: 'The run the decision resumed' }),
  })
  .openapi('ApprovalDecision');

export const approvalRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/approvals',
      tags: ['runs'],
      summary: "The caller's pending approvals",
      description:
        "Oldest first, each with its Bot, chat and message seq. Only the caller's own Bots' " +
        'requests; the Mac app loads this on every (re)connect for its tray.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        query: z.object({ status: z.enum(['pending']).default('pending') }),
      },
      responses: {
        200: {
          description: 'Pending approvals',
          content: {
            'application/json': { schema: z.object({ items: z.array(PendingApprovalSchema) }) },
          },
        },
        ...authProblems,
      },
    }),
    async (c) => {
      const items = await listPendingApprovals(c.var.deps.db, c.var.user);
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/approvals/{id}/decide',
      tags: ['runs'],
      summary: 'Approve or deny a pending tool call (P1)',
      description:
        'Approve runs the tool and the run continues with its result; deny continues with a ' +
        '"Denied by owner" result carrying the note. Replies in the approval message\'s thread ' +
        'reach the Bot with either.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: z.object({ id: z.uuid() }),
        body: { content: { 'application/json': { schema: DecideApprovalSchema } }, required: true },
      },
      responses: {
        200: {
          description: 'The decided approval',
          content: { 'application/json': { schema: ApprovalDecisionSchema } },
        },
        ...authProblems,
        404: problemResponse('No such approval'),
        409: problemResponse('The request was already decided or has expired'),
      },
    }),
    async (c) => {
      const { decision, note } = c.req.valid('json');
      const result = await decideApproval(c.var.deps, c.var.user, c.req.valid('param').id, {
        decision,
        note,
      });
      return c.json(result, 200);
    },
  );
