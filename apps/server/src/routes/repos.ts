import { createRoute, z } from '@hono/zod-openapi';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import { FoundRepoSchema, RepoRescueResultSchema } from '@openbots/shared';
import { rescueStatus } from '../services/repos-rescue.js';
import {
  addRepoByUrl,
  cloneRepo,
  forgetRepo,
  isFound,
  listFound,
  listRepos,
  patchRepo,
  rememberFound,
  rememberRepos,
  requestRescue,
  requestScan,
  updateRepo,
  type RepoWithCheckout,
} from '../services/repos.js';

// The remembered repositories (GH2 to GH6; I14, I18): added by URL or from a
// git connection's picker, remembered from a clone found on the computer,
// cloned onto the owner's computer by the runner's `checkout` jobs, rescued
// before loss, and forgotten again (the clone stays on disk unless asked).
// Another owner's repository is 404.

const RepoCheckoutSchema = z
  .object({
    state: z.string().openapi({
      description: '`cloning`, `updating`, `ready`, `behind`, `dirty`, `missing` or `error`',
    }),
    path: z.string(),
    ahead: z.number().int(),
    behind: z.number().int(),
    headSha: z.string().nullable(),
    lastFetchAt: z.iso.datetime().nullable(),
    error: z.string().nullable(),
    updatedAt: z.iso.datetime().openapi({
      description:
        'When the state last changed: a checkout `cloning` or `updating` for 30 minutes is stuck',
    }),
  })
  .openapi('RepoCheckout');

const RepoSchema = z
  .object({
    id: z.uuid(),
    fullName: z.string(),
    remoteUrl: z.string(),
    defaultBranch: z.string(),
    keepCloned: z.boolean(),
    pinned: z.boolean(),
    description: z.string().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    lastRemotePushAt: z.iso.datetime().nullable().openapi({
      description: 'The last commit on the remote default branch, from the last fetch',
    }),
    diskBytes: z.number().int().nonnegative().nullable().openapi({
      description:
        'The checkout on disk, its session worktrees included, in bytes, as the last refresh measured it; null before one did',
    }),
    found: z.boolean().openapi({
      description: 'A clone found on the computer that is not remembered yet (GH6)',
    }),
    checkout: RepoCheckoutSchema.nullable().openapi({
      description: 'On the owner computer; null until it is cloned there',
    }),
  })
  .openapi('Repo');

const iso = (date: Date | null) => date?.toISOString() ?? null;

