import { createRoute, z } from '@hono/zod-openapi';
import {
  ApprovalOverrideSchema,
  ConnectorKindSchema,
  ConnectorStatusSchema,
  HttpAuthSchema,
  ImportError,
  OAuthModeSchema,
} from '@openbots/mcp';
import { PolicyDecisionSchema, ToolGroupNameSchema } from '@openbots/shared';
import { authenticateHeaders, requireAdmin, requireUser } from '../middleware/auth.js';
import { renderOAuthPage } from '../oauth-page.js';
import { DomainError } from '../errors.js';
import {
  adminProblems,
  authenticated,
  authProblems,
  createRouter,
  problemResponse,
} from '../openapi.js';
import {
  DISABLED_BY_ADMIN,
  catalogWithPolicy,
  completeConnectorOAuth,
  createConnector,
  deleteConnector,
  discoverConnectorUrl,
  getBotConnectors,
  getConnectorPolicy,
  importConnectors,
  listConnectorTools,
  listConnectors,
  oauthRedirectUrl,
  githubInstallationUrl,
  pollConnectorDevice,
  putBotConnectors,
  putConnectorPolicy,
  setConnectorLocal,
  setConnectorTrusted,
  startConnectorOAuth,
  testConnector,
  updateConnector,
  type ConnectorRecord,
  type ConnectorToolRow,
} from '../services/connectors.js';
import { botToolDefaults } from '../services/policy.js';

// Connectors and MCP (T1 to T3; plan 8, 14.1). Connectors are the caller's
// own; another user's answers 404. Secret values are write-only: responses
// list secret names with `set: true | false` and never a value (P3); env and
// header values are secrets too, so only their names come back (S-9). Admins
// manage the block and allow lists; blocked connectors read
// `disabledByAdmin: true`, shown as "Disabled by admin" (T3, U3). Custom
// stdio servers are for admins only, once the workspace turns them on (S-1).
// Only admins mark a connector's MCP hints trusted (S-16), or an HTTP
// connector as on their own network (S-8).

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const SecretStateSchema = z
  .object({
    name: z.string(),
    label: z.string().nullable(),
    required: z.boolean(),
    set: z
      .boolean()
      .openapi({ description: 'Whether a value is stored; values are never returned' }),
  })
  .openapi('ConnectorSecretState');

const ConnectorSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string().openapi({ description: 'Prefix of agent tool names: `<slug>__<tool>`' }),
    kind: ConnectorKindSchema,
    catalogId: z.string().nullable(),
    transport: z.enum(['stdio', 'http', 'builtin']),
    command: z.string().nullable(),
    args: z.array(z.string()).nullable(),
    env: z.array(z.string()).nullable().openapi({
      description:
        'Names of the environment variables a stdio server gets; the values are sealed and never returned',
    }),
    url: z.string().nullable(),
    auth: HttpAuthSchema.nullable(),
    headers: z.array(z.string()).nullable().openapi({
      description:
        'Names of the headers an HTTP server gets; the values are sealed and never returned',
    }),
    builtin: z.string().nullable(),
    params: z.record(z.string(), z.string()),
    secrets: z.array(SecretStateSchema),
    oauth: z
      .object({
        clientConfigured: z.boolean(),
        connected: z.boolean(),
        expiresAt: z.iso.datetime().nullable(),
        installationUrl: z.url().optional(),
      })
      .nullable()
      .openapi({ description: 'Present when the connector signs in with OAuth' }),
    status: ConnectorStatusSchema,
    lastError: z.string().nullable(),
    lastCheckedAt: z.iso.datetime().nullable(),
    disabledByAdmin: z
      .boolean()
      .openapi({ description: `Blocked by a workspace admin; show "${DISABLED_BY_ADMIN}" (T3)` }),
    trusted: z.boolean().openapi({
      description:
        'An admin trusts its MCP hints, so read-only tools run without asking (S-16); catalog connectors are trusted without it',
    }),
    local: z.boolean().openapi({
      description:
        'An admin marked the HTTP server as on their own network, so it may be on a private or local address (S-8)',
    }),
    toolCount: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Connector');

