import { createRoute, z } from '@hono/zod-openapi';
import { requireAdmin } from '../middleware/auth.js';
import { adminProblems, authenticated, createRouter, problemResponse } from '../openapi.js';
import { LimitsSchema } from '../schemas.js';
import { DomainError } from '../errors.js';
import { recordAudit, userActor } from '../services/audit.js';
import { stopCustomStdio } from '../services/connectors.js';
import type { Limits } from '@openbots/shared';
import type { AppDeps } from '../context.js';
import {
  effectiveSettings,
  getOrganization,
  limitsCeiling,
  MANAGED_ONLY_SETTINGS,
  updateSettings,
  type Workspace,
} from '../workspace.js';

// Organization settings (U3, plan 21.3), persisted on the organization's row
// and read and changed by its owners and admins. A self-hosted install has
// one owner, who changes the limits and custom stdio here; audit retention is
// managed only and keeps its default there (see workspace.ts). On the
// managed service an organization's limits stay under a ceiling, the
// operator's (OPENBOTS_LIMITS_*) or its plan's: owners and admins may lower
// them, never raise them above it (400 ABOVE_PLAN_LIMIT), and a higher
// number in the row counts as the ceiling.

const SettingsSchema = z
  .object({
    limits: LimitsSchema,
    auditRetentionDays: z.number().int().openapi({
      description: 'Audit log rows older than this many days are deleted (default 180)',
    }),
    customStdioEnabled: z.boolean().openapi({
      description:
        'Whether admins may add custom stdio connectors, which run a command on the server (default false; members never may)',
    }),
    ceilings: z.object(LimitsSchema.shape).nullable().openapi({
      description:
        'The most each limit may be on the managed service; null on a self-hosted install, which has none',
    }),
  })
  .openapi('Settings');

const SettingsPatchSchema = z
  .strictObject({
    limits: LimitsSchema.partial().strict().optional(),
    auditRetentionDays: z.number().int().min(1).max(3650).optional(),
    customStdioEnabled: z.boolean().optional(),
  })
  .openapi('SettingsPatch');

const settingsResponse = {
  description: "The organization's settings in effect",
  content: { 'application/json': { schema: SettingsSchema } },
};

/** The settings in effect for the organization, with the ceilings its limits stay under. */
function settingsOf(deps: AppDeps, workspace: Workspace) {
  const ceilings = limitsCeiling(deps, workspace);
  return { ...effectiveSettings(deps.config, workspace, ceilings), ceilings };
}

/** The least an organization keeps its audit log for on the managed service. */
export const MIN_MANAGED_AUDIT_DAYS = 30;

export const settingsRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/settings',
      tags: ['settings'],
      summary: "The active organization's settings",
      middleware: [requireAdmin] as const,
      security: authenticated,
      responses: { 200: settingsResponse, ...adminProblems },
    }),
    async (c) => {
      const { db } = c.var.deps;
      return c.json(settingsOf(c.var.deps, await getOrganization(db, c.var.user.workspaceId)), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/settings',
      tags: ['settings'],
      summary: "Change the active organization's settings",
      middleware: [requireAdmin] as const,
      security: authenticated,
      request: {
        body: { required: true, content: { 'application/json': { schema: SettingsPatchSchema } } },
      },
      responses: {
        200: settingsResponse,
        400: problemResponse(
          'Invalid settings, a managed-only setting on a self-hosted install, custom stdio on the managed service, or a limit above its ceiling (`ABOVE_PLAN_LIMIT`)',
        ),
        ...adminProblems,
      },
    }),
    async (c) => {
      const { db, config } = c.var.deps;
      const patch = c.req.valid('json');
      if (config.deployment === 'self_hosted') {
        const managedOnly = MANAGED_ONLY_SETTINGS.filter((key) => patch[key] !== undefined);
        if (managedOnly.length) {
          throw new DomainError(
            400,
            'MANAGED_ONLY',
            `Not available on a self-hosted install: ${managedOnly.join(', ')}`,
          );
        }
      }
      // An admin cannot wipe the organization's record of what they did: the
      // managed service keeps at least 30 days (S-11, plan 21.6).
      if (
        config.deployment === 'managed' &&
        patch.auditRetentionDays !== undefined &&
        patch.auditRetentionDays < MIN_MANAGED_AUDIT_DAYS
      ) {
        throw new DomainError(
          400,
          'RETENTION_TOO_SHORT',
          `Keep the audit log for at least ${MIN_MANAGED_AUDIT_DAYS} days`,
        );
      }
      // A command would run on the server every organization shares (S-1, plan 21.6).
      if (!config.customStdio && patch.customStdioEnabled) {
        throw new DomainError(
          400,
          'SELF_HOSTED_ONLY',
          'Command (stdio) servers are not available on the hosted service',
        );
      }
      const current = await getOrganization(db, c.var.user.workspaceId);
      const ceilings = limitsCeiling(c.var.deps, current);
      for (const [key, value] of Object.entries(patch.limits ?? {})) {
        const ceiling = ceilings?.[key as keyof Limits];
        if (ceiling !== undefined && value > ceiling) {
          throw new DomainError(
            400,
            'ABOVE_PLAN_LIMIT',
            `That is above your plan's limit of ${ceiling}.`,
          );
        }
      }
      const workspace = await updateSettings(db, current, patch);
      await recordAudit(db, {
        workspaceId: workspace.id,
        actor: userActor(c.var.user),
        action: 'settings.update',
        targetType: 'workspace',
        targetId: workspace.id,
        metadata: patch,
      });
      // Their calls are refused from now on; their running children stop too (S-1).
      if (patch.customStdioEnabled === false) await stopCustomStdio(c.var.deps, workspace.id);
      return c.json(settingsOf(c.var.deps, workspace), 200);
    },
  );
