import { createRoute, z } from '@hono/zod-openapi';
import { loadCatalog } from '@openbots/models';
import {
  botModelNeeds,
  ModelCapabilitiesSchema,
  ModelConfigSchema,
  ModelNeedSchema,
  ModelPricingSchema,
  ModelSourceSchema,
  ProviderDiscoverySchema,
  ProviderKindSchema,
  ProviderProtocolSchema,
  ProviderStatusSchema,
  ProviderTestResultSchema,
} from '@openbots/shared';
import type { Context } from 'hono';
import type { AppEnv, CurrentUser } from '../context.js';
import { forbidden } from '../errors.js';
import { requireUser } from '../middleware/auth.js';
import { isOrgAdmin } from '../workspace.js';
import {
  adminProblems,
  authenticated,
  authProblems,
  createRouter,
  problemResponse,
} from '../openapi.js';
import { getBot } from '../services/bots.js';
import { computerAvailable } from '../services/computer.js';
import {
  capabilitiesOf,
  createProvider,
  defaultModelConfig,
  deleteProvider,
  discoverProviderModels,
  getProvider,
  listProviderModels,
  listProviders,
  modelsByProvider,
  pricingOf,
  testProvider,
  headerNames,
  testResultOf,
  updateProvider,
  upsertProviderModels,
  type ProviderModelRow,
  type ProviderRecord,
  type ProviderRow,
} from '../services/providers.js';

// Models and providers (L1 to L6; plan 5.9, 14.1, 21.4). Providers come at
// two levels: the organization's, which owners and admins add and change and
// every member's Bots may use, and a member's own (`scope: account`), which
// only they see and change and which come first for their Bots. A
// self-hosted install has one list, its owner's organization providers.
// API keys are write-only: responses say `hasKey`, and whoever may change the
// provider also gets `keyHint`, the vendor prefix and last four characters
// (P3). Extra headers come back by name only (S-9).

// Shared schemas may be built before @hono/zod-openapi extends zod, so the
// named components are rebuilt from their shapes here.
const CapabilitiesSchema = z.object(ModelCapabilitiesSchema.shape).openapi('ModelCapabilities');
const PricingSchema = z.object(ModelPricingSchema.shape).openapi('ModelPricing', {
  description: 'US dollars per 1M tokens',
});
const TestResultSchema = z.object(ProviderTestResultSchema.shape).openapi('ProviderTestResult');

const ProviderSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    kind: ProviderKindSchema,
    protocol: ProviderProtocolSchema,
    baseUrl: z.string().nullable().openapi({
      description: "Null for built-ins on their SDK's default endpoint",
    }),
    local: z.boolean().openapi({
      description: 'Marked by an admin as on their own network, so the base URL may be private',
    }),
    headers: z.array(z.string()).openapi({
      description: 'Names of the extra request headers; the values are sealed and never returned',
    }),
    hasKey: z
      .boolean()
      .openapi({ description: 'Whether an API key is stored; the key is never returned' }),
    keyHint: z.string().nullable().openapi({
      description:
        'The stored key\'s known vendor prefix and last four characters, never more than half of the key ("…" and the last two for a short key), so keys can be told apart. Only admins, and the owner of an account provider, get it; null for everyone else, without a key, and for a key under 8 characters',
      example: 'sk-ant-…a1b2',
    }),
    discovery: ProviderDiscoverySchema,
    presetId: z.string().nullable(),
    status: ProviderStatusSchema,
    lastTestedAt: z.iso.datetime().nullable(),
    testResult: TestResultSchema.nullable(),
    scope: z.enum(['organization', 'account']).openapi({
      description:
        "`organization` providers serve every member's Bots; `account` providers are the caller's own",
    }),
    smallModelId: z.string().nullable().openapi({
      description:
        'Override for background tasks; null means the cheapest enabled model with tools',
    }),
    botCount: z
      .number()
      .int()
      .openapi({ description: 'Bots using this provider; delete needs 0 (L5)' }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Provider');

const ProviderModelSchema = z
  .object({
    id: z.uuid(),
    providerId: z.uuid(),
    modelId: z.string(),
    displayName: z.string(),
    capabilities: CapabilitiesSchema,
    pricing: PricingSchema.nullable().openapi({ description: 'Null shows "no estimate"' }),
    enabled: z.boolean(),
    source: ModelSourceSchema,
  })
  .openapi('ProviderModel');

const ModelInputSchema = z
  .strictObject({
    modelId: z.string().trim().min(1).max(256),
    displayName: z.string().trim().min(1).max(200).optional(),
    capabilities: CapabilitiesSchema.partial().strict().optional(),
    pricing: PricingSchema.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .openapi('ModelInput');

const HeadersSchema = z.record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().max(4096)).openapi({
  description: 'Extra request headers, stored encrypted and returned by name only',
});

const LocalSchema = z.boolean().openapi({
  description:
    'The endpoint runs on your own network (Ollama, LM Studio). Without it a base URL on a private or local address is refused (`PRIVATE_HOST`)',
});

const CreateProviderSchema = z
  .strictObject({
    presetId: z
      .string()
      .optional()
      .openapi({ description: 'Fills kind, protocol, base URL, auth and models' }),
    name: z.string().trim().min(1).max(80).optional(),
    slug: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
      .max(48)
      .optional(),
    kind: ProviderKindSchema.optional(),
    protocol: ProviderProtocolSchema.optional(),
    baseUrl: z.url().nullable().optional(),
    local: LocalSchema.optional(),
    apiKey: z.string().min(1).max(4096).optional(),
    headers: HeadersSchema.optional(),
    discovery: ProviderDiscoverySchema.optional(),
    models: z.array(ModelInputSchema).max(500).optional(),
    scope: z.enum(['organization', 'account']).optional().openapi({
      description:
        "Managed service: `organization` (owners and admins; the default for them) or `account` (the caller's own; the default for members). A self-hosted install has only `organization`.",
    }),
  })
  .openapi('CreateProvider');

const UpdateProviderSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80).optional(),
    baseUrl: z.url().nullable().optional().openapi({
      description:
        'A new host drops the stored key and headers; send `apiKey` or `headers` with it to keep them',
    }),
    local: LocalSchema.optional(),
    apiKey: z.string().min(1).max(4096).nullable().optional().openapi({
      description: 'A new key, or null to remove the stored one',
    }),
    headers: HeadersSchema.optional(),
    discovery: ProviderDiscoverySchema.optional(),
    smallModelId: z.string().nullable().optional(),
  })
  .openapi('UpdateProvider');