const ConnectorToolSchema = z
  .object({
    name: z.string(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    inputSchema: z.record(z.string(), z.unknown()),
    annotations: z.record(z.string(), z.unknown()).openapi({
      description: 'MCP hints: readOnlyHint, destructiveHint, idempotentHint, openWorldHint',
    }),
    lastSeenAt: z.iso.datetime(),
  })
  .openapi('ConnectorTool');

const CatalogEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    kind: ConnectorKindSchema,
    icon: z.string(),
    homepage: z.string().nullable(),
    version: z.string().nullable().openapi({ description: 'Pinned package version' }),
    runtime: z.enum(['node', 'python']).nullable(),
    command: z.string().nullable(),
    args: z.array(z.string()).nullable(),
    url: z.string().nullable(),
    auth: z.array(HttpAuthSchema),
    builtin: z.string().nullable(),
    params: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        description: z.string().nullable(),
        required: z.boolean(),
      }),
    ),
    secrets: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        description: z.string().nullable(),
        required: z.boolean(),
      }),
    ),
    oauth: z
      .object({
        scopes: z.array(z.string()),
        dynamicRegistration: z.boolean(),
        deviceFlow: z.boolean().optional().openapi({
          description: 'Shared GitHub device authorization is configured; no client secret needed',
        }),
        clientSetupUrl: z.string().nullable(),
        installationUrl: z.url().optional(),
      })
      .nullable(),
    disabledByAdmin: z.boolean(),
  })
  .openapi('ConnectorCatalogEntry');

const SecretsInput = z
  .record(z.string().regex(ENV_NAME), z.string().min(1).max(8192))
  .openapi({ description: 'Secret values by name; stored encrypted and never returned' });

const OAuthClientInput = z
  .strictObject({
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(4096).optional(),
    githubAppSlug: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
      .max(100)
      .optional(),
  })
  .openapi('OAuthClientInput', {
    description: 'For servers without dynamic client registration (GitHub, Slack)',
  });

const CreateConnectorSchema = z
  .strictObject({
    catalogId: z
      .string()
      .optional()
      .openapi({ description: 'Add from the catalog; command and URL come from the entry' }),
    name: z.string().trim().min(1).max(80).optional(),
    slug: z.string().regex(SLUG).optional(),
    transport: z.enum(['stdio', 'http']).optional(),
    command: z.string().min(1).max(512).optional(),
    args: z.array(z.string().max(4096)).max(64).optional(),
    env: z
      .record(z.string().regex(ENV_NAME), z.string().max(4096))
      .optional()
      .openapi({ description: 'Environment of a custom stdio server; stored encrypted' }),
    url: z.url().optional(),
    auth: HttpAuthSchema.optional(),
    headers: z
      .record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().max(4096))
      .optional()
      .openapi({ description: 'Request headers of a custom HTTP server; stored encrypted' }),
    params: z.record(z.string().regex(ENV_NAME), z.string().max(4096)).optional(),
    secrets: SecretsInput.optional(),
    oauthClient: OAuthClientInput.optional(),
  })
  .openapi('CreateConnector');

const UpdateConnectorSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80).optional(),
    command: z.string().min(1).max(512).optional(),
    args: z.array(z.string().max(4096)).max(64).optional(),
    env: z.record(z.string().regex(ENV_NAME), z.string().max(4096)).optional().openapi({
      description:
        'Sets these environment variables (stored encrypted); others are kept. Remove one with `secrets: {NAME: null}`',
    }),
    url: z.url().optional(),
    auth: HttpAuthSchema.optional(),
    headers: z
      .record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().max(4096))
      .optional()
      .openapi({ description: 'Sets these headers (stored encrypted); others are kept' }),
    params: z.record(z.string().regex(ENV_NAME), z.string().max(4096)).optional(),
    secrets: z
      .record(z.string().regex(ENV_NAME), z.string().min(1).max(8192).nullable())
      .optional()
      .openapi({
        description: 'A value sets a secret, null removes it; unlisted secrets are kept',
      }),
    oauthClient: OAuthClientInput.nullable().optional(),
  })
  .openapi('UpdateConnector');

