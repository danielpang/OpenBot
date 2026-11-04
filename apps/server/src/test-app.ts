import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { DEFAULT_CAPABILITIES } from '@openbots/shared';
import { and, eq } from 'drizzle-orm';
import { createApp, type App } from './app.js';
import { createAuth } from './auth.js';
import { loadConfig, type Config } from './config.js';
import type { AppDeps } from './context.js';
import { createTestDb, type TestDb } from './db/test-db.js';
import { createInfra } from './infra/index.js';
import { schema, type Db } from './db/client.js';
import { inWorkspace, scopedDb } from './db/scope.js';
import type { ServerExtensions } from './extensions.js';
import { createLogger } from './logger.js';
import { generateMasterKey } from './secrets.js';
import { attachGateway } from './ws/gateway.js';
import { ensureWorkspace, organizationSlug, type Role } from './workspace.js';

// An app over a fresh test database (see db/test-db.ts), plus helpers that
// drive it the way a browser or script would.
//
// The config is built from `env` alone, never from process.env, so anything
// the server would default to a path in the image (OPENBOTS_FILES_DIR is
// /data/files) has to be given here. Each app stores files in its own
// temporary directory, removed on close, unless the test names one.
//
// Apps are self-hosted, like the server's default: one account, and a second
// signup is refused. Tests with several users pass `OPENBOTS_DEPLOYMENT:
// 'managed'`. The core alone makes no organizations (plan 21.5), so without
// an organizations extension `signUp` puts each new user in the default
// organization, the first as its owner, and makes it their session's active
// one, as the managed build would after an invite; `createOrganization`,
// `addMember` and `switchOrganization` set up the rest. The managed build's
// own tests pass its extensions instead.

export interface TestApp {
  app: App;
  deps: AppDeps;
  testDb: TestDb;
  /**
   * The database owner's handle, with no row-level security: for setting up
   * and checking rows. The app's own is `deps.db` (db/scope.ts).
   */
  db: Db;
  /**
   * `deps` with the owner's handle as `db`: for tests that call a service
   * directly, outside any request, job or organization scope.
   */
  ownerDeps: AppDeps;
  /**
   * Runs `fn` in an organization's scope (db/scope.ts), the default one
   * unless named: for a service called directly, as a request or job would.
   */
  inOrganization<T>(fn: () => T | PromiseLike<T>, workspaceId?: string): Promise<T>;
  /** Closes the app and its database; calling it again waits for the first close. */
  close(): Promise<void>;
  /** Signs up through better-auth and returns the response and the session cookie. */
  signUp(
    email: string,
    extra?: Record<string, unknown>,
  ): Promise<{ res: Response; cookie: string | undefined }>;
  /**
   * An instance-level provider row every user may name in `modelConfig`, for
   * tests whose runs use a scripted model instead of calling it. It lists one
   * enabled model, `scripted`, with tool calling.
   */
  providerId(): Promise<string>;
  /** Lists enabled models with tool calling on a provider, so Bots may pick them (L5). */
  addModels(providerId: string, modelIds: string[]): Promise<void>;
  /** The default organization: the implicit one, which `signUp` joins without extensions. */
  defaultOrganization(): Promise<string>;
  /** A new organization with no members; returns its id. */
  createOrganization(name: string): Promise<string>;
  /** Makes the user a member of the organization. */
  addMember(userId: string, workspaceId: string, role?: Role): Promise<void>;
  /** Makes the organization the active one of the session behind `cookie` (plan 21.2). */
  switchOrganization(cookie: string, workspaceId: string | null): Promise<void>;
  /** The id of the user with this email. */
  userId(email: string): Promise<string>;
}

export const ORIGIN = 'http://localhost:3000';

/**
 * A new Bot's greeting (services/bots.ts): the first message in its
 * transcript, from the Bot itself, written without a run.
 */
export const isGreeting = (m: { seq: number; authorType: string; runId?: string | null }) =>
  m.seq === 1 && m.authorType === 'bot' && !m.runId;

export interface TestAppOptions {
  /** better-auth's rate limit; off by default, as tests sign up many people from no address. */
  rateLimit?: boolean;
  /** The managed build's extensions (ee/server tests). */
  extensions?: ServerExtensions;
}