const PutModelsSchema = z
  .strictObject({
    models: z.array(ModelInputSchema).max(500).openapi({
      description:
        'Upserts by `modelId`; omitted fields keep their values, unknown ids are added as `manual`',
    }),
    remove: z.array(z.string()).max(500).optional().openapi({ description: 'Model ids to delete' }),
  })
  .openapi('PutProviderModels');

const PresetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: ProviderKindSchema,
    protocol: ProviderProtocolSchema,
    baseUrl: z.string().nullable(),
    keyRequired: z.boolean(),
    discovery: ProviderDiscoverySchema,
    notes: z.string().nullable(),
    models: z.array(
      z.object({
        modelId: z.string(),
        displayName: z.string(),
        default: z.boolean(),
        capabilities: CapabilitiesSchema,
        pricing: PricingSchema.nullable(),
      }),
    ),
  })
  .openapi('ProviderPreset');

const params = z.object({ id: z.uuid() });

const iso = (date: Date | null) => (date ? new Date(date).toISOString() : null);

/** Who may change a provider and see its key's hint (P3): admins for the organization's, the owner for their own. */
const manages = (row: Pick<ProviderRow, 'ownerId'>, user: CurrentUser) =>
  row.ownerId === null ? isOrgAdmin(user.role) : row.ownerId === user.id;

/** 404 unless the caller sees the provider, 403 unless they may change it. */
async function assertManages(c: Context<AppEnv>, id: string) {
  const { row } = await getProvider(c.var.deps.db, c.var.user, id);
  if (!manages(row, c.var.user)) {
    throw forbidden("Only an admin can change the organization's providers");
  }
}

function toProvider(
  { row, smallModelId, botCount }: ProviderRecord,
  user: CurrentUser,
): z.infer<typeof ProviderSchema> {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    protocol: row.protocol,
    baseUrl: row.baseUrl,
    local: row.local,
    headers: headerNames(row),
    hasKey: row.secrets !== null,
    keyHint: row.secrets !== null && manages(row, user) ? row.keyHint : null,
    discovery: row.discovery,
    presetId: row.presetId,
    status: ProviderStatusSchema.catch('untested').parse(row.status),
    lastTestedAt: iso(row.lastTestedAt),
    testResult: testResultOf(row),
    scope: row.ownerId ? 'account' : 'organization',
    smallModelId,
    botCount,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

function toProviderModel(row: ProviderModelRow): z.infer<typeof ProviderModelSchema> {
  return {
    id: row.id,
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName,
    capabilities: capabilitiesOf(row),
    pricing: pricingOf(row),
    enabled: row.enabled,
    source: row.source,
  };
}

const ProviderSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    kind: ProviderKindSchema,
    // Optional on the wire so older clients still type-check; always sent.
    protocol: ProviderProtocolSchema.optional(),
    status: ProviderStatusSchema,
  })
  .openapi('ProviderSummary');

