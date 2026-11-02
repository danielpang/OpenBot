import {
  ConnectorNeedsLogin,
  type BuiltinConnector,
  type BuiltinServices,
  type ConnectorTools,
} from '@openbots/agent';
import { blockedBy, loadCatalog, toolPermitted, type BlockRule } from '@openbots/mcp';
import { PolicyDecisionSchema, resolveToolPolicy, wsEvent } from '@openbots/shared';
import type { EmailDraftState } from '@openbots/widgets';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { publishEvent } from '../infra/index.js';
import {
  blockRules,
  callToolForBot,
  connectorBlocked,
  discoverUntested,
  errorStatus,
  listToolsForBot,
  openSecrets,
  readConfig,
  recordError,
} from '../services/connectors.js';
import { emailSettings, imapInbox, sendEmail, type EmailOptions } from './email.js';
import { githubApi, type GithubOptions } from './github.js';
import type { NetOptions } from './net.js';
import { searchBackend, type SearchOptions } from './search.js';
import { fetchPage, httpRequest } from './web.js';

// The backends behind the agent's built-in tools (plan 5.4, 18.3) and the
// Bot's connector tools, assembled once per run. Built-in connectors (kind
// `builtin`, added from the catalog on the Connectors page) carry the secrets: the
// Brave or Tavily key, the mailbox, the GitHub token. They are opened here,
// lazily, and never reach the model. The Bot's `bot_connectors` rows narrow
// them like MCP connectors (allow and deny lists, approval override).

type BotRow = typeof schema.bots.$inferSelect;

/**
 * The built-ins (by their `builtin` id) the admin rules block or leave off the allow list.
 * Web fetch and HTTP request need no connector row, so the rules are checked against the
 * catalog entries themselves, the way the catalog's "Disabled by admin" is (T3, U3).
 */
export function blockedBuiltins(rules: BlockRule[]): string[] {
  return loadCatalog()
    .entries.filter((entry) => entry.builtin && blockedBy({ catalogId: entry.id }, rules))
    .map((entry) => entry.builtin!);
}
type BuiltinsDeps = Pick<AppDeps, 'db' | 'config' | 'logger'>;

export interface BuiltinOptions {
  net?: NetOptions;
  search?: SearchOptions;
  github?: GithubOptions;
  email?: EmailOptions;
}

export async function loadBuiltins(
  deps: BuiltinsDeps,
  bot: Pick<BotRow, 'id' | 'ownerId' | 'workspaceId' | 'toolPolicy'>,
  options: BuiltinOptions = {},
): Promise<BuiltinServices> {
  const [rows, permissions, rules] = await Promise.all([
    deps.db
      .select()
      .from(schema.connectors)
      .where(
        and(
          eq(schema.connectors.ownerId, bot.ownerId),
          eq(schema.connectors.workspaceId, bot.workspaceId),
          eq(schema.connectors.kind, 'builtin'),
        ),
      ),
    deps.db.select().from(schema.botConnectors).where(eq(schema.botConnectors.botId, bot.id)),
    blockRules(deps.db, bot.workspaceId),
  ]);
  const ruleFor = new Map(permissions.map((p) => [p.connectorId, p]));
  const blocked = blockedBuiltins(rules);
  const connectors: Record<string, BuiltinConnector> = {};
  const secretsOf = new Map<string, () => Record<string, string>>();
  const paramsOf = new Map<string, Record<string, string>>();
  for (const row of rows) {
    let stored;
    try {
      stored = readConfig(row);
    } catch {
      continue;
    }
    if (stored.transport.transport !== 'builtin') continue;
    const builtin = stored.transport.builtin;
    if (blocked.includes(builtin)) continue;
    if (blockedBy({ catalogId: row.catalogId, config: stored.transport }, rules)) continue;
    if (connectors[builtin]) continue;
    const rule = ruleFor.get(row.id);
    const override = PolicyDecisionSchema.safeParse(rule?.approvalOverride);
    connectors[builtin] = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      approvalOverride: override.success ? override.data : null,
      permits: (tool) => toolPermitted(tool, rule),
    };
    secretsOf.set(builtin, () => {
      try {
        return openSecrets(deps, row).values;
      } catch (error) {
        // An unreadable envelope leaves the connector unconfigured rather than failing the run.
        deps.logger.warn(
          { err: error, connectorId: row.id },
          'built-in connector secrets unreadable',
        );
        return {};
      }
    });
    paramsOf.set(builtin, stored.params);
  }

  const { processLimits } = deps.config;
  const allowlist = resolveToolPolicy(bot.toolPolicy).httpAllowlist;
  // Every hop of web_fetch and http_request stays on the allowlist (S-8), and
  // exact hosts on it may be private: the owner named them.
  const httpNet: NetOptions = {
    ...options.net,
    allowlist,
    privateHosts: (allowlist ?? []).filter((h) => !h.startsWith('*.')),
  };

  const searchKeys = secretsOf.get('web_search')?.() ?? {};
  const email = connectors.email
    ? emailSettings(paramsOf.get('email') ?? {}, secretsOf.get('email')!())
    : null;
  const githubToken = connectors.github ? secretsOf.get('github')!().GITHUB_TOKEN : undefined;
  if (connectors.email && !email) delete connectors.email;
  if (connectors.github && !githubToken) delete connectors.github;

  return {
    webSearch: searchBackend(searchKeys, options.search),
    // web_fetch waits OPENBOTS_WEB_FETCH_TIMEOUT_SECONDS and reads OPENBOTS_WEB_FETCH_MAX_CHARS.
    fetchPage: (url) =>
      fetchPage(url, { timeoutMs: processLimits.webFetchTimeoutSeconds * 1000, ...httpNet }),
    maxPageChars: processLimits.webFetchMaxChars,
    httpRequest: (request) => httpRequest(request, httpNet),
    httpAllowlist: allowlist,
    email: email
      ? {
          send: (message) => sendEmail(email, message, { ...options.email, net: options.net }),
          readInbox: (query) => (options.email?.readInbox ?? imapInbox)(email, query, options.net),
        }
      : null,
    github: githubToken ? githubApi(githubToken, connectors.github!, options.github) : null,
    file: async (fileId) => {
      const [file] = /^[0-9a-f-]{36}$/i.test(fileId)
        ? await deps.db
            .select()
            .from(schema.files)
            .where(
              and(
                eq(schema.files.id, fileId),
                eq(schema.files.ownerId, bot.ownerId),
                eq(schema.files.workspaceId, bot.workspaceId),
                // Only chat attachments: never an Artifact blob, webhook body or avatar.
                eq(schema.files.purpose, 'attachment'),
              ),
            )
        : [];
      if (!file) throw new Error(`No stored file ${fileId}`);
      return { file_id: file.id, name: file.name, mime: file.mime, size: file.size };
    },
    connectors,
    blocked,
    // An admin may block a built-in while a run is going: the call reads the rules again.
    assertNotBlocked: async (builtin) => {
      const current = await blockRules(deps.db, bot.workspaceId);
      if (blockedBuiltins(current).includes(builtin)) throw connectorBlocked();
    },
  };
}

