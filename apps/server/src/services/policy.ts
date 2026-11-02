import {
  asEvaluation,
  createPolicy,
  defaultSummary,
  everyToolDefault,
  guessFacts,
  type DefaultSummary,
  type Policy,
  type ToolAnnotations,
  type ToolFacts,
} from '@openbots/agent';
import {
  PolicyDecisionSchema,
  sourceOfTrigger,
  type ToolGroupName,
  TriggerOverrideSchema,
  type RunSource,
  type TriggerOverride,
} from '@openbots/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { blockedBuiltins } from '../builtins/index.js';
import { assertBotOwner } from '../ownership.js';
import { audit } from './approvals.js';
import {
  blockRules,
  customStdioRefusal,
  isBlocked,
  isCustomStdio,
  readConfig,
} from './connectors.js';
import type { RunRow, RunState } from './runs.js';

// The policy for one run (plan 8, T5): the engine in `@openbots/agent` fed
// with the Bot's `tool_policy`, its connectors' approval overrides and the
// MCP annotations cached in `connector_tools`, plus the webhook endpoint's
// `tool_policy_override` for a run a delivery started (plan 11, stricter
// only). The floor for data follows who wrote what started the run
// (`runSource`): a run webhook data started gets the webhook rules whether it
// is an inbox run or a Routine run, and a run another Bot's message started
// gets the `bot_dm` rules whether it came as a Bot to Bot message or as an
// @mention. The owner's own messages get neither, `bot_message` included.
// A connector's read-only hints are believed only
// when it came from the catalog or an admin marked it trusted (S-16). A
// refused call is audited.

type BotRow = typeof schema.bots.$inferSelect;

export async function loadRunPolicy(
  deps: Pick<AppDeps, 'db' | 'logger'>,
  run: RunRow,
  bot: BotRow,
  tools: Map<string, ToolFacts>,
): Promise<Policy> {
  const connectors = await deps.db
    .select({
      id: schema.connectors.id,
      slug: schema.connectors.slug,
      approvalOverride: schema.botConnectors.approvalOverride,
    })
    .from(schema.botConnectors)
    .innerJoin(schema.connectors, eq(schema.connectors.id, schema.botConnectors.connectorId))
    .where(eq(schema.botConnectors.botId, bot.id));
  const bySlug = new Map(connectors.map((c) => [c.slug, c]));
  // Every connector of the owner offers its tools, with or without a `bot_connectors` row.
  const owned = await deps.db
    .select({
      slug: schema.connectors.slug,
      catalogId: schema.connectors.catalogId,
      trusted: schema.connectors.trusted,
    })
    .from(schema.connectors)
    .where(
      and(
        eq(schema.connectors.ownerId, bot.ownerId),
        eq(schema.connectors.workspaceId, bot.workspaceId),
      ),
    );
  const trustedSlugs = new Set(
    owned.filter((c) => c.catalogId !== null || c.trusted).map((c) => c.slug),
  );
  const annotations = new Map<string, ToolAnnotations>();
  if (connectors.length) {
    const rows = await deps.db
      .select({
        connectorId: schema.connectorTools.connectorId,
        name: schema.connectorTools.name,
        annotations: schema.connectorTools.annotations,
      })
      .from(schema.connectorTools)
      .innerJoin(
        schema.botConnectors,
        eq(schema.botConnectors.connectorId, schema.connectorTools.connectorId),
      )
      .where(eq(schema.botConnectors.botId, bot.id));
    const slugs = new Map(connectors.map((c) => [c.id, c.slug]));
    for (const row of rows) {
      annotations.set(
        `${slugs.get(row.connectorId)}__${row.name}`,
        row.annotations as ToolAnnotations,
      );
    }
  }

  const facts = (toolName: string): ToolFacts => {
    const known = tools.get(toolName) ?? guessFacts(toolName);
    if (known.group !== 'connector') return known;
    const slug = known.connector?.slug ?? guessFacts(toolName).connector?.slug;
    const connector = slug ? bySlug.get(slug) : undefined;
    const override = PolicyDecisionSchema.safeParse(connector?.approvalOverride);
    return {
      ...known,
      ...(known.annotations || !annotations.has(toolName)
        ? {}
        : { annotations: annotations.get(toolName)! }),
      ...(slug
        ? {
            connector: {
              slug,
              approvalOverride: override.success ? override.data : null,
              hintsTrusted: trustedSlugs.has(slug),
            },
          }
        : {}),
    };
  };

  const policy = createPolicy({
    toolPolicy: bot.toolPolicy,
    facts,
    triggerOverride: await endpointOverride(deps, run),
  });
  const source = runSource(run);
  return {
    evaluate: async (policyRun, toolName, args) => {
      const evaluation = asEvaluation(
        await policy.evaluate({ ...policyRun, source }, toolName, args),
      );
      if (evaluation.decision === 'deny') {
        await audit(deps.db, {
          workspaceId: run.workspaceId,
          actorType: 'bot',
          actorId: bot.id,
          action: 'tool.denied',
          targetType: 'run',
          targetId: run.id,
          metadata: { toolName, reason: evaluation.reason, trace: evaluation.trace },
        });
      }
      return evaluation;
    },
  };
}

