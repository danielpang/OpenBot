import { createRoute, z } from '@hono/zod-openapi';
import { GitActAsSchema } from '@openbots/shared';
import type { Context } from 'hono';
import type { AppEnv, CurrentUser } from '../context.js';
import { and, eq } from 'drizzle-orm';
import { schema } from '../db/client.js';
import { asDirectory, inWorkspace } from '../db/scope.js';
import { DomainError } from '../errors.js';
import { authenticateHeaders, requireAdmin, requireUser } from '../middleware/auth.js';
import { renderOAuthPage } from '../oauth-page.js';
import { isOrgAdmin, type Role } from '../workspace.js';
import {
  adminProblems,
  authenticated,
  authProblems,
  createRouter,
  problemResponse,
} from '../openapi.js';
import {
  connectInstallation,
  createTokenConnection,
  deleteConnection,
  getConnection,
  listConnections,
  refreshRepositories,
  remoteRepos,
  setActAs,
  syncConnection,
} from '../services/git-connections.js';
import {
  consumeGithubState,
  GITHUB_LOGIN,
  githubAppFor,
  INSTALL_CALLBACK_PATH,
  signGithubState,
  verifyGithubState,
  type GithubStatePurpose,
  type VerifiedGithubState,
} from '../services/github-app.js';
import { clearGithubApp, loadGithubApp } from '../services/github-app-store.js';