const policyFields = {
  catalogIds: z.array(z.string()).max(200).openapi({ description: 'Blocked catalog entries' }),
  urlPatterns: z
    .array(z.string().min(1).max(512))
    .max(200)
    .openapi({
      description:
        'Blocked globs (`*` matches anything) tested against HTTP URLs and hosts and stdio command lines',
      example: ['https://*.example.com/*'],
    }),
};
const allowedCatalogIds = z.array(z.string()).max(200).openapi({
  description:
    'The allow list (U3): when non-empty, only these catalog entries can be added or used, and custom servers cannot',
});

const PolicySchema = z.object({ ...policyFields, allowedCatalogIds }).openapi('ConnectorPolicy');

const PolicyInputSchema = z
  .strictObject({
    ...policyFields,
    allowedCatalogIds: allowedCatalogIds.optional().openapi({
      description: 'The allow list (U3); left out, it stays as it is',
    }),
  })
  .openapi('ConnectorPolicyInput');

export const BotConnectorSchema = z
  .object({
    connectorId: z.uuid(),
    toolAllowlist: z
      .array(z.string())
      .nullable()
      .openapi({ description: 'Null allows every tool; [] allows none' }),
    toolDenylist: z.array(z.string()),
    approvalOverride: ApprovalOverrideSchema.nullable().openapi({
      description: 'Forces a decision for every tool of this connector; null keeps the policy',
    }),
  })
  .openapi('BotConnectorPermission');

const BotConnectorEntrySchema = z
  .object({
    connector: ConnectorSchema,
    permission: BotConnectorSchema,
    customized: z
      .boolean()
      .openapi({ description: 'False means the defaults: every tool, policy approvals' }),
  })
  .openapi('BotConnector');

const BotToolSchema = z
  .object({
    name: z
      .string()
      .openapi({ description: 'The name in `tool_policy.tools`: `<connector>__<tool>` for MCP' }),
    group: ToolGroupNameSchema,
    connectorId: z.uuid().nullable().openapi({
      description: "The owner's connector that provides it (MCP or built-in), if any",
    }),
    needsConnector: z
      .boolean()
      .openapi({ description: 'Offered only while its connector is added (email, GitHub, MCP)' }),
    disabledByAdmin: z.boolean().openapi({ description: `Blocked by a workspace admin (T3)` }),
    decision: PolicyDecisionSchema,
    why: z.string().openapi({ description: 'Why the engine decides so, for the owner' }),
    byArguments: z.boolean().openapi({
      description:
        "The default depends on the call's arguments: `why` says how, `decision` is the stricter",
    }),
  })
  .openapi('BotTool');

const iso = (date: Date | null) => (date ? new Date(date).toISOString() : null);

function toConnector(r: ConnectorRecord): z.infer<typeof ConnectorSchema> {
  const c = r.config;
  return {
    id: r.row.id,
    name: r.row.name,
    slug: r.row.slug,
    kind: r.row.kind,
    catalogId: r.row.catalogId,
    transport: c.transport,
    command: c.transport === 'stdio' ? c.command : null,
    args: c.transport === 'stdio' ? c.args : null,
    env: r.env,
    url: c.transport === 'http' ? c.url : null,
    auth: c.transport === 'http' ? c.auth : null,
    headers: r.headers,
    builtin: c.transport === 'builtin' ? c.builtin : null,
    params: r.params,
    secrets: r.secrets,
    oauth: r.oauth ? { ...r.oauth, expiresAt: iso(r.oauth.expiresAt) } : null,
    status: ConnectorStatusSchema.catch('untested').parse(r.row.status),
    lastError: r.row.lastError,
    lastCheckedAt: iso(r.row.lastCheckedAt),
    disabledByAdmin: r.disabledByAdmin,
    trusted: r.row.trusted,
    local: r.row.local,
    toolCount: r.toolCount,
    createdAt: iso(r.row.createdAt)!,
    updatedAt: iso(r.row.updatedAt)!,
  };
}