/**
 * Who wrote what started the run (P2). A Routine run a webhook delivery
 * started acts on webhook data. A run the router started for a Bot's message
 * names that Bot (`fromBotId`); rows queued before that field existed show it
 * by their parent run, which only a Bot's message sets.
 */
export function runSource(run: Pick<RunRow, 'trigger' | 'state' | 'parentRunId'>): RunSource {
  const input = (run.state as RunState | null)?.input;
  if (input?.webhook) return 'webhook';
  if (input?.fromBotId || run.parentRunId) return 'bot';
  return sourceOfTrigger(run.trigger);
}

/** The override of the webhook endpoint whose delivery started the run, if any. */
async function endpointOverride(
  deps: Pick<AppDeps, 'db' | 'logger'>,
  run: RunRow,
): Promise<TriggerOverride | null> {
  const endpointId = (run.state as RunState | null)?.input?.webhook?.endpointId;
  if (!endpointId) return null;
  const [endpoint] = await deps.db
    .select({ override: schema.webhookEndpoints.toolPolicyOverride })
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, endpointId));
  if (!endpoint?.override) return null;
  const parsed = TriggerOverrideSchema.safeParse(endpoint.override);
  if (parsed.success) return parsed.data;
  // Stored through the API's schema, so this is a damaged row: ask for everything.
  deps.logger.warn({ endpointId }, 'webhook endpoint has an unreadable tool policy override');
  return { default: 'ask' };
}

/** A tool as Bot Settings lists it (T5), with the engine's default for it. */
export interface BotToolDefault extends DefaultSummary {
  /** The name the policy uses: `<connector>__<tool>` for an MCP tool. */
  name: string;
  group: ToolGroupName;
  /** The owner's connector that provides it: an MCP connector, or a built-in one like Email. */
  connectorId: string | null;
  /** Offered only once the owner adds its built-in connector (email, GitHub). */
  needsConnector: boolean;
  /** A workspace admin blocked it, or its connector (T3, U3). */
  disabledByAdmin: boolean;
}

/**
 * Every tool the Bot can have and the default the policy engine gives each
 * (T5): the built-in, conversation, Artifact and computer tools, then each
 * MCP connector's cached tools with its hints believed only when the
 * connector came from the catalog or an admin trusts it (S-16), as a run
 * would. Bot Settings shows these as each setting's Default.
 */
export async function botToolDefaults(
  deps: Pick<AppDeps, 'db' | 'config'>,
  viewer: { id: string; workspaceId: string },
  botId: string,
): Promise<BotToolDefault[]> {
  await assertBotOwner(deps.db, viewer, botId);
  const [bot] = await deps.db
    .select({ ownerId: schema.bots.ownerId, workspaceId: schema.bots.workspaceId })
    .from(schema.bots)
    .where(eq(schema.bots.id, botId));
  if (!bot) return [];
  const [connectors, rules, refusal] = await Promise.all([
    deps.db
      .select()
      .from(schema.connectors)
      .where(
        and(
          eq(schema.connectors.ownerId, bot.ownerId),
          eq(schema.connectors.workspaceId, bot.workspaceId),
        ),
      )
      .orderBy(asc(schema.connectors.createdAt)),
    blockRules(deps.db, bot.workspaceId),
    customStdioRefusal(deps, bot.workspaceId, bot.ownerId),
  ]);
  const blocked = new Set(blockedBuiltins(rules));
  const builtinRows = new Map<string, string>();
  for (const row of connectors) {
    if (row.kind !== 'builtin') continue;
    try {
      const { transport } = readConfig(row);
      if (transport.transport === 'builtin' && !builtinRows.has(transport.builtin)) {
        builtinRows.set(transport.builtin, row.id);
      }
    } catch {
      // An unreadable connector provides no tools.
    }
  }
  const out: BotToolDefault[] = everyToolDefault().map(({ builtin, ...tool }) => ({
    ...tool,
    connectorId: builtin ? (builtinRows.get(builtin) ?? null) : null,
    disabledByAdmin: builtin ? blocked.has(builtin) : false,
  }));

  const mcp = connectors.filter((c) => c.kind === 'mcp_stdio' || c.kind === 'mcp_http');
  if (!mcp.length) return out;
  const tools = await deps.db
    .select()
    .from(schema.connectorTools)
    .where(
      inArray(
        schema.connectorTools.connectorId,
        mcp.map((c) => c.id),
      ),
    )
    .orderBy(asc(schema.connectorTools.name));
  for (const connector of mcp) {
    const hintsTrusted = connector.catalogId !== null || connector.trusted;
    const disabledByAdmin =
      isBlocked(connector, rules) || Boolean(refusal && isCustomStdio(connector));
    for (const tool of tools) {
      if (tool.connectorId !== connector.id) continue;
      const name = `${connector.slug}__${tool.name}`;
      const facts: ToolFacts = {
        group: 'connector',
        annotations: tool.annotations as ToolAnnotations,
        connector: { slug: connector.slug, hintsTrusted },
      };
      out.push({
        name,
        group: 'connector',
        connectorId: connector.id,
        needsConnector: true,
        disabledByAdmin,
        ...defaultSummary(name, facts),
      });
    }
  }
  return out;
}