// Git connections and remembered repositories, Phase 2 (GH1 to GH6, GH8;
// I17 to I19). The route table the web and server engineers agree on. Every
// path is under /api/v1 and needs a signed-in user unless it says otherwise;
// another owner's connection or repository is 404. Shapes are from
// `@openbots/shared` git.ts (`GitConnectionView`, `RemoteRepo`, `FoundRepo`,
// `RepoRescueResult`) and routes/repos.ts (`Repo`, with its checkout).
//
// Connections
//
//   GET    /git-connections
//          -> 200 { connections: GitConnectionView[] }
//
//   POST   /git-connections/token           body { token }
//          -> 201 { connection: GitConnectionView }
//          A pasted fine-grained token (kind `token`), checked with GitHub.
//
//   GET    /git-connections/github-app
//          -> 200 { configured, source: 'config' | 'instance' | null, slug, installUrlAvailable,
//                   manifestAvailable, publicUrlOk }
//          Which button the Connectors page shows. `publicUrlOk` says whether
//          OPENBOTS_PUBLIC_URL is https, which the manifest flow needs.
//
//   DELETE /git-connections/github-app
//          -> 204
//          Admins only. Forgets a stored App. 409 when it comes from GITHUB_APP_*.
//
//   POST   /git-connections/github-app/manifest   body { organization? }
//          -> 200 { url, manifest }
//          Admins only. Self-hosted only: starts GitHub's manifest flow (the client posts
//          `manifest` to `url` in a form). With `organization` (a GitHub
//          login) the App is made under that organization, so it can be
//          installed there; without, on the admin's personal account, where
//          only that account can install it (the App is private). 409 when
//          an App already exists (stored, or GITHUB_APP_* set) or the
//          deployment is managed.
//
//   GET    /git-connections/github-app/manifest/callback?code&state
//          -> 302 to the Connectors page
//          Exchanges `code` for the App and stores it sealed in
//          instance_settings (`github_app`). `state` is checked first, and
//          spent (single use); the user it names must still be an admin.
//          409 when an App exists already: nothing is overwritten.
//
//   GET    /git-connections/github-app/install
//          -> 302 to github.com/apps/<slug>/installations/new
//          The server signs the `state`. 409 when there is no App yet.
//
//   GET    /git-connections/github-app/callback?installation_id&setup_action&state&code
//          -> 302 to the Connectors page with `?connection=<id>`
//          The App requests user authorization during install, so GitHub
//          sends a `code`: exchanged for the user's token, the installation
//          is bound only when that token lists it (403 otherwise), and the
//          repositories that token reaches there, with push and admin,
//          become the connection's whole reach (H1). The token is then
//          revoked. Creates the owner's `app` connection, or updates it,
//          and lists its repositories. Other owners, here or elsewhere, may
//          connect the same installation, each held to their own access.
//          With a `reauth` state (from /reauthorize) there is no
//          `installation_id`: the connection's reach is read again.
//
//   GET    /git-connections/{id}/reauthorize
//          -> 302 to github.com/login/oauth/authorize?client_id&state&redirect_uri
//          An App connection only. The owner authorizes again, landing on the
//          install callback with a `reauth` state bound to the connection.
//
//   GET    /git-connections/{id}/repositories?q=
//          -> 200 { repositories: RemoteRepo[] }
//          Every repository the connection reaches, filtered by `q` on the
//          full name, with `remembered` set for those already in the list.
//
//   PATCH  /git-connections/{id}            body { actAs: GitActAs }
//          -> 200 { connection: GitConnectionView }
//          App connections only (400 otherwise). `owner` is 409
//          ACT_AS_NEEDS_SIGN_IN while the owner has no GitHub sign-in.
//
//   POST   /git-connections/{id}/sync
//          -> 200 { connection: GitConnectionView, needsReauthorize: boolean }
//          Lists the repositories again and refreshes status. An App
//          connection drops what the installation no longer reaches; it
//          gains nothing without the owner's own authorization, so
//          `needsReauthorize` is true for it (see /reauthorize).
//
//   DELETE /git-connections/{id}
//          -> 204
//          Forgets the connection. Its repositories keep their rows, with
//          connection_id null (the foreign key sets it).
//
// Repositories (beside the Phase 1 routes in routes/repos.ts)
//
//   POST   /repos/remember                  body { fullNames: string[], connectionId: uuid }
//          -> 200 { repos: Repo[] }
//          Bulk from the picker; each is cloned in the background (GH2).
//
//   GET    /repos/found
//          -> 200 { found: FoundRepo[] }
//          Clones on the computer nobody remembered (GH6), from the last scan.
//
//   POST   /repos/found/remember            body { path: string }
//          -> 200 { repo: Repo }
//
//   POST   /repos/rescue
//          -> 200 { results: RepoRescueResult[] }
//          Rescue before loss (GH5): pushes unpushed work to
//          `rescueBranchName(now)` where the connection allows it.
//
//   PATCH  /repos/{id}                      body { keepCloned?: boolean, pinned?: boolean }
//          -> 200 { repo: Repo }
//
//   POST   /repos/scan
//          -> 202
//          Queues a scan of /home/bot, `REPO_SCAN_DEPTH` levels deep.
//
// Webhook
//
//   POST   /api/v1/github/app/webhook       (`GITHUB_APP_WEBHOOK_PATH`)
//          -> 202
//          Unauthenticated. X-Hub-Signature-256 is checked against the App's
//          webhook secret (`GithubAppService.verifyWebhook`); a bad or missing
//          signature is 401. `installation` and `installation_repositories`
//          update connections; the rest are matched to Routines by
//          installation and repository (`GithubMatchSchema`).
//
// The two GitHub callbacks are browser redirects from github.com. Their
// `state` is signed and bound to the owner who started the flow, for 10
// minutes, and single use (services/github-app.ts). The signed-in session must be that
// owner's; on a self-hosted install, whose one owner is the only one who
// can start a flow, the state alone suffices when the browser has no
// session. A failure ends on the same small page connector sign-ins do
// (oauth-page.ts).

const GitConnectionSchema = z
  .object({
    id: z.uuid(),
    provider: z.literal('github'),
    kind: z.enum(['app', 'oauth', 'token']),
    installationId: z.string().nullable(),
    accountLogin: z.string(),
    accountType: z.enum(['user', 'organization']).nullable(),
    actAs: z.enum(['bot', 'owner']).openapi({
      description: '`bot` opens pull requests as the App, `owner` with the owner OAuth token',
    }),
    status: z.enum(['connected', 'needs_reinstall', 'revoked', 'error']),
    lastSyncedAt: z.iso.datetime({ offset: true }).nullable(),
    repoCount: z.number().int().nonnegative(),
    error: z.string().nullable(),
    repositoriesSyncedAt: z.iso.datetime({ offset: true }).nullable().optional().openapi({
      description:
        "When an App connection's reach was last read with the owner's own GitHub authorization; null when it must be authorized again",
    }),
  })
  .openapi('GitConnection');

const RemoteRepoSchema = z
  .object({
    fullName: z.string(),
    private: z.boolean(),
    defaultBranch: z.string(),
    description: z.string().nullable(),
    pushedAt: z.iso.datetime({ offset: true }).nullable(),
    remembered: z.boolean(),
  })
  .openapi('RemoteRepo');

