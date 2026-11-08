import { createRoute, z } from '@hono/zod-openapi';
import {
  CODING_ATTACHMENT_COUNT,
  CoderAgentSchema,
  CoderChangedFileSchema,
  CoderCommitSchema,
  CoderModeSchema,
  CoderTranscriptEventSchema,
  CoderUsageSchema,
  CodingSessionEntrySchema,
  CodingSessionStatusSchema,
} from '@openbots/shared';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import {
  continueSession,
  discardSession,
  getSession,
  listSessions,
  ownerTurn,
  sessionEntries,
  sessionLog,
  stopSession,
  terminalFor,
  toSessionView,
} from '../services/coding-sessions.js';

// Coding sessions (CA5 to CA7, CA15; I14): the owner's sessions across their
// Bots, one session, its transcript and full log, where Open terminal opens,
// the owner's own next prompt, and Stop, Continue and Discard. The last
// three act through the session's widget, so the card in the chat and these
// answers agree. Another owner's session is 404.

const CodingSessionSchema = z
  .object({
    id: z.uuid(),
    botId: z.uuid(),
    title: z.string().openapi({ description: "The session's name, from its first prompt" }),
    runId: z.uuid().nullable().openapi({
      description: "The Bot's run the session reports to; null on the owner's own turn",
    }),
    chatId: z.uuid().nullable(),
    messageId: z.uuid().nullable(),
    partIndex: z.number().int().nullable(),
    agent: CoderAgentSchema,
    repoId: z.uuid().nullable(),
    repoFullName: z.string().nullable(),
    branch: z.string().nullable(),
    base: z.string().nullable(),
    mode: CoderModeSchema,
    status: CodingSessionStatusSchema,
    pushAllowed: z.boolean(),
    vendorSessionId: z.string().nullable(),
    usage: CoderUsageSchema.describe('Tokens, cost and billing').openapi('CoderUsage').nullable(),
    summary: z.string().nullable(),
    changedFiles: z.array(
      CoderChangedFileSchema.describe('A changed file').openapi('CoderChangedFile'),
    ),
    commits: z.array(CoderCommitSchema.describe('A commit').openapi('CoderCommit')),
    prUrl: z.string().nullable(),
    diffArtifactId: z.uuid().nullable().openapi({
      description:
        'The Artifact holding `git diff <base>...HEAD` once the session settled with commits (View diff); Discard leaves it',
    }),
    error: z.string().nullable(),
    worktreePath: z.string().nullable(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('CodingSession');

const CodingSessionEntryApiSchema = CodingSessionEntrySchema.extend({
  event: CoderTranscriptEventSchema.describe(
    "A prompt the session was given (`by` says whether the Bot or the owner sent it), or one of the agent's events. An `approval_request` entry's `request_id` is the approval's id.",
  ).openapi('CoderTranscriptEvent'),
})
  .describe('One entry of a session transcript')
  .openapi('CodingSessionEntry');

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const idParam = z.object({ id: z.uuid() });
const sessionBody = json(z.object({ session: CodingSessionSchema }), 'The session');
const notFoundProblem = { 404: problemResponse('No such session') };
const conflict = problemResponse(
  'The session already ended (`SESSION_ENDED`), is still running (`SESSION_RUNNING`), or its Bot runs another (`CODER_BUSY`)',
);
const promptBody = (name: string) => ({
  content: {
    'application/json': {
      schema: z.strictObject({ prompt: z.string().trim().min(1).max(4_000) }).openapi(name),
    },
  },
  required: true,
});

export const codingSessionRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/coding-sessions',
      tags: ['coders'],
      summary: "The owner's coding sessions, newest first",
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        query: z.object({
          botId: z.uuid().optional(),
          status: CodingSessionStatusSchema.optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: {
        200: json(z.object({ sessions: z.array(CodingSessionSchema) }), 'The sessions'),
        ...authProblems,
      },
    }),
    async (c) => {
      const rows = await listSessions(c.var.deps, c.var.user, c.req.valid('query'));
      return c.json({ sessions: rows.map(toSessionView) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/coding-sessions/{id}/events',
      tags: ['coders'],
      summary: "The session's transcript, in order",
      description:
        'The entries after `after` (a `seq`), at most `limit`. Page on with the last `seq` while `hasMore`; `coding_session.events` brings the next ones live.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: idParam,
        query: z.object({
          after: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
      },
      responses: {
        200: json(
          z
            .object({ entries: z.array(CodingSessionEntryApiSchema), hasMore: z.boolean() })
            .openapi('CodingSessionEntries'),
          'The entries',
        ),
        ...authProblems,
        ...notFoundProblem,
      },
    }),
    async (c) => {
      const page = await sessionEntries(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('query'),
      );
      return c.json(page, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/coding-sessions/{id}',
      tags: ['coders'],
      summary: 'One coding session',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: idParam },
      responses: { 200: sessionBody, ...authProblems, ...notFoundProblem },
    }),
    async (c) => {
      const row = await getSession(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json({ session: toSessionView(row) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/coding-sessions/{id}/log',
      tags: ['coders'],
      summary: "The session's full event log",
      description:
        'Its last 2 MB, empty before the session wrote any. Kept on the server, so it reads while the computer is off.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: idParam },
      responses: {
        200: { description: 'The log', content: { 'text/plain': { schema: z.string() } } },
        ...authProblems,
        ...notFoundProblem,
      },
    }),
    async (c) => {
      const text = await sessionLog(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.text(text, 200, { 'cache-control': 'private, no-store' });
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/coding-sessions/{id}/terminal',
      tags: ['coders'],
      summary: 'Where Open terminal opens: the worktree, as coder, with the resume command',
      description:
        'Pass `cwd`, `user` and `preset` to `/api/v1/computer/pty` as query parameters; the proxy checks `cwd` against your sessions again.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: idParam },
      responses: {
        200: json(
          z
            .object({
              cwd: z.string(),
              user: z.literal('coder'),
              preset: z.string().openapi({ description: 'Typed into the terminal, not run' }),
            })
            .openapi('CodingSessionTerminal'),
          'The terminal',
        ),
        ...authProblems,
        ...notFoundProblem,
        409: problemResponse('The session has no worktree (`NO_WORKTREE`)'),
      },
    }),
    async (c) => c.json(await terminalFor(c.var.deps, c.var.user, c.req.valid('param').id), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/coding-sessions/{id}/stop',
      tags: ['coders'],
      summary: 'Stop a session',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: idParam },
      responses: { 200: sessionBody, ...authProblems, ...notFoundProblem, 409: conflict },
    }),
    async (c) => {
      const row = await stopSession(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json({ session: toSessionView(row) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/coding-sessions/{id}/continue',
      tags: ['coders'],
      summary: 'Continue an ended session with another prompt',
      description:
        "Posts the prompt as your message in the session's chat (in its widget's thread), so the Bot continues the session with `code_task` from a run of its own. The session is returned as it is; it reopens when the Bot's run starts it.",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: idParam, body: promptBody('CodingSessionContinue') },
      responses: { 200: sessionBody, ...authProblems, ...notFoundProblem, 409: conflict },
    }),
    async (c) => {
      const row = await continueSession(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('json').prompt,
      );
      return c.json({ session: toSessionView(row) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/coding-sessions/{id}/turns',
      tags: ['coders'],
      summary: 'Send the agent your own next prompt',
      description:
        "Reopens an ended session with your prompt, straight to its agent: no Bot run is involved, so the session has no run (`runId` null) and refuses what needs one (an approval, the pull request's push). Its chat card follows, and the prompt is the next turn of its transcript.",
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: idParam,
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z
                .strictObject({
                  prompt: z.string().trim().min(1).max(4_000),
                  attachments: z.array(z.uuid()).max(CODING_ATTACHMENT_COUNT).optional(),
                })
                .openapi('CodingSessionTurn'),
            },
          },
        },
      },
      responses: {
        200: sessionBody,
        ...authProblems,
        403: problemResponse(
          'Coding agents are off for the Bot (`CODER_DISABLED`), or it may not work on the repository any more (`REPO_NOT_ALLOWED`)',
        ),
        ...notFoundProblem,
        409: problemResponse(
          'The session is still running (`SESSION_RUNNING`), its Bot runs another (`CODER_BUSY`), its repository was forgotten (`REPO_FORGOTTEN`), or its agent is not signed in (`NEEDS_LOGIN`)',
        ),
      },
    }),
    async (c) => {
      const row = await ownerTurn(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('json').prompt,
        c.req.valid('json').attachments,
      );
      return c.json({ session: toSessionView(row) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/coding-sessions/{id}/discard',
      tags: ['coders'],
      summary: "Remove an ended session's worktree and local branch from the computer",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: idParam },
      responses: { 200: sessionBody, ...authProblems, ...notFoundProblem, 409: conflict },
    }),
    async (c) => {
      const row = await discardSession(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json({ session: toSessionView(row) }, 200);
    },
  );