/**
 * The Bot's permitted MCP tools and the call through the manager; a login error blocks the Bot.
 * Connectors that have not listed their tools since they were saved start first (plan 8).
 */
export async function connectorToolsFor(
  deps: BuiltinsDeps,
  botId: string,
  signal?: AbortSignal,
): Promise<ConnectorTools> {
  await discoverUntested(deps, botId);
  const entries = await listToolsForBot(deps, botId);
  return {
    entries,
    call: async (entry, args) => {
      try {
        return await callToolForBot(deps, botId, entry.connectorSlug, entry.tool, args, {
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (error instanceof Error && errorStatus(error) === 'needs_auth') {
          await recordError(deps, entry.connectorId, error);
          throw new ConnectorNeedsLogin(entry.connectorId, entry.connectorName);
        }
        throw error;
      }
    },
  };
}

/**
 * After the send an email draft asked for (W2): the widget reads `sent` or
 * `failed`, or `draft` again when the owner denied the send.
 */
export async function settleEmailDraft(
  deps: Pick<AppDeps, 'db' | 'infra'>,
  widget: { messageId: string; partIndex: number },
  outcome: { sent: boolean; denied?: boolean },
) {
  const [message] = await deps.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, widget.messageId));
  if (!message) return;
  const [current] = await deps.db
    .select()
    .from(schema.widgetStates)
    .where(
      and(
        eq(schema.widgetStates.messageId, widget.messageId),
        eq(schema.widgetStates.partIndex, widget.partIndex),
      ),
    );
  const previous = (current?.state ?? {}) as EmailDraftState;
  const state: EmailDraftState = {
    ...previous,
    status: outcome.sent ? 'sent' : outcome.denied ? 'draft' : 'failed',
  };
  const updatedAt = new Date();
  await deps.db
    .insert(schema.widgetStates)
    .values({
      workspaceId: message.workspaceId,
      messageId: widget.messageId,
      partIndex: widget.partIndex,
      state: state as object,
      pendingRunId: null,
    })
    .onConflictDoUpdate({
      target: [schema.widgetStates.messageId, schema.widgetStates.partIndex],
      set: { state: state as object, updatedAt },
    });
  await publishEvent(
    deps.infra.bus,
    wsEvent(
      'widget.updated',
      {
        widget: {
          messageId: widget.messageId,
          partIndex: widget.partIndex,
          state,
          pendingRunId: current?.pendingRunId ?? null,
        },
      },
      {
        chat_id: message.chatId,
        seq: message.seq,
        ...(message.authorType === 'bot' && message.authorId ? { bot_id: message.authorId } : {}),
      },
    ),
  );
}