const GithubAppStatusSchema = z
  .object({
    configured: z.boolean().openapi({ description: 'This install has a GitHub App' }),
    source: z.enum(['config', 'instance']).nullable().openapi({
      description: '`config` from GITHUB_APP_*, `instance` made through the manifest flow',
    }),
    slug: z.string().nullable(),
    installUrlAvailable: z.boolean().openapi({
      description: 'GET /git-connections/github-app/install leads somewhere',
    }),
    manifestAvailable: z.boolean().openapi({
      description:
        'POST /git-connections/github-app/manifest may make one (self-hosted, no App yet, an https public URL)',
    }),
    publicUrlOk: z.boolean().openapi({
      description:
        'OPENBOTS_PUBLIC_URL is https, which GitHub needs to reach the install; without it there is no manifest flow',
    }),
  })
  .openapi('GithubAppStatus');

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const html = (description: string) => ({
  description,
  content: { 'text/html': { schema: z.string() } },
});

const idParam = z.object({ id: z.uuid() });
const connectionBody = json(z.object({ connection: GitConnectionSchema }), 'The connection');
const notFoundProblem = { 404: problemResponse('No such connection') };
const githubProblem = { 502: problemResponse('GitHub failed or could not be reached') };

type Ctx = Context<AppEnv>;

function connectorsUrl(c: Ctx, params: Record<string, string>) {
  const target = new URL(`${c.var.deps.config.publicUrl.replace(/\/+$/, '')}/connectors`);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.toString();
}

function finishRedirect(c: Ctx, params: Record<string, string>) {
  c.header('referrer-policy', 'no-referrer');
  c.header('cache-control', 'no-store');
  return c.redirect(connectorsUrl(c, params), 302);
}

function failurePage(c: Ctx, status: 400 | 401 | 403 | 409 | 502, reason: string) {
  const page = renderOAuthPage({
    ok: false,
    name: 'GitHub',
    reason,
    connectorId: null,
    mode: null,
    publicUrl: c.var.deps.config.publicUrl,
  });
  return c.body(page.html, status, page.headers);
}

/**
 * The owner a callback's state names, checked against the browser's
 * session; a refusal is a page to show.
 */
async function callbackOwner(
  c: Ctx,
  purpose: GithubStatePurpose | readonly GithubStatePurpose[],
  state: string | undefined,
  { admin = false }: { admin?: boolean } = {},
): Promise<
  | { owner: Pick<CurrentUser, 'id' | 'workspaceId'>; state: VerifiedGithubState }
  | { refused: Response }
> {
  const deps = c.var.deps;
  const named = verifyGithubState(deps.config, purpose, state);
  if (!named) {
    return {
      refused: failurePage(c, 400, 'This link expired or was not started here. Start again.'),
    };
  }
  const viewer = await authenticateHeaders(deps, c.req.raw.headers).catch(() => null);
  if (viewer && (viewer.id !== named.userId || viewer.workspaceId !== named.workspaceId)) {
    return {
      refused: failurePage(
        c,
        403,
        'This was started by another account. Sign in as that account, or start again.',
      ),
    };
  }
  if (!viewer && deps.config.deployment !== 'self_hosted') {
    return {
      refused: failurePage(c, 401, 'Sign in to OpenBots in this browser, then try again.'),
    };
  }
  if (admin && !(await isAdminNow(c, named.userId, named.workspaceId))) {
    return { refused: failurePage(c, 403, 'Only an admin can add a GitHub App.') };
  }
  // Last, once everything else holds: the state is spent, so the link works once.
  if (!(await consumeGithubState(deps, named))) {
    return { refused: failurePage(c, 400, 'This link was used already. Start again.') };
  }
  return { owner: { id: named.userId, workspaceId: named.workspaceId }, state: named };
}

/** The user is, now, an admin (or owner) of the organization, and not suspended. */
async function isAdminNow(c: Ctx, userId: string, workspaceId: string) {
  const db = c.var.deps.db;
  const [member] = await asDirectory(() =>
    db
      .select({
        role: schema.workspaceMembers.role,
        suspendedAt: schema.workspaceMembers.suspendedAt,
      })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.userId, userId),
          eq(schema.workspaceMembers.workspaceId, workspaceId),
        ),
      ),
  );
  return Boolean(member && !member.suspendedAt && isOrgAdmin(member.role as Role));
}