export async function createTestApp(
  env: Record<string, string> = {},
  { rateLimit = false, extensions }: TestAppOptions = {},
): Promise<TestApp> {
  const testDb = await createTestDb();
  const ownFilesDir = env.OPENBOTS_FILES_DIR
    ? undefined
    : await mkdtemp(path.join(tmpdir(), 'openbots-test-files-'));
  const config: Config = loadConfig({
    OPENBOTS_MASTER_KEY: generateMasterKey(),
    DATABASE_URL: 'postgres://unused',
    OPENBOTS_PUBLIC_URL: ORIGIN,
    OPENBOTS_DEPLOYMENT: 'self_hosted',
    ...(ownFilesDir ? { OPENBOTS_FILES_DIR: ownFilesDir } : {}),
    ...env,
  });
  const logger = createLogger('silent');
  // The app works under row-level security (db/scope.ts); tests set up and
  // check rows with `t.db`, the database owner's handle, which has none.
  const owner = testDb.db;
  const db = scopedDb(owner);
  const infra = createInfra(config);
  const auth = createAuth({
    config,
    db,
    logger,
    limiter: infra.limiter,
    rateLimit,
    plugins: extensions?.authPlugins?.({ config, db, logger, infra }) ?? [],
  });
  const deps: AppDeps = { config, db, logger, infra, auth, ...(extensions ? { extensions } : {}) };
  const app = createApp(deps, { webDist: '' });
  let provider: Promise<string> | undefined;
  let closed: Promise<void> | undefined;
  const defaultOrganization = async () => (await ensureWorkspace(owner)).id;
  const addMember = async (userId: string, workspaceId: string, role: Role = 'member') => {
    await owner.insert(schema.workspaceMembers).values({ workspaceId, userId, role });
  };
  const switchOrganization = async (cookie: string, workspaceId: string | null) => {
    const token = decodeURIComponent(cookie.split('=').slice(1).join('=')).split('.')[0]!;
    await owner
      .update(schema.sessions)
      .set({ activeOrganizationId: workspaceId })
      .where(eq(schema.sessions.token, token));
  };
  const addModels = async (providerId: string, modelIds: string[]) => {
    const workspace = await ensureWorkspace(owner);
    await owner
      .insert(schema.providerModels)
      .values(
        modelIds.map((modelId) => ({
          workspaceId: workspace.id,
          providerId,
          modelId,
          displayName: modelId,
          capabilities: { ...DEFAULT_CAPABILITIES, tools: true },
          source: 'manual' as const,
        })),
      )
      .onConflictDoNothing();
  };

  return {
    app,
    deps,
    db: owner,
    // A live view of `deps` (tests set `net` and the like on it later), with the owner's db.
    ownerDeps: new Proxy(deps, {
      get: (target, key) => (key === 'db' ? owner : Reflect.get(target, key)),
      set: (target, key, value) => Reflect.set(target, key, value),
    }),
    async inOrganization(fn, workspaceId) {
      return inWorkspace(workspaceId ?? (await defaultOrganization()), fn);
    },
    testDb,
    close() {
      closed ??= (async () => {
        await infra.close();
        await testDb.close();
        if (ownFilesDir) await rm(ownFilesDir, { recursive: true, force: true });
      })();
      return closed;
    },
    providerId() {
      provider ??= ensureWorkspace(owner).then(async (workspace) => {
        const [row] = await owner
          .insert(schema.providers)
          .values({
            workspaceId: workspace.id,
            kind: 'custom',
            protocol: 'openai_compatible',
            name: 'Scripted',
            slug: 'scripted',
            status: 'untested',
          })
          .returning({ id: schema.providers.id });
        await addModels(row!.id, ['scripted']);
        return row!.id;
      });
      return provider;
    },
    addModels,
    defaultOrganization,
    async createOrganization(name) {
      const [row] = await owner
        .insert(schema.workspaces)
        .values({ name, slug: organizationSlug(name) })
        .returning({ id: schema.workspaces.id });
      return row!.id;
    },
    addMember,
    switchOrganization,
    async userId(email) {
      const [row] = await owner
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email.toLowerCase()));
      if (!row) throw new Error(`no user ${email}`);
      return row.id;
    },
    async signUp(email, extra = {}) {
      const res = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({
          name: email.split('@')[0],
          email,
          password: 'correct horse battery',
          ...extra,
        }),
      });
      const cookie = sessionCookie(res);
      if (config.deployment === 'managed' && !extensions?.organizations && res.ok) {
        // As if invited to the default organization: the first user owns it.
        const { user } = (await res.clone().json()) as { user: { id: string } };
        const workspaceId = await defaultOrganization();
        const [first] = await owner
          .select({ id: schema.workspaceMembers.id })
          .from(schema.workspaceMembers)
          .where(
            and(
              eq(schema.workspaceMembers.workspaceId, workspaceId),
              eq(schema.workspaceMembers.role, 'owner'),
            ),
          )
          .limit(1);
        await addMember(user.id, workspaceId, first ? 'member' : 'owner');
        if (cookie) await switchOrganization(cookie, workspaceId);
      }
      return { res, cookie };
    },
  };
}

function sessionCookie(res: Response): string | undefined {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.includes('session_token='));
}

/**
 * Serves a test app on an ephemeral port of 127.0.0.1 with the WS gateway
 * attached, as server.ts serves the real one: for tests that need a real
 * socket, such as the relay adapter's loopback requests.
 */
export async function serveTestApp(t: TestApp): Promise<{
  port: number;
  server: ServerType;
  close(): Promise<void>;
}> {
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const gateway = await attachGateway(server, t.deps);
  return {
    port: (server.address() as AddressInfo).port,
    server,
    async close() {
      await gateway.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
    },
  };
}