const toSummary = (row: ProviderRow): z.infer<typeof ProviderSummarySchema> => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  kind: row.kind,
  protocol: row.protocol,
  status: ProviderStatusSchema.catch('untested').parse(row.status),
});

const providerResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ProviderSchema } },
});

const modelsResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: z.object({ items: z.array(ProviderModelSchema) }) } },
});

const notFoundProblem = { 404: problemResponse('No such provider') };

const NeedsQuerySchema = z.object({
  needs: z
    .string()
    .optional()
    .transform((s, ctx) => {
      const parts = (s ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const parsed = z.array(ModelNeedSchema).safeParse(parts);
      if (!parsed.success) {
        ctx.addIssue({ code: 'custom', message: 'needs takes tools, vision and reasoning' });
        return z.NEVER;
      }
      return parsed.data;
    })
    .openapi({
      type: 'string',
      description: 'Comma-separated: `tools`, `vision`, `reasoning`',
      example: 'tools,vision',
    }),
  botId: z.uuid().optional().openapi({
    description:
      "Adds what this Bot needs: tool calling, and vision when it uses its computer (L4). One of the caller's Bots.",
  }),
});

export const providerRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/providers',
      tags: ['models'],
      summary: 'Model providers',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: {
          description: 'Providers, oldest first',
          content: { 'application/json': { schema: z.object({ items: z.array(ProviderSchema) }) } },
        },
        ...authProblems,
      },
    }),
    async (c) => {
      const records = await listProviders(c.var.deps.db, c.var.user);
      return c.json({ items: records.map((r) => toProvider(r, c.var.user)) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/providers/presets',
      tags: ['models'],
      summary: 'Presets that fill in the add-provider form (L2)',
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: {
          description: 'Built-in providers and custom model provider presets',
          content: { 'application/json': { schema: z.object({ items: z.array(PresetSchema) }) } },
        },
        ...authProblems,
      },
    }),
    async (c) => {
      const items = loadCatalog().presets.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        protocol: p.protocol,
        baseUrl: p.base_url,
        keyRequired: p.key_required,
        discovery: p.discovery,
        notes: p.notes ?? null,
        models: p.models.map((m) => ({
          modelId: m.id,
          displayName: m.name,
          default: m.default ?? false,
          capabilities: m.capabilities,
          pricing: m.pricing ?? null,
        })),
      }));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/providers',
      tags: ['models'],
      summary: 'Add a built-in or custom model provider',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: { required: true, content: { 'application/json': { schema: CreateProviderSchema } } },
      },
      responses: {
        201: providerResponse('The new provider, with its catalog models'),
        400: problemResponse('Invalid provider'),
        409: problemResponse('Slug taken (`SLUG_TAKEN`)'),
        ...adminProblems,
      },
    }),
    async (c) => {
      const { config } = c.var.deps;
      const user = c.var.user;
      const input = c.req.valid('json');
      const admin = isOrgAdmin(user.role);
      if (config.deployment === 'self_hosted' && input.scope === 'account') {
        throw forbidden('A self-hosted install has one list of providers');
      }
      const scope =
        config.deployment === 'self_hosted'
          ? 'organization'
          : (input.scope ?? (admin ? 'organization' : 'account'));
      if (scope === 'organization' && !admin) {
        throw forbidden('Only an admin can add a provider for the organization');
      }
      const record = await createProvider(c.var.deps, user, { ...input, scope });
      return c.json(toProvider(record, user), 201);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/providers/{id}',
      tags: ['models'],
      summary: "Edit a provider's endpoint, key, headers or small model",
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params,
        body: { required: true, content: { 'application/json': { schema: UpdateProviderSchema } } },
      },
      responses: {
        200: providerResponse('The updated provider'),
        400: problemResponse('Invalid change'),
        ...notFoundProblem,
        ...adminProblems,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      await assertManages(c, id);
      const record = await updateProvider(c.var.deps, c.var.user, id, c.req.valid('json'));
      return c.json(toProvider(record, c.var.user), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/providers/{id}',
      tags: ['models'],
      summary: 'Delete a provider no Bot uses',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        204: { description: 'Deleted with its models' },
        409: problemResponse('Bots still use it (`PROVIDER_IN_USE`); move them first (L5)'),
        ...notFoundProblem,
        ...adminProblems,
      },
    }),
    async (c) => {
      await assertManages(c, c.req.valid('param').id);
      await deleteProvider(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/providers/{id}/test',
      tags: ['models'],
      summary: 'Test streaming and tool calling',
      description:
        'Runs a tiny streamed completion, then a tool-call round trip. The outcome is stored in `testResult` and `status`; a failing endpoint is reported there, not as an error. A model whose tool calling fails gets its `tools` flag turned off.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params,
        body: {
          required: false,
          content: {
            'application/json': {
              schema: z.strictObject({ modelId: z.string().optional() }).openapi('TestProvider', {
                description: "Defaults to the preset's default model, else the first with tools",
              }),
            },
          },
        },
      },
      responses: {
        200: providerResponse('The provider with its new test result'),
        400: problemResponse('No model to test (`NO_MODELS`, `UNKNOWN_MODEL`)'),
        ...notFoundProblem,
        ...adminProblems,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      await assertManages(c, id);
      const body = c.req.header('content-type')?.includes('json') ? c.req.valid('json') : {};
      const record = await testProvider(c.var.deps, c.var.user, id, body ?? {});
      return c.json(toProvider(record, c.var.user), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/providers/{id}/discover',
      tags: ['models'],
      summary: "Pull an OpenAI-compatible endpoint's model list",
      description: 'New models join as `discovered`; models already listed keep their edits.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: {
          description: 'How many models were added, and the full list',
          content: {
            'application/json': {
              schema: z.object({ added: z.number().int(), items: z.array(ProviderModelSchema) }),
            },
          },
        },
        400: problemResponse('Not an OpenAI-compatible endpoint (`DISCOVERY_UNSUPPORTED`)'),
        502: problemResponse('The endpoint did not answer with a model list (`DISCOVERY_FAILED`)'),
        ...notFoundProblem,
        ...adminProblems,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      await assertManages(c, id);
      const { added, models } = await discoverProviderModels(c.var.deps, c.var.user, id);
      return c.json({ added, items: models.map(toProviderModel) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/providers/{id}/models',
      tags: ['models'],
      summary: "A provider's models, enabled or not",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: { 200: modelsResponse('Models by name'), ...notFoundProblem, ...authProblems },
    }),
    async (c) => {
      const rows = await listProviderModels(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.json({ items: rows.map(toProviderModel) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'put',
      path: '/providers/{id}/models',
      tags: ['models'],
      summary: 'Edit capabilities and pricing, enable, disable, add or remove models',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params,
        body: { required: true, content: { 'application/json': { schema: PutModelsSchema } } },
      },
      responses: {
        200: modelsResponse('The models after the change'),
        400: problemResponse('Invalid models'),
        ...notFoundProblem,
        ...adminProblems,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      await assertManages(c, id);
      const rows = await upsertProviderModels(c.var.deps, c.var.user, id, c.req.valid('json'));
      return c.json({ items: rows.map(toProviderModel) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/models',
      tags: ['models'],
      summary: 'Enabled models grouped by provider, for the Bot model picker (L4)',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { query: NeedsQuerySchema },
      responses: {
        200: {
          description: 'Providers with at least one matching model',
          content: {
            'application/json': {
              schema: z.object({
                groups: z.array(
                  z.object({
                    provider: ProviderSummarySchema,
                    models: z.array(ProviderModelSchema),
                  }),
                ),
                // Optional on the wire so older clients still type-check; always sent.
                default: ModelConfigSchema.nullable().optional().openapi({
                  description:
                    "The model a new Bot gets: the first usable provider's catalog default, with adaptive thinking on Anthropic",
                }),
              }),
            },
          },
        },
        400: problemResponse('Unknown need'),
        404: problemResponse('No such Bot'),
        ...authProblems,
      },
    }),
    async (c) => {
      const { deps, user } = c.var;
      const query = c.req.valid('query');
      let needs = query.needs;
      if (query.botId) {
        const { bot } = await getBot(deps.db, user, query.botId);
        needs = [...new Set([...needs, ...botModelNeeds(bot.toolPolicy, computerAvailable(deps))])];
      }
      const groups = await modelsByProvider(deps.db, user, needs);
      return c.json(
        {
          groups: groups.map((g) => ({
            provider: toSummary(g.provider),
            models: g.models.map(toProviderModel),
          })),
          default: await defaultModelConfig(deps.db, user, needs),
        },
        200,
      );
    },
  );