function isHttps(url: string) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

const problemText = (error: unknown) =>
  error instanceof DomainError ? error.message : 'Something went wrong';
const problemStatus = (error: unknown): 400 | 403 | 409 | 502 =>
  error instanceof DomainError &&
  (error.status === 400 || error.status === 403 || error.status === 409)
    ? error.status
    : 502;

export const gitConnectionRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/git-connections',
      tags: ['git-connections'],
      summary: "The owner's git connections",
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: json(z.object({ connections: z.array(GitConnectionSchema) }), 'Oldest first'),
        ...authProblems,
      },
    }),
    async (c) => c.json({ connections: await listConnections(c.var.deps, c.var.user) }, 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/git-connections/token',
      tags: ['git-connections'],
      summary: 'Connect GitHub with a pasted fine-grained token',
      description:
        'GitHub is asked whose token it is; the token is kept sealed and never returned. A session can push with it once its push is allowed, but cannot fetch with it: that needs the GitHub App.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z
                .strictObject({ token: z.string().trim().min(8).max(500) })
                .openapi('GitTokenInput'),
            },
          },
          required: true,
        },
      },
      responses: {
        201: connectionBody,
        400: problemResponse('GitHub did not accept the token (`GITHUB_TOKEN_INVALID`)'),
        ...githubProblem,
        ...authProblems,
      },
    }),
    async (c) => {
      const connection = await createTokenConnection(c.var.deps, c.var.user, c.req.valid('json'));
      return c.json({ connection }, 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/git-connections/github-app',
      tags: ['git-connections'],
      summary: 'Whether this install has a GitHub App, and where it comes from',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: json(GithubAppStatusSchema, 'The App, if any'),
        ...authProblems,
      },
    }),
    async (c) => {
      const deps = c.var.deps;
      const loaded = await loadGithubApp(deps);
      const publicUrlOk = isHttps(deps.config.publicUrl);
      return c.json(
        {
          configured: Boolean(loaded),
          source: loaded?.source ?? null,
          slug: loaded?.app.slug ?? null,
          installUrlAvailable: Boolean(loaded),
          manifestAvailable: !loaded && deps.config.deployment === 'self_hosted' && publicUrlOk,
          publicUrlOk,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/git-connections/github-app',
      tags: ['git-connections'],
      summary: 'Forget the GitHub App the manifest flow made',
      description:
        'Admins only. The App stays on GitHub; delete it there too. Connections through it stop minting tokens.',
      middleware: [requireAdmin] as const,
      security: authenticated,
      responses: {
        204: { description: 'Forgotten' },
        409: problemResponse('The App comes from GITHUB_APP_* (`GITHUB_APP_FROM_CONFIG`)'),
        ...adminProblems,
      },
    }),
    async (c) => {
      const deps = c.var.deps;
      if (deps.config.githubApp) {
        throw new DomainError(
          409,
          'GITHUB_APP_FROM_CONFIG',
          'This install takes its GitHub App from GITHUB_APP_* in the environment',
        );
      }
      if (deps.config.deployment === 'managed') {
        throw new DomainError(409, 'GITHUB_APP_MANAGED', 'The managed service keeps its own App');
      }
      await clearGithubApp(deps);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/git-connections/github-app/manifest',
      tags: ['git-connections'],
      summary: "Start GitHub's manifest flow to make this install's own App",
      description:
        'Admins only, self-hosted only. The client posts `manifest` (as JSON, in a form field named `manifest`) to `url`. GitHub then redirects to the manifest callback. With `organization`, the App is made under that GitHub organization so it can be installed there; without, on the admin personal account, where only that account can install it.',
      middleware: [requireAdmin] as const,
      security: authenticated,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z
                .strictObject({
                  organization: z
                    .string()
                    .trim()
                    .regex(GITHUB_LOGIN, 'A GitHub organization login')
                    .optional()
                    .openapi({ description: 'The GitHub organization to make the App under' }),
                })
                .openapi('GithubAppManifestInput'),
            },
          },
          required: false,
        },
      },
      responses: {
        200: json(
          z
            .object({ url: z.url(), manifest: z.record(z.string(), z.unknown()) })
            .openapi('GithubAppManifest'),
          'Where to post the manifest',
        ),
        400: problemResponse(
          'OPENBOTS_PUBLIC_URL is not https (`PUBLIC_URL_REQUIRED`), or a bad organization',
        ),
        409: problemResponse('An App already exists, or the deployment is managed'),
        ...adminProblems,
      },
    }),
    async (c) => {
      const deps = c.var.deps;
      const state = signGithubState(deps.config, 'manifest', {
        userId: c.var.user.id,
        workspaceId: c.var.user.workspaceId,
      });
      const organization = (c.req.valid('json') as { organization?: string } | undefined)
        ?.organization;
      return c.json(
        await githubAppFor(deps).manifestUrl(state, organization ? { organization } : {}),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/git-connections/github-app/manifest/callback',
      tags: ['git-connections'],
      summary: "GitHub's redirect after the App was made: stores it",
      request: {
        query: z.object({ code: z.string().max(200).optional(), state: z.string().optional() }),
      },
      responses: {
        302: { description: 'To `/connectors?github_app=created`' },
        400: html('Unknown, expired or used state, or no code'),
        401: html('Not signed in (managed)'),
        403: html('Started by another account, or the user is no longer an admin'),
        409: html('An App exists already'),
        502: html('GitHub failed'),
      },
    }),
    async (c) => {
      const { code, state } = c.req.valid('query');
      const checked = await callbackOwner(c, 'manifest', state, { admin: true });
      if ('refused' in checked) return checked.refused;
      if (!code) return failurePage(c, 400, 'GitHub sent no code. Start again.');
      try {
        await githubAppFor(c.var.deps).completeManifest(code);
      } catch (error) {
        c.var.deps.logger.warn({ err: error }, 'GitHub App manifest not completed');
        return failurePage(c, problemStatus(error), problemText(error));
      }
      return finishRedirect(c, { github_app: 'created' });
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/git-connections/github-app/install',
      tags: ['git-connections'],
      summary: "Send the browser to the App's install page",
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        302: { description: 'To github.com/apps/<slug>/installations/new' },
        409: problemResponse('There is no App yet (`GITHUB_APP_MISSING`)'),
        ...authProblems,
      },
    }),
    async (c) => {
      const deps = c.var.deps;
      const state = signGithubState(deps.config, 'install', {
        userId: c.var.user.id,
        workspaceId: c.var.user.workspaceId,
      });
      c.header('referrer-policy', 'no-referrer');
      c.header('cache-control', 'no-store');
      return c.redirect(await githubAppFor(deps).installUrl(state), 302);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/git-connections/github-app/callback',
      tags: ['git-connections'],
      summary: "GitHub's redirect after the App was installed: makes the connection",
      request: {
        query: z.object({
          installation_id: z
            .string()
            .regex(/^\d{1,20}$/)
            .optional(),
          setup_action: z.string().max(50).optional(),
          state: z.string().optional(),
          code: z.string().max(200).optional(),
        }),
      },
      responses: {
        302: { description: 'To `/connectors?connection=<id>`' },
        400: html('Unknown, expired or used state, no installation or no code'),
        401: html('Not signed in (managed)'),
        403: html("Started by another account, or the installation is not the user's"),
        409: html('The App has no OAuth client'),
        502: html('GitHub failed'),
      },
    }),
    async (c) => {
      const query = c.req.valid('query');
      const checked = await callbackOwner(c, ['install', 'reauth'], query.state);
      if ('refused' in checked) return checked.refused;
      if (checked.state.purpose === 'reauth') {
        if (!query.code) return failurePage(c, 400, 'GitHub sent no authorization. Start again.');
        const { owner } = checked;
        const deps = c.var.deps;
        try {
          const connection = await inWorkspace(owner.workspaceId, () =>
            refreshRepositories(deps, owner, checked.state.connectionId!, query.code!),
          );
          return finishRedirect(c, { connection: connection.id });
        } catch (error) {
          deps.logger.warn({ err: error }, 'GitHub connection not reauthorized');
          return failurePage(c, problemStatus(error), problemText(error));
        }
      }
      if (!query.installation_id) {
        return failurePage(c, 400, 'GitHub did not say which installation. Start again.');
      }
      if (!query.code) {
        return failurePage(
          c,
          400,
          'GitHub sent no authorization with the installation. The App needs "Request user authorization (OAuth) during installation" turned on.',
        );
      }
      const { owner } = checked;
      const deps = c.var.deps;
      try {
        const connection = await inWorkspace(owner.workspaceId, () =>
          connectInstallation(deps, owner, {
            installationId: query.installation_id!,
            code: query.code!,
          }),
        );
        return finishRedirect(c, { connection: connection.id });
      } catch (error) {
        deps.logger.warn({ err: error }, 'GitHub App installation not connected');
        return failurePage(c, problemStatus(error), problemText(error));
      }
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/git-connections/{id}/reauthorize',
      tags: ['git-connections'],
      summary: "Authorize again on GitHub, so the App connection's repositories are read again",
      description:
        'App connections only. GitHub sends the browser back to the install callback, which reads the repositories the owner reaches in the installation again.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: idParam },
      responses: {
        302: { description: 'To github.com/login/oauth/authorize' },
        409: problemResponse(
          'Not an App connection (`NO_INSTALLATION`), or the App has no OAuth client',
        ),
        ...notFoundProblem,
        ...authProblems,
      },
    }),
    async (c) => {
      const deps = c.var.deps;
      const connection = await getConnection(deps, c.var.user, c.req.valid('param').id);
      if (connection.kind !== 'app' || !connection.installationId) {
        throw new DomainError(
          409,
          'NO_INSTALLATION',
          'This connection has no GitHub App installation',
        );
      }
      const state = signGithubState(deps.config, 'reauth', {
        userId: c.var.user.id,
        workspaceId: c.var.user.workspaceId,
        connectionId: connection.id,
      });
      const redirectUri = `${deps.config.publicUrl.replace(/\/+$/, '')}${INSTALL_CALLBACK_PATH}`;
      c.header('referrer-policy', 'no-referrer');
      c.header('cache-control', 'no-store');
      return c.redirect(await githubAppFor(deps).authorizeUrl(state, redirectUri), 302);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/git-connections/{id}/repositories',
      tags: ['git-connections'],
      summary: 'Every repository the connection reaches (the picker, GH2)',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: idParam,
        query: z.object({ q: z.string().max(200).optional() }),
      },
      responses: {
        200: json(
          z.object({ repositories: z.array(RemoteRepoSchema) }),
          'Filtered by `q` on the full name',
        ),
        ...notFoundProblem,
        ...githubProblem,
        ...authProblems,
      },
    }),
    async (c) => {
      const repositories = await remoteRepos(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('query').q,
      );
      return c.json({ repositories }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/git-connections/{id}',
      tags: ['git-connections'],
      summary: 'Who opens pull requests through the connection (GH8)',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: idParam,
        body: {
          content: {
            'application/json': {
              schema: z.strictObject({ actAs: GitActAsSchema }).openapi('GitConnectionUpdate'),
            },
          },
          required: true,
        },
      },
      responses: {
        200: connectionBody,
        400: problemResponse('Not an App connection (`ACT_AS_APP_ONLY`)'),
        409: problemResponse(
          'The owner has no GitHub sign-in to open pull requests with (`ACT_AS_NEEDS_SIGN_IN`)',
        ),
        ...notFoundProblem,
        ...authProblems,
      },
    }),
    async (c) => {
      const connection = await setActAs(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('json').actAs,
      );
      return c.json({ connection }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/git-connections/{id}/sync',
      tags: ['git-connections'],
      summary: 'List the repositories again and refresh the status',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: idParam },
      responses: {
        200: json(
          z
            .object({
              connection: GitConnectionSchema,
              needsReauthorize: z.boolean().openapi({
                description:
                  'The repository list can only grow after the owner authorizes again (GET /git-connections/{id}/reauthorize)',
              }),
            })
            .openapi('GitConnectionSync'),
          'The connection',
        ),
        ...notFoundProblem,
        ...githubProblem,
        ...authProblems,
      },
    }),
    async (c) => {
      const synced = await syncConnection(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json(synced, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/git-connections/{id}',
      tags: ['git-connections'],
      summary: 'Forget the connection; its repositories stay remembered',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: idParam },
      responses: { 204: { description: 'Forgotten' }, ...notFoundProblem, ...authProblems },
    }),
    async (c) => {
      await deleteConnection(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
