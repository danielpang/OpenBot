import { createRoute, z } from '@hono/zod-openapi';
import { AgentError, computerPath } from '@openbots/computer';
import { ComputerStatusSchema, ScreenStatusSchema } from '@openbots/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../context.js';
import { DomainError, notFound } from '../errors.js';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import {
  agentFor,
  computerAvailable,
  getComputer,
  IDLE_TIMEOUT_RANGE_MIN,
  listScreens,
  restartComputer,
  runningComputer,
  setScreenControl,
  startComputer,
  stopComputer,
  updateComputerSettings,
  wakeComputer,
  type ComputerRow,
  type ScreenRow,
} from '../services/computer.js';
import { fileTooLarge, uploadLimit } from '../services/files.js';

// The account's computer (plan 9, 14.1; K1, K3, K7): its status, start,
// stop and restart, a background wake (the Mac app's launch; plan 9.5), the
// owner's idle settings (always on, idle timeout; plan 4.5, 9.5), the file
// browser over /home/bot (list, download, upload; K7) and taking a Bot's
// screen over or handing it back (K3). The terminal and the
// screen view are WebSockets proxied in ws/computer.ts. File routes never
// start the computer: while it is off they answer 409 `COMPUTER_OFF`, and the
// web UI offers Start.

const ScreenSchema = z
  .object({
    id: z.uuid(),
    botId: z.uuid(),
    display: z.number().int().openapi({ description: 'The X display, `:10` and up' }),
    status: ScreenStatusSchema,
    controlledByUserId: z.uuid().nullable().openapi({
      description: 'Set while the owner has taken the screen over; the Bot waits',
    }),
    controlledSince: z.iso.datetime().nullable(),
  })
  .openapi('Screen');

const ComputerSchema = z
  .object({
    id: z.uuid(),
    provider: z.enum(['docker', 'remote']),
    status: ComputerStatusSchema,
    alwaysOn: z.boolean(),
    idleTimeoutMin: z.number().int().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    screens: z.array(ScreenSchema),
  })
  .openapi('Computer');

const ComputerStateSchema = z
  .object({
    available: z.boolean().openapi({ description: 'This install has a computer provider' }),
    computer: ComputerSchema.nullable().openapi({ description: 'Null until first use' }),
  })
  .openapi('ComputerState');

const DirEntrySchema = z
  .object({
    name: z.string(),
    type: z.enum(['file', 'dir', 'symlink', 'other']),
    size: z.number().int(),
    mtime: z.string(),
  })
  .openapi('ComputerDirEntry');

const DirListingSchema = z
  .object({ path: z.string(), entries: z.array(DirEntrySchema) })
  .openapi('ComputerDirListing');

const iso = (date: Date | null) => (date ? new Date(date).toISOString() : null);

function toScreen(row: ScreenRow): z.infer<typeof ScreenSchema> {
  return {
    id: row.id,
    botId: row.botId,
    display: row.displayNumber,
    status: ScreenStatusSchema.catch('stopped').parse(row.status),
    controlledByUserId: row.controlledByUserId,
    controlledSince: iso(row.controlledSince),
  };
}

function toComputer(row: ComputerRow, screens: ScreenRow[]): z.infer<typeof ComputerSchema> {
  return {
    id: row.id,
    provider: row.provider,
    status: ComputerStatusSchema.catch('error').parse(row.status),
    alwaysOn: row.alwaysOn,
    idleTimeoutMin: row.idleTimeoutMin,
    lastUsedAt: iso(row.lastUsedAt),
    createdAt: iso(row.createdAt)!,
    screens: screens.map(toScreen),
  };
}

async function computerOut(c: Context<AppEnv>, row: ComputerRow) {
  return toComputer(row, await listScreens(c.var.deps, row.id));
}

/** The agent for the caller's computer, which must be running (`COMPUTER_OFF` otherwise). */
async function agentOf(c: Context<AppEnv>) {
  return agentFor(c.var.deps, await runningComputer(c.var.deps, c.var.user));
}

/** Paths in the file browser are under /home/bot (K7). */
function homePath(raw: string) {
  try {
    return computerPath(raw || '~', { withinHome: true });
  } catch (error) {
    throw new DomainError(400, 'INVALID_PATH', (error as Error).message);
  }
}

/** Agent errors as problems: a missing file is a 404, the rest a 502. */
function agentProblem(error: unknown): never {
  if (error instanceof AgentError) {
    if (error.status === 404) throw notFound(error.message);
    if (error.status === 400 || error.status === 403) {
      throw new DomainError(400, 'INVALID_PATH', error.message);
    }
    if (error.status === 409) throw new DomainError(409, error.code ?? 'CONFLICT', error.message);
    throw new DomainError(502, 'COMPUTER_ERROR', error.message);
  }
  throw error;
}

