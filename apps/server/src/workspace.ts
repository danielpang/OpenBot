import { randomBytes } from 'node:crypto';
import { DEFAULT_LIMITS, type Limits } from '@openbots/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from './config.js';
import { schema, type Db } from './db/client.js';
import { asDirectory } from './db/scope.js';
import type { ServerExtensions } from './extensions.js';
import { notFound } from './errors.js';

// Organizations (plan section 21). A `workspaces` row is an organization and
// its settings (limits, custom stdio, small models; U3) live in
// `workspaces.settings`. Anything unset there falls back to the environment
// (`OPENBOTS_LIMITS_*`).
//
// A self-hosted install (OPENBOTS_DEPLOYMENT) is one implicit organization,
// made on first use, with one owner and no admin screens, so the settings
// that only matter with members keep their defaults whatever is stored: the
// audit log keeps 180 days. The limits and custom stdio connectors stay the
// owner's to change. On the managed service each organization has its own
// settings, which its owners and admins change.

export type Workspace = typeof schema.workspaces.$inferSelect;
export type Organization = Workspace;
export type Role = (typeof schema.ORGANIZATION_ROLES)[number];
export type SignupMode = Config['signupMode'];

/** Owners and admins manage an organization (plan 21.6). */
export const isOrgAdmin = (role: Role | null | undefined) => role === 'owner' || role === 'admin';

/** Audit rows are kept this long unless the admin changes it (S-11). */
export const DEFAULT_AUDIT_RETENTION_DAYS = 180;

/** The settings a self-hosted install does not offer; they keep their defaults there. */
export const MANAGED_ONLY_SETTINGS = ['auditRetentionDays'] as const;

const limitKeys = Object.keys(DEFAULT_LIMITS) as [keyof Limits, ...(keyof Limits)[]];

export const storedSettingsSchema = z.object({
  // A limit stored by an older version that is no longer a setting (computers
  // per account, computer tasks per Bot) is dropped, not a reason to ignore
  // every other setting.
  limits: z
    .preprocess(
      (value) =>
        value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value).filter(([key]) => (limitKeys as string[]).includes(key)),
            )
          : value,
      z.partialRecord(z.enum(limitKeys), z.number().int().positive()),
    )
    .optional(),
  auditRetentionDays: z.number().int().positive().optional(),
  /** Whether admins may add custom stdio connectors, which run any command on the server (S-1). */
  customStdioEnabled: z.boolean().optional(),
  /** Background-task model per provider id, overriding the cheapest-with-tools pick (plan 5.9). */
  smallModels: z.record(z.string(), z.string()).optional(),
});

export type StoredSettings = z.infer<typeof storedSettingsSchema>;

export interface Settings {
  limits: Limits;
  auditRetentionDays: number;
  customStdioEnabled: boolean;
}

/** Serializes making the implicit organization and its first owner. */
const WORKSPACE_LOCK = 0x6f70656e; // "open"

export function lockWorkspace(db: Db) {
  return db.execute(sql`select pg_advisory_xact_lock(${WORKSPACE_LOCK})`);
}

/** Serializes membership changes in one organization (the last-owner rule, plan 21.6). */
export function lockOrganization(db: Db, workspaceId: string) {
  return db.execute(sql`select pg_advisory_xact_lock(hashtext(${`org:${workspaceId}`}))`);
}

/** A slug for an organization named `name`: its letters and digits, and a random suffix. */
export function organizationSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'org';
  return `${base}-${randomBytes(4).toString('hex')}`;
}

/**
 * The implicit organization of a self-hosted install, made on first use
 * (plan 21.2). The managed service never uses it for a request: there the
 * organization comes from the session or the API key.
 */
export function ensureWorkspace(db: Db): Promise<Workspace> {
  // Which organizations exist is the directory's to say (db/scope.ts).
  return asDirectory(() => findOrMakeWorkspace(db));
}

