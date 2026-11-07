import { createRoute, z } from '@hono/zod-openapi';
import {
  CoderAgentSchema,
  CoderAuthKindSchema,
  CoderLoginStatusSchema,
  CoderPlanProviderSchema,
  CoderSignInStyleSchema,
} from '@openbots/shared';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import {
  cancelLogin,
  CoderLoginInTerminalError,
  getLogin,
  startLogin,
  submitLoginCode,
  type CoderLoginView,
} from '../services/coder-login.js';
import {
  checkCoderSignIn,
  listCoderAccountsForSettings,
  setCoderApiKey,
  signOutCoder,
  type CoderAccountInfo,
} from '../services/coder-accounts.js';

// Settings > Coding agents (CA2, CA3; I4, I14): one card per agent, the
// sign-in that runs the vendor's own login on the computer, an API key from
// Settings > Models instead, and signing out. Everything is the caller's
// own; another owner's sign-in answers 404. No credential is ever returned:
// the sign-in lives on the computer, under the `coder` user.

const CoderAccountSchema = z
  .object({
    agent: CoderAgentSchema,
    label: z.string().openapi({ description: 'The agent\'s name, like "Claude Code"' }),
    authKind: CoderAuthKindSchema,
    accountLabel: z
      .string()
      .nullable()
      .openapi({ description: 'The signed-in account as the agent names it: an email or plan' }),
    signedInAt: z.iso.datetime().nullable(),
    version: z.string().nullable().openapi({ description: 'The CLI on the computer' }),
    lastError: z.string().nullable(),
    providerId: z
      .uuid()
      .nullable()
      .openapi({ description: 'The provider an api_key account uses' }),
    available: z.boolean().openapi({ description: 'This build can run the agent' }),
    needsSignIn: z.boolean().openapi({
      description:
        'Never signed in, or a plan sign-in lapsed on the computer (`lastError` says so): offer Sign in again. Never for an `api_key` account.',
    }),
    lastErrorKind: z.enum(['sign_in', 'key', 'other']).nullable().openapi({
      description:
        'What `lastError` is about: a lapsed sign-in, a provider key that was refused, or something else; null without one',
    }),
    planProvider: z.enum(CoderPlanProviderSchema.options).nullable().openapi({
      description:
        'Whose plan a `subscription` account bills: `anthropic` for Claude Code, `openai` for Codex, and for pi the plan its check found (a Claude plan bills pi as extra usage, which the card says); null without a plan sign-in',
    }),
    checkAvailable: z.boolean().openapi({
      description: 'POST /coders/{agent}/check can ask the CLI whether it is signed in',
    }),
    signIn: z.enum(CoderSignInStyleSchema.options).openapi({
      description:
        "How the agent signs in: a link to open, a link and a code to enter there (`device`), or in the computer's terminal",
    }),
  })
  .openapi('CoderAccount');