const FILES_PREFIX = '/computer/files/';

/** The path after `/computer/files/`, relative to /home/bot, each segment unescaped. */
function wildcardPath(c: Context<AppEnv>) {
  const at = c.req.path.indexOf(FILES_PREFIX);
  const rest = c.req.path.slice(at + FILES_PREFIX.length);
  return homePath(rest.split('/').map(decodeURIComponent).join('/'));
}

const uploadBody: MiddlewareHandler<AppEnv> = async (c, next) => {
  const limit = await uploadLimit(c.var.deps, c.var.user.workspaceId);
  return bodyLimit({
    maxSize: limit,
    onError: () => {
      throw fileTooLarge(limit);
    },
  })(c, next);
};

const computerResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ComputerSchema } },
});
const unavailable = problemResponse(
  'No computer provider, or the computer could not start (`COMPUTER_UNAVAILABLE`)',
);

export const computerRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/computer',
      tags: ['computer'],
      summary: "The account's computer and its Bots' screens",
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: {
          description: 'Whether there is a computer, and its state',
          content: { 'application/json': { schema: ComputerStateSchema } },
        },
        ...authProblems,
      },
    }),
    async (c) => {
      const row = await getComputer(c.var.deps, c.var.user);
      return c.json(
        {
          available: computerAvailable(c.var.deps),
          computer: row ? await computerOut(c, row) : null,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/computer',
      tags: ['computer'],
      summary: 'Keep the computer on, or set how long it idles before it stops',
      description:
        'The idle sweep stops a computer unused for `idleTimeoutMin` minutes unless `alwaysOn`; its files are kept (plan 9.5). The next sweep applies a change.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z
                .strictObject({
                  alwaysOn: z.boolean().optional(),
                  idleTimeoutMin: z
                    .number()
                    .int()
                    .min(IDLE_TIMEOUT_RANGE_MIN.min)
                    .max(IDLE_TIMEOUT_RANGE_MIN.max)
                    .optional()
                    .openapi({ description: 'Minutes unused before it stops, 5 to 1440' }),
                })
                .openapi('ComputerSettings'),
            },
          },
          required: true,
        },
      },
      responses: {
        200: computerResponse('Saved'),
        ...authProblems,
        404: problemResponse('The account has no computer yet'),
      },
    }),
    async (c) => {
      const row = await getComputer(c.var.deps, c.var.user);
      if (!row) throw notFound('The account has no computer yet');
      const saved = await updateComputerSettings(c.var.deps, row, c.req.valid('json'));
      return c.json(await computerOut(c, saved), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/computer/start',
      tags: ['computer'],
      summary: 'Start the computer, creating it on first use',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: { 200: computerResponse('Running'), ...authProblems, 503: unavailable },
    }),
    async (c) => {
      const { computer } = await startComputer(c.var.deps, c.var.user);
      return c.json(await computerOut(c, computer), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/computer/wake',
      tags: ['computer'],
      summary: 'Start the computer in the background if it is off',
      description:
        'For the Mac app on This Mac, right after it signs the owner in: creates the computer on first use and starts it when stopped, without waiting for it. Does nothing when it is running or a start is under way, or when the install has no computer. The start reports through `computer.status`, a failure as `error`.',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        202: {
          description: 'Whether there is a computer, and its state as the wake found it',
          content: { 'application/json': { schema: ComputerStateSchema } },
        },
        ...authProblems,
      },
    }),
    async (c) => {
      const { deps, user } = c.var;
      await wakeComputer(deps, user, { create: true });
      const row = await getComputer(deps, user);
      return c.json(
        { available: computerAvailable(deps), computer: row ? await computerOut(c, row) : null },
        202,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/computer/stop',
      tags: ['computer'],
      summary: 'Stop the computer; its files are kept',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: computerResponse('Stopped'),
        ...authProblems,
        404: problemResponse('The account has no computer yet'),
        503: unavailable,
      },
    }),
    async (c) => {
      const row = await getComputer(c.var.deps, c.var.user);
      if (!row) throw notFound('The account has no computer yet');
      return c.json(await computerOut(c, await stopComputer(c.var.deps, row)), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/computer/restart',
      tags: ['computer'],
      summary: 'Stop the computer if it runs, then start it again; its files are kept',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: computerResponse('Running'),
        ...authProblems,
        404: problemResponse('The account has no computer yet'),
        503: unavailable,
      },
    }),
    async (c) => {
      const row = await getComputer(c.var.deps, c.var.user);
      if (!row) throw notFound('The account has no computer yet');
      const { computer } = await restartComputer(c.var.deps, c.var.user, row);
      return c.json(await computerOut(c, computer), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/computer/files',
      tags: ['computer'],
      summary: 'List a directory under /home/bot',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        query: z.object({
          path: z
            .string()
            .optional()
            .openapi({ description: 'Default /home/bot; relative paths are under it' }),
        }),
      },
      responses: {
        200: {
          description: 'The listing',
          content: { 'application/json': { schema: DirListingSchema } },
        },
        ...authProblems,
        400: problemResponse('A path outside /home/bot (`INVALID_PATH`)'),
        404: problemResponse('No such directory'),
        409: problemResponse(
          'The path is a file (`NOT_A_DIRECTORY`), or the computer is off (`COMPUTER_OFF`)',
        ),
        503: unavailable,
      },
    }),
    async (c) => {
      const path = homePath(c.req.valid('query').path ?? '');
      const agent = await agentOf(c);
      const listing = await agent.list(path).catch(agentProblem);
      return c.json(listing, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/bots/{id}/screen/control',
      tags: ['computer'],
      summary: "Take a Bot's screen over, or hand it back (K3)",
      description:
        'While the owner has the screen, the Bot\'s screen actions wait and then answer "The owner has the screen; wait"; handing back lets them continue. Publishes `screen.control`.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: z.object({ id: z.uuid() }),
        body: {
          content: {
            'application/json': {
              schema: z
                .strictObject({
                  action: z.enum(['take', 'release']),
                  url: z
                    .url({ protocol: /^https?$/ })
                    .max(2_000)
                    .optional()
                    .openapi({
                      description:
                        "Take only: open this page in the screen's browser first, e.g. a sign-in page (K8)",
                    }),
                })
                .openapi('ScreenControl'),
            },
          },
          required: true,
        },
      },
      responses: {
        200: {
          description: 'The screen',
          content: { 'application/json': { schema: ScreenSchema } },
        },
        ...authProblems,
        404: problemResponse('No such Bot, or (hand back) no screen yet'),
        503: unavailable,
      },
    }),
    async (c) => {
      const { action, url } = c.req.valid('json');
      const screen = await setScreenControl(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        action === 'take',
        action === 'take' ? url : undefined,
      );
      return c.json(toScreen(screen), 200);
    },
  );