function toRepo({ repo, checkout }: RepoWithCheckout): z.infer<typeof RepoSchema> {
  return {
    id: repo.id,
    fullName: repo.fullName,
    remoteUrl: repo.remoteUrl,
    defaultBranch: repo.defaultBranch,
    keepCloned: repo.keepCloned,
    pinned: repo.pinned,
    description: repo.description,
    lastUsedAt: iso(repo.lastUsedAt),
    lastRemotePushAt: iso(repo.lastRemotePushAt),
    diskBytes: checkout?.diskBytes ?? null,
    found: isFound(repo),
    checkout: checkout
      ? {
          state: checkout.state,
          path: checkout.path,
          ahead: checkout.ahead,
          behind: checkout.behind,
          headSha: checkout.headSha,
          lastFetchAt: iso(checkout.lastFetchAt),
          error: checkout.error,
          updatedAt: checkout.updatedAt.toISOString(),
        }
      : null,
  };
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const idParam = z.object({ id: z.uuid() });
const repoBody = json(z.object({ repo: RepoSchema }), 'The repository');
const notFoundProblem = { 404: problemResponse('No such repository') };
const noComputer = { 409: problemResponse('The account has no computer yet (`NO_COMPUTER`)') };

export const repoRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/repos',
      tags: ['repos'],
      summary: 'The remembered repositories and their state on the computer',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: json(z.object({ repos: z.array(RepoSchema) }), 'Pinned first, then by last use'),
        ...authProblems,
      },
    }),
    async (c) =>
      c.json(
        {
          repos: (await listRepos(c.var.deps, c.var.user, { includeFound: true })).map(toRepo),
        },
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/repos',
      tags: ['repos'],
      summary: 'Remember a repository by its git URL',
      description:
        'https or ssh; a GitHub remote is stored as `https://github.com/owner/name.git`. Cloned onto the computer when the account has one.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z
                .strictObject({
                  remoteUrl: z.string().trim().min(1).max(2_000),
                  fullName: z.string().trim().min(3).max(200).optional().openapi({
                    description: "The URL's own `owner/name`; another one is refused",
                  }),
                  defaultBranch: z.string().trim().min(1).max(255).optional(),
                  keepCloned: z.boolean().optional(),
                })
                .openapi('RepoInput'),
            },
          },
          required: true,
        },
      },
      responses: {
        201: repoBody,
        ...authProblems,
        400: problemResponse('Not a git URL (`INVALID_REPO_URL`)'),
        409: problemResponse('Already remembered (`REPO_EXISTS`), or too many (`REPO_LIMIT`)'),
      },
    }),
    async (c) => {
      const added = await addRepoByUrl(c.var.deps, c.var.user, c.req.valid('json'));
      return c.json({ repo: toRepo(added) }, 201);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/repos/{id}',
      tags: ['repos'],
      summary: 'Forget a repository; its clone stays on the computer unless `deleteFiles`',
      description:
        'With `deleteFiles=true` the clone is removed first, as `coder`, and only from under ~/repos.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: idParam,
        query: z.object({
          deleteFiles: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => v === 'true'),
        }),
      },
      responses: {
        200: json(
          z
            .object({
              filesDeleted: z.boolean(),
              path: z.string().nullable(),
              note: z.string(),
            })
            .openapi('RepoForgotten'),
          'Forgotten; `note` says whether the clone stays on the computer',
        ),
        ...authProblems,
        ...notFoundProblem,
        409: problemResponse(
          'The computer is off (`COMPUTER_OFF`), or the clone is outside ~/repos (`NOT_DELETABLE`) or could not be removed (`DELETE_FAILED`)',
        ),
      },
    }),
    async (c) =>
      c.json(
        await forgetRepo(c.var.deps, c.var.user, c.req.valid('param').id, {
          deleteFiles: c.req.valid('query').deleteFiles,
        }),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/repos/{id}/clone',
      tags: ['repos'],
      summary: 'Clone the repository onto the computer again',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: idParam },
      responses: { 200: repoBody, ...authProblems, ...notFoundProblem, ...noComputer },
    }),
    async (c) =>
      c.json(
        { repo: toRepo(await cloneRepo(c.var.deps, c.var.user, c.req.valid('param').id)) },
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/repos/{id}/update',
      tags: ['repos'],
      summary: 'Fetch the repository on the computer',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: idParam },
      responses: { 200: repoBody, ...authProblems, ...notFoundProblem, ...noComputer },
    }),
    async (c) =>
      c.json(
        { repo: toRepo(await updateRepo(c.var.deps, c.var.user, c.req.valid('param').id)) },
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/repos/remember',
      tags: ['repos'],
      summary: "Remember repositories picked from a git connection's list",
      description:
        'Each is cloned onto the computer in the background (GH2). One already remembered is left as it is.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z
                .strictObject({
                  fullNames: z.array(z.string().trim().min(3).max(200)).min(1).max(100),
                  connectionId: z.uuid(),
                })
                .openapi('RememberReposInput'),
            },
          },
          required: true,
        },
      },
      responses: {
        200: json(z.object({ repos: z.array(RepoSchema) }), 'Every named repository'),
        ...authProblems,
        403: problemResponse(
          "A name the connection does not list, or not the connection account's (`CONNECTION_NO_ACCESS`)",
        ),
        404: problemResponse('No such connection'),
        409: problemResponse('Too many repositories (`REPO_LIMIT`)'),
      },
    }),
    async (c) =>
      c.json(
        {
          repos: (await rememberRepos(c.var.deps, c.var.user, c.req.valid('json'))).map(toRepo),
        },
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/repos/found',
      tags: ['repos'],
      summary: 'Clones on the computer nobody remembered, from the last scan',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: json(z.object({ found: z.array(FoundRepoSchema) }), 'By path'),
        ...authProblems,
      },
    }),
    async (c) => c.json({ found: await listFound(c.var.deps, c.var.user) }, 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/repos/found/remember',
      tags: ['repos'],
      summary: 'Remember a clone found on the computer, where it is',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.strictObject({ path: z.string().min(1).max(4_096) }),
            },
          },
          required: true,
        },
      },
      responses: {
        200: repoBody,
        ...authProblems,
        404: problemResponse('No clone was found at that path'),
        409: problemResponse('Too many repositories (`REPO_LIMIT`)'),
      },
    }),
    async (c) =>
      c.json(
        {
          repo: toRepo(await rememberFound(c.var.deps, c.var.user, c.req.valid('json').path)),
        },
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/repos/rescue',
      tags: ['repos'],
      summary: 'Push unpushed work to rescue branches before the home is lost',
      description:
        'Queues rescue before loss (GH5); read the results with GET /repos/rescue/{requestId}.',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        202: json(z.object({ requestId: z.uuid() }), 'Queued'),
        ...authProblems,
      },
    }),
    async (c) => c.json(await requestRescue(c.var.deps, c.var.user), 202),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/repos/rescue/{requestId}',
      tags: ['repos'],
      summary: "A rescue's progress and results",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: z.object({ requestId: z.uuid() }) },
      responses: {
        200: json(
          z
            .object({
              status: z.enum(['running', 'done']),
              results: z.array(RepoRescueResultSchema),
            })
            .openapi('RepoRescueStatus'),
          'Results once `done`',
        ),
        ...authProblems,
        404: problemResponse('No such rescue, or it is more than ten minutes old'),
      },
    }),
    async (c) => c.json(rescueStatus(c.var.user, c.req.valid('param').requestId), 200),
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/repos/{id}',
      tags: ['repos'],
      summary: 'Turn cloning again on a new computer on or off, or pin the repository',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: idParam,
        body: {
          content: {
            'application/json': {
              schema: z
                .strictObject({
                  keepCloned: z.boolean().optional(),
                  pinned: z.boolean().optional(),
                })
                .openapi('RepoPatch'),
            },
          },
          required: true,
        },
      },
      responses: { 200: repoBody, ...authProblems, ...notFoundProblem },
    }),
    async (c) =>
      c.json(
        {
          repo: toRepo(
            await patchRepo(c.var.deps, c.var.user, c.req.valid('param').id, c.req.valid('json')),
          ),
        },
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/repos/scan',
      tags: ['repos'],
      summary: 'Look for clones on the computer nobody remembered',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        202: json(
          z.object({ queued: z.literal(true) }),
          'Queued: poll /repos/found for what it finds',
        ),
        ...authProblems,
        ...noComputer,
      },
    }),
    async (c) => {
      await requestScan(c.var.deps, c.var.user);
      return c.json({ queued: true as const }, 202);
    },
  );