const CoderLoginSchema = z
  .object({
    id: z.uuid(),
    agent: CoderAgentSchema,
    status: CoderLoginStatusSchema,
    url: z.string().nullable().openapi({ description: 'Where the owner signs in' }),
    deviceCode: z.string().nullable().openapi({ description: 'A code to enter at `url` (Codex)' }),
    accountLabel: z.string().nullable(),
    error: z.string().nullable(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .openapi('CoderLogin');

const CoderLoginInTerminalSchema = z
  .object({
    code: z.literal('CODER_LOGIN_IN_TERMINAL'),
    message: z.string(),
    terminal: z
      .object({
        cwd: z.string(),
        user: z.literal('coder'),
        preset: z.string().openapi({ description: 'Typed into the terminal, not run' }),
      })
      .openapi({
        description:
          'Open `/api/v1/computer/pty` with these as query parameters, sign in there, then `POST /coders/{agent}/check`',
      }),
  })
  .openapi('CoderLoginInTerminal');

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const agentParam = z.object({ agent: CoderAgentSchema });
const loginParams = z.object({ agent: CoderAgentSchema, loginId: z.uuid() });
const loginBody = json(z.object({ login: CoderLoginSchema }), 'The sign-in');
const accountBody = json(z.object({ account: CoderAccountSchema }), 'The agent');
const notFoundProblem = { 404: problemResponse('No such sign-in') };

const account = (info: CoderAccountInfo) => info;
const login = (view: CoderLoginView) => view;

export const coderRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/coders',
      tags: ['coders'],
      summary: 'The coding agents and how each is signed in on the computer',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: json(z.object({ agents: z.array(CoderAccountSchema) }), 'One per agent'),
        ...authProblems,
      },
    }),
    async (c) =>
      c.json(
        { agents: (await listCoderAccountsForSettings(c.var.deps, c.var.user)).map(account) },
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/coders/{agent}/login',
      tags: ['coders'],
      summary: "Start signing an agent in with the vendor's own login",
      description:
        'Runs the login on the computer (starting it if needed) and fills in `url` (and `deviceCode`) as the CLI prints them: poll `GET` until it does. A sign-in already pending for the agent is returned instead of a second one. pi signs in in its own terminal: 409 says where, then `POST /coders/pi/check`.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: agentParam },
      responses: {
        201: loginBody,
        ...authProblems,
        400: problemResponse('This build cannot run the agent (`CODER_UNSUPPORTED`)'),
        409: json(
          CoderLoginInTerminalSchema,
          'The agent signs in in a terminal on the computer (pi): open it there, then check',
        ),
      },
    }),
    async (c) => {
      const { agent } = c.req.valid('param');
      try {
        const started = await startLogin(c.var.deps, c.var.user, agent);
        return c.json({ login: login(started.login) }, 201);
      } catch (error) {
        if (!(error instanceof CoderLoginInTerminalError)) throw error;
        return c.json(
          {
            code: 'CODER_LOGIN_IN_TERMINAL' as const,
            message: error.message,
            terminal: error.terminal,
          },
          409,
        );
      }
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/coders/{agent}/login/{loginId}',
      tags: ['coders'],
      summary: 'A sign-in: its link, code and status',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: loginParams },
      responses: { 200: loginBody, ...authProblems, ...notFoundProblem },
    }),
    async (c) => {
      const { agent, loginId } = c.req.valid('param');
      return c.json({ login: await getLogin(c.var.deps, c.var.user, loginId, agent) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/coders/{agent}/login/{loginId}/code',
      tags: ['coders'],
      summary: 'Paste the code the vendor gave back into the sign-in',
      description: 'The code goes to the login on the computer and is never stored.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: loginParams,
        body: {
          content: {
            'application/json': {
              schema: z
                .strictObject({ code: z.string().trim().min(4).max(200) })
                .openapi('CoderLoginCode'),
            },
          },
          required: true,
        },
      },
      responses: {
        200: loginBody,
        ...authProblems,
        ...notFoundProblem,
        409: problemResponse('The sign-in already ended (`LOGIN_CLOSED`)'),
      },
    }),
    async (c) => {
      const { agent, loginId } = c.req.valid('param');
      const view = await submitLoginCode(
        c.var.deps,
        c.var.user,
        loginId,
        c.req.valid('json').code,
        agent,
      );
      return c.json({ login: view }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/coders/{agent}/login/{loginId}',
      tags: ['coders'],
      summary: 'Cancel a sign-in',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: loginParams },
      responses: { 204: { description: 'Cancelled' }, ...authProblems, ...notFoundProblem },
    }),
    async (c) => {
      const { agent, loginId } = c.req.valid('param');
      await cancelLogin(c.var.deps, c.var.user, loginId, 'cancelled', agent);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/coders/{agent}/check',
      tags: ['coders'],
      summary: 'Ask the CLI on the computer whether the agent is signed in',
      description:
        "Runs the agent's own status check as `coder` (Claude Code: `claude auth status`; Codex: `codex login status`; pi: `pi auth check` for each of its providers), starting the computer if needed. Signed in, the card reads `subscription` for a plan or `api_key` (with no `providerId`) for a key or token the CLI holds itself, and the sign-ins a Bot is waiting on for an agent that signs in in its terminal (pi) end signed in; not, it is left as it was.",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: agentParam },
      responses: {
        200: accountBody,
        ...authProblems,
        400: problemResponse(
          'The agent has no sign-in check (`CODER_CHECK_UNSUPPORTED`), or is not one this build runs (`CODER_UNSUPPORTED`)',
        ),
        503: problemResponse('The computer could not start (`COMPUTER_UNAVAILABLE`)'),
      },
    }),
    async (c) => {
      const { agent } = c.req.valid('param');
      return c.json({ account: await checkCoderSignIn(c.var.deps, c.var.user, agent) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'put',
      path: '/coders/{agent}/api-key',
      tags: ['coders'],
      summary: "Use a Settings > Models provider's key for the agent",
      description:
        'Claude Code takes an Anthropic key or an Anthropic compatible endpoint, Codex an OpenAI key or an OpenAI compatible endpoint, pi an Anthropic, OpenAI, Google or xAI key (`CODER_PROVIDER_KINDS`).',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: agentParam,
        body: {
          content: {
            'application/json': {
              schema: z.strictObject({ providerId: z.uuid() }).openapi('CoderApiKey'),
            },
          },
          required: true,
        },
      },
      responses: {
        200: accountBody,
        ...authProblems,
        400: problemResponse('The agent cannot use this provider (`CODER_PROVIDER_UNSUPPORTED`)'),
        404: problemResponse('No such provider'),
      },
    }),
    async (c) => {
      const { agent } = c.req.valid('param');
      const info = await setCoderApiKey(
        c.var.deps,
        c.var.user,
        agent,
        c.req.valid('json').providerId,
      );
      return c.json({ account: info }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/coders/{agent}/sign-out',
      tags: ['coders'],
      summary: 'Sign the agent out on the computer',
      description: "Empties the agent's config directory on the computer, starting it if needed.",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: agentParam },
      responses: {
        200: accountBody,
        ...authProblems,
        502: problemResponse('The computer could not sign it out (`CODER_SIGN_OUT_FAILED`)'),
        503: problemResponse('The computer could not start (`COMPUTER_UNAVAILABLE`)'),
      },
    }),
    async (c) => {
      const { agent } = c.req.valid('param');
      return c.json({ account: await signOutCoder(c.var.deps, c.var.user, agent) }, 200);
    },
  );
