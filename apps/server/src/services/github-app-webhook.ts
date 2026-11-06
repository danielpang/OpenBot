import { EventTriggerSchema, type GitConnectionStatus } from '@openbots/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { githubInstallationWorkspaces, inWorkspace } from '../db/scope.js';
import { DomainError } from '../errors.js';
import { acceptDelivery, hasToken } from '../hooks/endpoints.js';
import { matchesRule, parseTriggerRule, type IncomingEvent } from '../hooks/match.js';
import { ownerActive } from '../membership.js';
import { allowsOn } from './git-connections.js';

// What the GitHub App's webhook does with a verified delivery (I19; docs/TECHNICAL_PLAN.md 22.12).
// The route (routes/github-app-webhook.ts) checks the size and the HMAC; this
// file finds who the delivery belongs to and acts on it:
//
// - `installation`: removed or suspended on GitHub marks every connection to
//   that installation `revoked` or `needs_reinstall`; unsuspended marks it
//   `connected` again. `created` does nothing: the install callback makes
//   the connection, with the owner who clicked Install.
// - `installation_repositories`: the repository set changed; the connection's
//   `last_synced_at` moves so the picker lists again, and a removed
//   repository leaves every owner's list (git-connections.ts, H1). An added
//   one joins nobody's list until its owner authorizes again.
// - anything else names its installation (`installation.id`). Each
//   organization with a connection to it is found through
//   `githubInstallationWorkspaces` (db/scope.ts; drizzle/0029), a SECURITY
//   DEFINER lookup like the ingress's, and the rest runs in that
//   organization's scope. Every enabled Routine of the connection's owner,
//   when the delivery's repository is in that owner's list, whose trigger
//   is a GitHub event, whose rule matches (event, action,
//   `repo` against `repository.full_name`, `label`, `text`, and
//   `installation_id` when set; hooks/match.ts), gets the delivery through
//   its own webhook endpoint (`acceptDelivery`): logged there, idempotent on
//   `X-GitHub-Delivery`, framed as data in the transcript, and started as a
//   `routine` run whose input names the endpoint and delivery, so the run's
//   source is `webhook` and the stricter floor applies (P2).
//
// A Routine whose endpoint verifies GitHub signatures itself (a per-repository
// webhook, the OAuth and token path) gets the same events from GitHub
// directly and is skipped here, so one event does not start it twice.
//
// The installation's rate limit is spent once per delivery, before any
// work, so a delivery is refused whole (429, GitHub retries it) or handled
// whole: one organization's failure is logged and the next one still runs.

type HookDeps = Pick<AppDeps, 'config' | 'db' | 'infra' | 'logger'>;
type Json = Record<string, unknown>;

const obj = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;

export interface GithubAppDelivery {
  /** `X-GitHub-Event`. */
  event: string;
  /** `X-GitHub-Delivery`, GitHub's id for the delivery; a redelivery keeps it. */
  deliveryId: string | undefined;
  /** Lowercased names. */
  headers: Record<string, string>;
  body: Buffer;
  payload: unknown;
  remoteIp: string | null;
}

export interface GithubAppOutcome {
  /** The installation the delivery names; null when it names none. */
  installationId: string | null;
  /** Connections whose status changed or that were touched. */
  connections: number;
  /** Routine runs started (repeats of a delivery start none). */
  started: string[];
}

/** What a connection's `error` says after an `installation` action. */
export function installationNote(action: string | undefined): string | null {
  switch (action) {
    case 'deleted':
      return 'The installation was removed on GitHub';
    case 'suspend':
      return 'GitHub suspended the installation';
    default:
      return null;
  }
}

/** The status an `installation` action moves a connection to; null for no change. */
export function installationStatus(action: string | undefined): GitConnectionStatus | null {
  switch (action) {
    case 'deleted':
      return 'revoked';
    case 'suspend':
      return 'needs_reinstall';
    case 'unsuspend':
      return 'connected';
    default:
      return null;
  }
}

const rateLimited = () =>
  new DomainError(
    429,
    'RATE_LIMITED',
    'Too many deliveries for this installation; retry in a minute',
  );

/**
 * Acts on one verified App delivery. Throws 429, before any work, when the
 * installation's minute is spent; after that it never throws: a failure in
 * one organization is logged and the others are still handled.
 */
export async function handleGithubAppDelivery(
  deps: HookDeps,
  delivery: GithubAppDelivery,
): Promise<GithubAppOutcome> {
  const payload = obj(delivery.payload);
  const installationId = str(obj(payload['installation'])['id']) ?? null;
  const outcome: GithubAppOutcome = { installationId, connections: 0, started: [] };
  if (!installationId || delivery.event === 'ping') return outcome;
  const workspaces = await githubInstallationWorkspaces(deps.db, installationId);
  if (!workspaces.length) return outcome;
  const { allowed } = await deps.infra.limiter.consume(`github-app:${installationId}`, {
    window: 60,
    max: deps.config.limits.webhookEndpointRatePerMin,
  });
  if (!allowed) throw rateLimited();
  for (const workspaceId of workspaces) {
    try {
      await inWorkspace(workspaceId, () =>
        inOrganization(deps, workspaceId, installationId, delivery, outcome),
      );
    } catch (err) {
      deps.logger.error(
        { err, workspaceId, installationId, event: delivery.event },
        'github app delivery failed in an organization',
      );
    }
  }
  return outcome;
}