// Downloads and uploads take any path under /home/bot after the prefix, which
// an OpenAPI path parameter cannot express (it stops at `/`); they are plain
// routes, documented in the registry below.
computerRoutes.get(`${FILES_PREFIX}*`, requireUser, async (c) => {
  const path = wildcardPath(c);
  const response = await (await agentOf(c)).openFile(path).catch(agentProblem);
  const name = path.split('/').at(-1) || 'file';
  return c.body(response.body ?? new Uint8Array(), 200, {
    'content-type': 'application/octet-stream',
    ...(response.headers.get('content-length')
      ? { 'content-length': response.headers.get('content-length')! }
      : {}),
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'private, no-store',
  });
});

computerRoutes.put(`${FILES_PREFIX}*`, requireUser, uploadBody, async (c) => {
  const path = wildcardPath(c);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const { size } = await (await agentOf(c)).writeFile(path, bytes).catch(agentProblem);
  return c.json({ path, size }, 200);
});

const filePath = z.object({
  path: z.string().openapi({ description: 'A path under /home/bot, slashes included' }),
});
for (const [method, summary, responses] of [
  [
    'get',
    'Download a file under /home/bot',
    {
      200: {
        description: 'The file',
        content: {
          'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) },
        },
      },
    },
  ],
  [
    'put',
    'Upload a file under /home/bot (the raw body), replacing it if it exists',
    {
      200: {
        description: 'Written',
        content: {
          'application/json': { schema: z.object({ path: z.string(), size: z.number().int() }) },
        },
      },
      413: problemResponse('Larger than the upload limit (`FILE_TOO_LARGE`)'),
    },
  ],
] as const) {
  computerRoutes.openAPIRegistry.registerPath({
    method,
    path: '/computer/files/{path}',
    tags: ['computer'],
    summary,
    security: authenticated,
    request: { params: filePath },
    responses: {
      ...responses,
      ...authProblems,
      400: problemResponse('A path outside /home/bot (`INVALID_PATH`)'),
      404: problemResponse('No such file'),
      409: problemResponse('The computer is off (`COMPUTER_OFF`); it is not started for this'),
      503: unavailable,
    },
  });
}
