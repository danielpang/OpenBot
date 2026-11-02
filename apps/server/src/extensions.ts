import type { OpenAPIHono } from '@hono/zod-openapi';
import type { BetterAuthPlugin } from 'better-auth';
import type { Config } from './config.js';
import type { AppEnv } from './context.js';
import type { Db } from './db/client.js';
import type { Infra } from './infra/index.js';
import type { Logger } from './logger.js';
import type { Limits } from '@openbots/shared';
import type { Workspace } from './workspace.js';

// Extension points for the managed build (plan 21.5). The core never imports
// ee/: `ee/server` imports the core and passes these to `runServer`, the
// test app or `createApp`. A self-hosted server passes none.

export interface ExtensionContext {
  config: Config;
  db: Db;
  logger: Logger;
  infra: Infra;
}

export interface ServerExtensions {
  /**
   * The extension manages organizations: creating them, invitations and
   * roles. `OPENBOTS_DEPLOYMENT=managed` needs it (`runServer` refuses
   * otherwise), since the core alone has no way to make an organization.
   */
  organizations?: boolean;
  /**
   * Every request needs an account whose email is verified (403
   * EMAIL_NOT_VERIFIED otherwise), its API keys included. The managed build
   * verifies email at sign-up.
   */
  requireVerifiedEmail?: boolean;
  /** better-auth plugins added after the core's; they may bring database hooks. */
  authPlugins?(context: ExtensionContext): BetterAuthPlugin[];
  /** Mounts more routes on the app, before the SPA fallback. */
  routes?(app: OpenAPIHono<AppEnv>): void;
  /** Hides secrets in a request path before it is logged, as webhook tokens are. */
  redactPath?(path: string): string;
  /** The web build to serve instead of `apps/web/dist`. */
  webDist?: string;
  /**
   * The most an organization's limits may be (plan 21.6): its plan's, when
   * billing comes. Without it the operator's limits (OPENBOTS_LIMITS_*) are
   * every organization's ceiling. Owners and admins may lower limits under
   * it, never raise them above it.
   */
  limitsCeiling?(workspace: Workspace, config: Config): Limits;
}