async function findOrMakeWorkspace(db: Db): Promise<Workspace> {
  const existing = await firstWorkspace(db);
  if (existing) return existing;
  return db.transaction(async (tx) => {
    await lockWorkspace(tx);
    const again = await firstWorkspace(tx);
    if (again) return again;
    const [created] = await tx
      .insert(schema.workspaces)
      .values({ name: 'OpenBots', slug: organizationSlug('OpenBots') })
      .returning();
    return created!;
  });
}

/** The implicit organization's name for what it is (plan 21.2); see `ensureWorkspace`. */
export const implicitOrganization = ensureWorkspace;

async function firstWorkspace(db: Db): Promise<Workspace | undefined> {
  const [row] = await db
    .select()
    .from(schema.workspaces)
    .orderBy(asc(schema.workspaces.createdAt))
    .limit(1);
  return row;
}

/** An organization by id; 404 when it is gone. */
export async function getOrganization(db: Db, workspaceId: string): Promise<Workspace> {
  const [row] = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  if (!row) throw notFound('Organization not found');
  return row;
}

type SettingsDeps = { db: Db; config: Config; extensions?: ServerExtensions };

/**
 * The most an organization's limits may be (plan 21.6), or null where there
 * is no ceiling. On the managed service the operator's limits
 * (OPENBOTS_LIMITS_*) are the ceiling, unless the managed build sets one per
 * organization (`ServerExtensions.limitsCeiling`, for plans). Owners and
 * admins may only lower their organization's limits under it. A self-hosted
 * owner is the operator and has none.
 */
export function limitsCeiling(
  deps: Pick<SettingsDeps, 'config' | 'extensions'>,
  workspace: Workspace,
): Limits | null {
  if (deps.config.deployment !== 'managed') return null;
  return deps.extensions?.limitsCeiling?.(workspace, deps.config) ?? deps.config.limits;
}

/** The settings in effect for an organization, under its ceiling (see `effectiveSettings`). */
export async function organizationSettings(
  deps: SettingsDeps,
  workspaceId: string,
): Promise<Settings> {
  const workspace = await getOrganization(deps.db, workspaceId);
  return effectiveSettings(deps.config, workspace, limitsCeiling(deps, workspace));
}

export function storedSettings(workspace: Workspace): StoredSettings {
  // Ignore anything unrecognised rather than failing every request on it.
  const parsed = storedSettingsSchema.safeParse(workspace.settings);
  return parsed.success ? parsed.data : {};
}

/**
 * The settings in effect: what is stored over the environment's defaults.
 * On the managed service each limit is capped at `ceiling` (the operator's
 * by default), whatever the row holds.
 */
export function effectiveSettings(
  config: Config,
  workspace: Workspace,
  ceiling: Limits | null = config.deployment === 'managed' ? config.limits : null,
): Settings {
  const stored = storedSettings(workspace);
  if (config.deployment === 'self_hosted') {
    return {
      limits: { ...config.limits, ...stored.limits },
      auditRetentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
      customStdioEnabled: stored.customStdioEnabled ?? false,
    };
  }
  const limits: Limits = { ...config.limits, ...stored.limits };
  if (ceiling) {
    for (const key of limitKeys) limits[key] = Math.min(limits[key], ceiling[key]);
  }
  return {
    limits,
    auditRetentionDays: stored.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS,
    customStdioEnabled: stored.customStdioEnabled ?? false,
  };
}

/**
 * How someone at a limit gets more room: an admin raises it on the managed
 * service; a self-hosted owner raises it in Settings > Limits.
 */
export function raiseLimitHint(config: Pick<Config, 'deployment'>, what = 'it'): string {
  return config.deployment === 'managed'
    ? `ask an admin to raise ${what}`
    : `raise ${what} in Settings > Limits`;
}

export async function updateSettings(
  db: Db,
  workspace: Workspace,
  patch: StoredSettings,
): Promise<Workspace> {
  const current = storedSettings(workspace);
  const next: StoredSettings = {
    ...current,
    ...patch,
    limits: { ...current.limits, ...patch.limits },
  };
  const [row] = await db
    .update(schema.workspaces)
    .set({ settings: next })
    .where(eq(schema.workspaces.id, workspace.id))
    .returning();
  return row!;
}