async function inOrganization(
  deps: HookDeps,
  workspaceId: string,
  installationId: string,
  delivery: GithubAppDelivery,
  outcome: GithubAppOutcome,
) {
  const { db } = deps;
  const ofInstallation = and(
    eq(schema.gitConnections.workspaceId, workspaceId),
    eq(schema.gitConnections.provider, 'github'),
    eq(schema.gitConnections.kind, 'app'),
    eq(schema.gitConnections.installationId, installationId),
  );
  const action = str(obj(delivery.payload)['action']);

  if (delivery.event === 'installation') {
    const status = installationStatus(action);
    if (!status) return;
    const changed = await db
      .update(schema.gitConnections)
      .set({
        status,
        error: installationNote(action),
        updatedAt: new Date(),
      })
      .where(ofInstallation)
      .returning({ id: schema.gitConnections.id });
    outcome.connections += changed.length;
    return;
  }
  if (delivery.event === 'installation_repositories') {
    const removed = new Set(
      (Array.isArray(obj(delivery.payload)['repositories_removed'])
        ? (obj(delivery.payload)['repositories_removed'] as unknown[])
        : []
      )
        .map((r) => str(obj(r)['full_name'])?.toLowerCase())
        .filter((name): name is string => Boolean(name)),
    );
    const rows = await db
      .select({ id: schema.gitConnections.id, repositories: schema.gitConnections.repositories })
      .from(schema.gitConnections)
      .where(ofInstallation);
    for (const row of rows) {
      await db
        .update(schema.gitConnections)
        .set({
          lastSyncedAt: new Date(),
          ...(row.repositories && removed.size
            ? {
                repositories: row.repositories.filter(
                  (r) => !removed.has(r.fullName.toLowerCase()),
                ),
              }
            : {}),
        })
        .where(eq(schema.gitConnections.id, row.id));
    }
    outcome.connections += rows.length;
    return;
  }

  const connections = await db.select().from(schema.gitConnections).where(ofInstallation);
  const event: IncomingEvent = { headers: delivery.headers, payload: delivery.payload };
  const fullName = str(obj(obj(delivery.payload)['repository'])['full_name']);
  for (const connection of connections) {
    if (connection.status !== 'connected') continue;
    // An owner hears only of repositories their own GitHub access reaches (H1).
    if (!fullName || !allowsOn(connection, fullName).read) continue;
    const owner = { ownerId: connection.ownerId, workspaceId };
    // A suspended or removed member's Routines take nothing (plan 21.6).
    if (!(await ownerActive(db, owner))) continue;
    if (delivery.event === 'push' && fullName) await notePush(db, owner, fullName);
    for (const { routine, endpoint } of await githubRoutines(db, owner)) {
      const trigger = EventTriggerSchema.safeParse(routine.trigger);
      if (!trigger.success || !trigger.data.match) continue;
      const rule = parseTriggerRule(trigger.data);
      if (!rule.success || rule.data.source !== 'github') continue;
      if (!matchesRule(rule.data, event)) continue;
      const accepted = await acceptDelivery(deps, endpoint, {
        headers: delivery.headers,
        body: delivery.body,
        remoteIp: delivery.remoteIp,
        verified: true,
        origin: 'ingress',
        ...(delivery.deliveryId ? { idempotencyKey: `github:${delivery.deliveryId}` } : {}),
      }).catch((err: unknown) => {
        // One Routine's failure (recorded on its delivery) does not stop the others.
        deps.logger.error(
          { err, routineId: routine.id, installationId },
          'github app delivery failed',
        );
        return null;
      });
      if (accepted?.run && !accepted.duplicate) outcome.started.push(accepted.run.id);
    }
  }
}

/**
 * The owner's enabled Routines waiting on a GitHub event, each with its own
 * enabled endpoint; one whose endpoint checks GitHub signatures itself (a
 * per-repository webhook) is left out (see above).
 */
async function githubRoutines(db: Db, owner: { ownerId: string; workspaceId: string }) {
  const rows = await db
    .select({ routine: schema.routines, endpoint: schema.webhookEndpoints })
    .from(schema.routines)
    .innerJoin(schema.bots, eq(schema.bots.id, schema.routines.botId))
    .innerJoin(
      schema.webhookEndpoints,
      sql`${schema.webhookEndpoints.id} = (${schema.routines.trigger} ->> 'endpoint_id')::uuid`,
    )
    .where(
      and(
        eq(schema.bots.ownerId, owner.ownerId),
        eq(schema.routines.workspaceId, owner.workspaceId),
        eq(schema.routines.enabled, true),
        sql`${schema.routines.trigger} ->> 'type' = 'event'`,
        sql`${schema.routines.trigger} ->> 'source' = 'github'`,
        eq(schema.webhookEndpoints.enabled, true),
        eq(schema.webhookEndpoints.routineId, schema.routines.id),
      ),
    );
  return rows.filter(
    ({ endpoint }) => !(hasToken(endpoint) && obj(endpoint.signature)['preset'] === 'github'),
  );
}

/** A push GitHub reported moves the remembered repository's `last_remote_push_at`. */
async function notePush(db: Db, owner: { ownerId: string; workspaceId: string }, fullName: string) {
  await db
    .update(schema.repos)
    .set({ lastRemotePushAt: new Date() })
    .where(
      and(
        eq(schema.repos.ownerId, owner.ownerId),
        eq(schema.repos.workspaceId, owner.workspaceId),
        sql`lower(${schema.repos.fullName}) = lower(${fullName})`,
      ),
    );
}