const toTool = (t: ConnectorToolRow): z.infer<typeof ConnectorToolSchema> => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.inputSchema as Record<string, unknown>,
  annotations: t.annotations as Record<string, unknown>,
  lastSeenAt: iso(t.lastSeenAt)!,
});

const params = z.object({ id: z.uuid() });
const notFoundProblem = { 404: problemResponse('No such connector') };
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const connectorResponse = (description: string) => json(ConnectorSchema, description);
const html = (description: string) => ({
  description,
  content: { 'text/html': { schema: z.string() } },
});

export const connectorRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/connectors/catalog',
      tags: ['connectors'],
      summary: 'One-click connectors and built-ins, with the admin block flags (T2, T3)',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: json(
          z.object({
            items: z.array(CatalogEntrySchema),
            oauthCallbackUrl: z.url().openapi({
              description:
                'The redirect URL an OAuth app made by hand must allow (from `OPENBOTS_PUBLIC_URL`)',
            }),
          }),
          'Catalog entries',
        ),
        ...authProblems,
      },
    }),
    async (c) => {
      const entries = await catalogWithPolicy(c.var.deps.db, c.var.user);
      return c.json(
        {
          items: entries.map(({ entry: e, disabledByAdmin }) => ({
            id: e.id,
            name: e.name,
            description: e.description,
            kind: e.kind,
            icon: e.icon,
            homepage: e.homepage ?? null,
            version: e.version,
            runtime: e.runtime ?? null,
            command: e.stdio?.command ?? null,
            args: e.stdio?.args ?? null,
            url: e.http?.url ?? null,
            auth: e.http?.auth ?? [],
            builtin: e.builtin ?? null,
            params: (e.params ?? []).map((p) => ({ ...p, description: p.description ?? null })),
            secrets: e.secrets.map((s) => ({ ...s, description: s.description ?? null })),
            oauth: e.oauth
              ? {
                  scopes: e.oauth.scopes,
                  dynamicRegistration: e.oauth.dynamic_registration,
                  ...(e.id === 'github' &&
                  c.var.deps.config.githubConnectorClientId &&
                  c.var.deps.config.githubConnectorAppSlug
                    ? {
                        deviceFlow: true,
                        installationUrl: githubInstallationUrl(
                          c.var.deps.config.githubConnectorAppSlug,
                        ),
                      }
                    : {}),
                  clientSetupUrl: e.oauth.client_setup_url ?? null,
                }
              : null,
            disabledByAdmin,
          })),
          oauthCallbackUrl: oauthRedirectUrl(c.var.deps),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/connectors',
      tags: ['connectors'],
      summary: "The caller's connectors (T1)",
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: json(z.object({ items: z.array(ConnectorSchema) }), 'Connectors, oldest first'),
        ...authProblems,
      },
    }),
    async (c) => {
      const records = await listConnectors(c.var.deps, c.var.user);
      return c.json({ items: records.map(toConnector) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/connectors',
      tags: ['connectors'],
      summary: 'Add a connector from the catalog or the custom form',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: CreateConnectorSchema } },
        },
      },
      responses: {
        201: connectorResponse('The new connector, `untested`'),
        400: problemResponse(
          'Invalid connector or missing secret; a path outside your directory (`INVALID_PATH`) or a private database host (`PRIVATE_HOST`)',
        ),
        403: problemResponse(
          `${DISABLED_BY_ADMIN} (\`CONNECTOR_BLOCKED\`); a custom stdio server from a member (\`CUSTOM_STDIO_ADMIN_ONLY\`) or while they are off (\`CUSTOM_STDIO_DISABLED\`)`,
        ),
        409: problemResponse('Slug taken (`SLUG_TAKEN`)'),
        ...authProblems,
      },
    }),
    async (c) => {
      const record = await createConnector(c.var.deps, c.var.user, c.req.valid('json'));
      return c.json(toConnector(record), 201);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/connectors/import',
      tags: ['connectors'],
      summary: 'Import pasted `{"mcpServers": {...}}` JSON (T2)',
      description:
        'Creates one connector per server. Env values and headers are stored as secrets. Servers that cannot be imported (unknown shape, legacy SSE, blocked, or a custom stdio server from anyone but an admin with custom stdio turned on) are listed in `errors` with the reason; the rest are still created. A stdio server that matches a catalog entry is not custom: it runs the pinned command of that entry, so members may paste it.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z
                .object({ mcpServers: z.record(z.string(), z.unknown()) })
                .passthrough()
                .openapi('ImportConnectors'),
            },
          },
        },
      },
      responses: {
        200: json(
          z.object({
            items: z.array(ConnectorSchema),
            errors: z.array(z.object({ name: z.string(), message: z.string() })),
          }),
          'Created connectors and per-server errors',
        ),
        400: problemResponse('Not an mcpServers document (`INVALID_IMPORT`)'),
        ...authProblems,
      },
    }),
    async (c) => {
      let result;
      try {
        result = await importConnectors(c.var.deps, c.var.user, c.req.valid('json'));
      } catch (err) {
        if (err instanceof ImportError) throw new DomainError(400, 'INVALID_IMPORT', err.message);
        throw err;
      }
      return c.json({ items: result.created.map(toConnector), errors: result.errors }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/connectors/{id}',
      tags: ['connectors'],
      summary: 'Rename, change settings, set or remove secrets',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params,
        body: {
          required: true,
          content: { 'application/json': { schema: UpdateConnectorSchema } },
        },
      },
      responses: {
        200: connectorResponse('The updated connector; its session restarts on next use'),
        400: problemResponse(
          'Invalid change (`PINNED` for catalog command or URL, `INVALID_PATH`, `PRIVATE_HOST`)',
        ),
        403: problemResponse(
          `${DISABLED_BY_ADMIN} (\`CONNECTOR_BLOCKED\`), or a custom stdio server you may not run (\`CUSTOM_STDIO_ADMIN_ONLY\`, \`CUSTOM_STDIO_DISABLED\`)`,
        ),
        ...notFoundProblem,
        ...authProblems,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const record = await updateConnector(c.var.deps, c.var.user, id, c.req.valid('json'));
      return c.json(toConnector(record), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/connectors/{id}',
      tags: ['connectors'],
      summary: 'Delete a connector, its tools and its per-Bot settings',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: { 204: { description: 'Deleted' }, ...notFoundProblem, ...authProblems },
    }),
    async (c) => {
      await deleteConnector(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: 'put',
      path: '/connectors/{id}/trusted',
      tags: ['connectors'],
      summary: "Trust a connector's MCP hints, or stop trusting them (S-16)",
      description:
        "Admins only, for any connector of the workspace. Trusted, a tool's `readOnlyHint` lets it run without asking; changing the connector's command or URL clears it.",
      middleware: [requireAdmin] as const,
      security: authenticated,
      request: {
        params,
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z.strictObject({ trusted: z.boolean() }).openapi('SetConnectorTrusted'),
            },
          },
        },
      },
      responses: {
        200: connectorResponse('The connector after the change'),
        ...notFoundProblem,
        ...adminProblems,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const { trusted } = c.req.valid('json');
      const record = await setConnectorTrusted(c.var.deps, c.var.user, id, trusted);
      return c.json(toConnector(record), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'put',
      path: '/connectors/{id}/local',
      tags: ['connectors'],
      summary: 'Mark an HTTP connector as on your own network, or not (S-8)',
      description:
        "Admins only, for any HTTP connector of the workspace. Marked, its MCP session and OAuth requests may reach private and local addresses (a server on the host or the compose network); otherwise they are refused. Changing the connector's URL clears it. Other connectors get 400 `NOT_HTTP`.",
      middleware: [requireAdmin] as const,
      security: authenticated,
      request: {
        params,
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z.strictObject({ local: z.boolean() }).openapi('SetConnectorLocal'),
            },
          },
        },
      },
      responses: {
        200: connectorResponse('The connector after the change'),
        400: problemResponse('Not an HTTP connector (`NOT_HTTP`)'),
        ...notFoundProblem,
        ...adminProblems,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const { local } = c.req.valid('json');
      const record = await setConnectorLocal(c.var.deps, c.var.user, id, local);
      return c.json(toConnector(record), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/connectors/{id}/test',
      tags: ['connectors'],
      summary: 'Connect, list tools, store status and last error',
      description:
        'A server that fails to start or answer is reported in `status` and `lastError`, not as an error response.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: json(
          z.object({ connector: ConnectorSchema, tools: z.array(ConnectorToolSchema) }),
          'The connector with its new status and tool list',
        ),
        400: problemResponse('Built-ins have no MCP session (`NOT_AN_MCP_SERVER`)'),
        403: problemResponse(
          `${DISABLED_BY_ADMIN} (\`CONNECTOR_BLOCKED\`), or a custom stdio server you may not run (\`CUSTOM_STDIO_ADMIN_ONLY\`, \`CUSTOM_STDIO_DISABLED\`)`,
        ),
        ...notFoundProblem,
        ...authProblems,
      },
    }),
    async (c) => {
      const { record, tools } = await testConnector(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
      );
      return c.json({ connector: toConnector(record), tools: tools.map(toTool) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/connectors/{id}/tools',
      tags: ['connectors'],
      summary: 'The cached tool list',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: json(z.object({ items: z.array(ConnectorToolSchema) }), 'Tools by name'),
        ...notFoundProblem,
        ...authProblems,
      },
    }),
    async (c) => {
      const rows = await listConnectorTools(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.json({ items: rows.map(toTool) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/connectors/discover',
      tags: ['connectors'],
      summary: 'Check how a pasted MCP server URL signs in, before adding it',
      description:
        'Sends the server an unauthenticated `initialize` and follows RFC 9728 and RFC 8414: `none` when it answers without a token, `oauth` when it names an authorization server (`dynamicRegistration` when that server registers clients itself, so no client id is needed), `bearer` when it refuses without naming one. A server the probe cannot reach (a private address, S-8) reads `reachable: false` and is added as is.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z.strictObject({ url: z.url() }).openapi('DiscoverConnector'),
            },
          },
        },
      },
      responses: {
        200: json(
          z
            .object({
              auth: HttpAuthSchema,
              dynamicRegistration: z.boolean(),
              reachable: z.boolean(),
              message: z.string().nullable(),
              oauthCallbackUrl: z.url().openapi({
                description: 'The redirect URL to register when the server needs a client id',
              }),
            })
            .openapi('ConnectorDiscovery'),
          'How the server signs in',
        ),
        403: problemResponse(`${DISABLED_BY_ADMIN} (\`CONNECTOR_BLOCKED\`)`),
        ...authProblems,
      },
    }),
    async (c) => {
      const found = await discoverConnectorUrl(c.var.deps, c.var.user, c.req.valid('json').url);
      return c.json({ ...found, oauthCallbackUrl: oauthRedirectUrl(c.var.deps) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/connectors/{id}/oauth/start',
      tags: ['connectors'],
      summary: 'Begin an OAuth 2.1 sign-in (PKCE, dynamic registration when offered)',
      description:
        'Answers with the authorization URL to open. GitHub device flow also returns a user code to display and polling instructions; poll the authenticated device endpoint until complete. Device flow does not use a callback. Otherwise, after consent the provider redirects to `GET /api/v1/connectors/oauth/callback` on `OPENBOTS_PUBLIC_URL`. `mode` says where the URL is opened: `popup` (a window of the web app; the callback page tells its opener and closes), `external` (the default browser, from the Mac app; the callback page links back to the app) or `redirect` (this tab; the callback redirects to the Connectors page, the default).',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params, query: z.object({ mode: OAuthModeSchema.optional() }) },
      responses: {
        200: json(
          z
            .object({
              authorizationUrl: z.url(),
              device: z
                .object({
                  userCode: z.string(),
                  verificationUrl: z.url(),
                  installationUrl: z.url(),
                  expiresAt: z.iso.datetime(),
                  interval: z.number().int().positive(),
                })
                .optional(),
            })
            .openapi('OAuthStart'),
          'Where to send the browser',
        ),
        400: problemResponse(
          'Not an OAuth connector, or a client id is needed (`OAUTH_CLIENT_REQUIRED`)',
        ),
        403: problemResponse(`${DISABLED_BY_ADMIN} (\`CONNECTOR_BLOCKED\`)`),
        502: problemResponse('The authorization server failed'),
        ...notFoundProblem,
        ...authProblems,
      },
    }),
    async (c) => {
      const result = await startConnectorOAuth(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('query').mode,
      );
      c.header('cache-control', 'no-store');
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/connectors/{id}/oauth/device',
      tags: ['connectors'],
      summary: 'Poll GitHub device authorization without exposing its device code or token',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: json(
          z
            .discriminatedUnion('status', [
              z.object({ status: z.literal('pending'), interval: z.number().int().positive() }),
              z.object({ status: z.literal('connected') }),
              z.object({ status: z.literal('error'), message: z.string() }),
            ])
            .openapi('OAuthDevicePoll'),
          'Authorization status',
        ),
        400: problemResponse('No device authorization is pending, or the connector changed'),
        403: problemResponse('Connector blocked by policy'),
        ...notFoundProblem,
        ...authProblems,
      },
    }),
    async (c) => {
      c.header('cache-control', 'no-store');
      return c.json(
        await pollConnectorDevice(c.var.deps, c.var.user, c.req.valid('param').id),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/connectors/oauth/callback',
      tags: ['connectors'],
      summary: 'OAuth redirect target; stores tokens and says the connector is connected',
      description:
        "The state names the connector and carries a single-use nonce, valid for 10 minutes, that only the user who started the flow got. The session of that user is required, except for an `external` flow (the Mac app's default browser) on a self-hosted install, whose one owner is the only one who can start a flow; a session for another user is always refused. Answers a small HTML page (`popup` and `external` flows, and any state that does not check out) or, for a `redirect` flow, a redirect to the Connectors page. The page sends no referrer, is never cached and runs only its own nonce'd script.",
      request: {
        query: z.object({
          state: z.string().optional(),
          code: z.string().optional(),
          error: z.string().optional(),
          error_description: z.string().optional(),
        }),
      },
      responses: {
        200: html('Connected: "<name> is connected. You can close this window."'),
        302: {
          description:
            'A `redirect` flow: to `/connectors?connector=<id>&oauth=connected`, or `oauth=error&message=...`',
        },
        400: html('Unknown, reused or expired state, or the provider refused'),
        401: html('Not signed in: "Sign in to OpenBots in this browser, then try again."'),
        403: html('Started by another user than the one signed in'),
        502: html('The token exchange failed'),
      },
    }),
    async (c) => {
      const query = c.req.valid('query');
      const deps = c.var.deps;
      const viewer = await authenticateHeaders(deps, c.req.raw.headers).catch(() => null);
      const outcome = await completeConnectorOAuth(deps, viewer, query);
      const base = deps.config.publicUrl.replace(/\/+$/, '');
      if (outcome.mode === 'redirect' && outcome.connectorId) {
        const target = new URL(`${base}/connectors`);
        target.searchParams.set('connector', outcome.connectorId);
        target.searchParams.set('oauth', outcome.ok ? 'connected' : 'error');
        if (!outcome.ok && outcome.message) target.searchParams.set('message', outcome.message);
        c.header('referrer-policy', 'no-referrer');
        c.header('cache-control', 'no-store');
        return c.redirect(target.toString(), 302);
      }
      const page = renderOAuthPage({
        ok: outcome.ok,
        name: outcome.name,
        reason: outcome.message,
        connectorId: outcome.connectorId,
        mode: outcome.mode,
        publicUrl: deps.config.publicUrl,
      });
      return c.body(page.html, outcome.status, page.headers);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/connector-policy',
      tags: ['connectors'],
      summary: 'The admin block and allow lists (T3, U3)',
      middleware: [requireAdmin] as const,
      security: authenticated,
      responses: {
        200: json(PolicySchema, 'Blocked catalog ids and URL patterns, and allowed catalog ids'),
        ...adminProblems,
      },
    }),
    async (c) => c.json(await getConnectorPolicy(c.var.deps.db, c.var.user), 200),
  )
  .openapi(
    createRoute({
      method: 'put',
      path: '/connector-policy',
      tags: ['connectors'],
      summary: 'Replace the admin block and allow lists (T3, U3)',
      description: 'Running sessions of connectors the new lists block are stopped.',
      middleware: [requireAdmin] as const,
      security: authenticated,
      request: {
        body: { required: true, content: { 'application/json': { schema: PolicyInputSchema } } },
      },
      responses: {
        200: json(PolicySchema, 'The lists after the change'),
        400: problemResponse(
          'Unknown catalog id, or one both blocked and allowed (`POLICY_CONFLICT`)',
        ),
        ...adminProblems,
      },
    }),
    async (c) => {
      const policy = await putConnectorPolicy(c.var.deps, c.var.user, c.req.valid('json'));
      return c.json(policy, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/bots/{id}/connectors',
      tags: ['connectors'],
      summary: "Which of the owner's connectors and tools this Bot may use (T1)",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: json(
          z.object({ items: z.array(BotConnectorEntrySchema) }),
          'Every connector of the owner',
        ),
        404: problemResponse('No such Bot'),
        ...authProblems,
      },
    }),
    async (c) => {
      const items = await getBotConnectors(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json(
        {
          items: items.map((i) => ({
            connector: toConnector(i.record),
            permission: i.permission,
            customized: i.customized,
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/bots/{id}/tools',
      tags: ['connectors'],
      summary: "Every tool the Bot can have, with the policy engine's default for each (T5)",
      description:
        'Built-in, conversation, Artifact and computer tools, then the cached tools of every connector of the owner. Bot Settings shows `decision` as the Default of each setting.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: json(
          z.object({ items: z.array(BotToolSchema) }),
          'Tools in the order a run offers them',
        ),
        404: problemResponse('No such Bot'),
        ...authProblems,
      },
    }),
    async (c) => {
      const items = await botToolDefaults(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'put',
      path: '/bots/{id}/connectors',
      tags: ['connectors'],
      summary: "Replace the Bot's allow lists, deny lists and approval overrides",
      description: 'Connectors left out go back to the defaults: every tool, policy approvals.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params,
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z
                .strictObject({ items: z.array(BotConnectorSchema).max(500) })
                .openapi('PutBotConnectors'),
            },
          },
        },
      },
      responses: {
        200: json(
          z.object({ items: z.array(BotConnectorEntrySchema) }),
          'The settings after the change',
        ),
        400: problemResponse('Invalid permissions'),
        404: problemResponse('No such Bot or connector'),
        ...authProblems,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const items = await putBotConnectors(c.var.deps, c.var.user, id, c.req.valid('json').items);
      return c.json(
        {
          items: items.map((i) => ({
            connector: toConnector(i.record),
            permission: i.permission,
            customized: i.customized,
          })),
        },
        200,
      );
    },
  );
