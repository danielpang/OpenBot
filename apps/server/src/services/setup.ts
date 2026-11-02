import { eq } from 'drizzle-orm';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { LOCAL_ONLY_MESSAGE, LOCAL_OWNER_EMAIL } from '../auth.js';
import { CLIENT_IP_HEADER } from '../client-ip.js';
import type { AppDeps } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, forbidden } from '../errors.js';
import { computerProvider } from './computer.js';
import { inWorkspace } from '../db/scope.js';
import { ensureWorkspace } from '../workspace.js';

// First run (plan 16.3, D1). An install needs setup until its first user
// exists; that user becomes the admin (auth.ts), called the owner on a
// self-hosted install, where it is the only account. The wizard then asks for a
// provider key through the providers API, starts the sandbox image pull and
// creates a first Bot through the Bots API.
//
// The Mac app's local mode (OPENBOTS_LOCAL_TOKEN) has no account step: the app
// creates the owner as it signs them in (routes/local.ts). Its wizard starts at
// the providers and shows until the first Bot exists.

export async function setupRequired(db: Db): Promise<boolean> {
  const [anyUser] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  return !anyUser;
}

/**
 * Whether the web app shows the first-run wizard: while no user exists, and
 * in local mode while the owner the Mac app created has no Bot yet. An owner
 * from before local mode, with a real email, is set up already.
 */
export async function wizardRequired(deps: Pick<AppDeps, 'db' | 'config'>): Promise<boolean> {
  const { db, config } = deps;
  // The managed service has no wizard: people sign up (plan 21.5).
  if (config.deployment === 'managed') return false;
  if (await setupRequired(db)) return true;
  if (!config.localToken) return false;
  const [localOwner] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, LOCAL_OWNER_EMAIL))
    .limit(1);
  if (!localOwner) return false;
  // A self-hosted install's one organization (db/scope.ts).
  const workspace = await ensureWorkspace(db);
  const [bot] = await inWorkspace(workspace.id, () =>
    db.select({ id: schema.bots.id }).from(schema.bots).limit(1),
  );
  return !bot;
}

export const setupComplete = () =>
  new DomainError(
    409,
    'SETUP_COMPLETE',
    'This OpenBots server is already set up. Sign in instead.',
  );

export interface AdminInput {
  name: string;
  email: string;
  password: string;
}

/**
 * Creates the first user through better-auth's email signup, so the session
 * cookie and the signup hooks (which make the first user admin) are the usual
 * ones. Refuses once any user exists. Two concurrent calls on an empty install
 * both pass the check; the hooks still make only one of them admin.
 *
 * `requestOrigin` is the caller's Origin header: better-auth refuses foreign
 * origins on its own routes, and this one must too, or any web page could
 * claim a fresh install for its visitor.
 */
export async function createAdmin(
  deps: AppDeps,
  input: AdminInput,
  requestOrigin: string | undefined,
  clientAddress: string | null = null,
): Promise<Response> {
  // In local mode only the Mac app makes the owner (routes/local.ts).
  if (deps.config.localToken) throw new DomainError(403, 'LOCAL_ONLY', LOCAL_ONLY_MESSAGE);
  const origin = new URL(deps.config.publicUrl).origin;
  if (requestOrigin !== undefined && requestOrigin !== origin) {
    throw forbidden('Create the first account from the OpenBots page itself');
  }
  if (!(await setupRequired(deps.db))) throw setupComplete();
  const res = await deps.auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      // better-auth rate-limits sign-ups by client address and refuses a
      // request without one (S-6), so pass on the caller's.
      headers: {
        'content-type': 'application/json',
        origin,
        ...(clientAddress ? { [CLIENT_IP_HEADER]: clientAddress } : {}),
      },
      body: JSON.stringify(input),
    }),
  );
  if (res.ok) return res;
  const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  throw new DomainError(
    res.status as ContentfulStatusCode,
    body.code ?? 'SIGNUP_FAILED',
    body.message ?? 'The account could not be created',
  );
}

export type SandboxImageStatus = 'not_configured' | 'idle' | 'pulling' | 'ready' | 'error';

export interface SandboxImageState {
  status: SandboxImageStatus;
  image: string;
  error: string | null;
}

// Per process: the pull is a convenience that warms the Docker cache, and the
// first `create` pulls anyway if this one never ran or failed.
const pulls = new WeakMap<
  AppDeps,
  { status: 'pulling' | 'ready' | 'error'; error: string | null }
>();

export function sandboxImageState(deps: AppDeps): SandboxImageState {
  const image = deps.config.sandboxImage;
  if (!computerProvider(deps)?.prepareImage)
    return { status: 'not_configured', image, error: null };
  const pull = pulls.get(deps);
  return { status: pull?.status ?? 'idle', image, error: pull?.error ?? null };
}

/** Starts the sandbox image pull in the background when Docker is configured. */
export function startSandboxPull(deps: AppDeps): SandboxImageState {
  const provider = computerProvider(deps);
  const current = pulls.get(deps)?.status;
  if (provider?.prepareImage && current !== 'pulling' && current !== 'ready') {
    pulls.set(deps, { status: 'pulling', error: null });
    provider.prepareImage(deps.config.sandboxImage).then(
      () => pulls.set(deps, { status: 'ready', error: null }),
      (err: unknown) => {
        deps.logger.warn({ err, image: deps.config.sandboxImage }, 'sandbox image pull failed');
        pulls.set(deps, {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }
  return sandboxImageState(deps);
}
