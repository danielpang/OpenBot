import {
  ProviderRegistry,
  catalogModel,
  createModelFactory,
  discoverModels,
  DiscoveryError,
  pickSmallModel,
  presetById,
  testModel,
  type ProviderConfig,
  type ProviderModel,
  type ProviderSource,
} from '@openbots/models';
import {
  DEFAULT_CAPABILITIES,
  ModelCapabilitiesSchema,
  ModelPricingSchema,
  ProviderTestResultSchema,
  defaultReasoning,
  modelSupports,
  type ModelCapabilities,
  type ModelConfig,
  type ModelNeed,
  type ModelPricing,
  type ProviderDiscovery,
  type ProviderKind,
  type ProviderProtocol,
  type ProviderStatus,
  type ProviderTestResult,
} from '@openbots/shared';
import { and, asc, count, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { BlockedAddressError, checkedAddresses, netFetch } from '../builtins/net.js';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { decryptSecretString, encryptSecret, keyringFromConfig } from '../secrets.js';
import { ensureWorkspace, getOrganization, storedSettings, updateSettings } from '../workspace.js';
import { inWorkspace } from '../db/scope.js';
import { subscriptionModelFor, subscriptionFor } from './model-connections.js';

// Model providers (plan 4.10, 5.9; L1 to L5). Built-ins are seeded from `.env`
// at start; custom endpoints come from Settings > Models. Instance-level rows
// (owner_id null) are readable by every member and edited by admins; per-account
// providers (L6) come after 1.0. API keys are sealed in `providers.secrets` and
// never leave the server; `key_hint` keeps the vendor prefix and last four
// characters, shown to admins so they can tell keys apart (P3). Extra header
// values are sealed in `header_secrets` and responses carry their names only (S-9).
//
// Base URLs must name public hosts unless an admin marks the endpoint local
// (S-12): the host is checked when it is saved, and every request to an
// endpoint not marked local goes through the outbound guard (S-8). A key only
// goes to the host it was entered for, so changing the base URL's host drops
// it, and the extra headers with it, since their values can be credentials too.

type Viewer = Pick<CurrentUser, 'id' | 'workspaceId'>;
type ProvidersDeps = Pick<AppDeps, 'db' | 'config' | 'net'>;

export type ProviderRow = typeof schema.providers.$inferSelect;
export type ProviderModelRow = typeof schema.providerModels.$inferSelect;

export interface ProviderRecord {
  row: ProviderRow;
  smallModelId: string | null;
  botCount: number;
}

export interface ModelInput {
  modelId: string;
  displayName?: string;
  capabilities?: Partial<ModelCapabilities>;
  pricing?: ModelPricing | null;
  enabled?: boolean;
}

export interface ProviderInput {
  presetId?: string;
  name?: string;
  slug?: string;
  kind?: ProviderKind;
  protocol?: ProviderProtocol;
  baseUrl?: string | null;
  /** The endpoint is on the admin's own network and may resolve to a private address. */
  local?: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  discovery?: ProviderDiscovery;
  models?: ModelInput[];
  /**
   * `organization` (every member's Bots may use it; owners and admins add
   * these) or `account` (the caller's own, first for their Bots; L6).
   */
  scope?: ProviderScope;
}

/** Where a provider belongs (plan 21.4): `owner_id` null is the organization's. */
export type ProviderScope = 'organization' | 'account';

export const scopeOf = (row: Pick<ProviderRow, 'ownerId'>): ProviderScope =>
  row.ownerId ? 'account' : 'organization';

/** A provider may reach private addresses only where the install allows it (S-8, plan 21.6). */
function assertLocalAllowed(deps: Pick<AppDeps, 'config'>, local: boolean | undefined) {
  if (local && !deps.config.localEndpoints) {
    throw new DomainError(
      403,
      'LOCAL_UNAVAILABLE',
      'Providers cannot reach private addresses on the hosted service.',
    );
  }
}

export interface ProviderPatch {
  name?: string;
  /** A new host drops the stored key and headers unless `apiKey` or `headers` come with it. */
  baseUrl?: string | null;
  local?: boolean;
  /** Null removes the key. */
  apiKey?: string | null;
  headers?: Record<string, string>;
  discovery?: ProviderDiscovery;
  smallModelId?: string | null;
}

const invalid = (code: string, message: string) => new DomainError(400, code, message);

export const providerInUse = (bots: number) =>
  new DomainError(
    409,
    'PROVIDER_IN_USE',
    `${bots} ${bots === 1 ? 'Bot uses' : 'Bots use'} this provider. Move ${bots === 1 ? 'it' : 'them'} to another model first.`,
  );

const keyring = (deps: Pick<AppDeps, 'config'>) => keyringFromConfig(deps.config);

/**
 * Prefixes the providers in the catalog put on every key, longest first:
 * the same in all of a vendor's keys, so showing one gives nothing away.
 */
export const KEY_PREFIXES = [
  'sk-svcacct-',
  'sk-admin-',
  'sk-proj-',
  'sk-ant-',
  'tgp_v1_',
  'sk-or-',
  'xai-',
  'gsk_',
  'AIza',
  'fw_',
  'sk-',
] as const;

/**
 * What admins see of a saved key so they can tell keys apart (P3): its
 * vendor prefix from `KEY_PREFIXES` (none for any other key, whose leading
 * characters may be secret), "…", and the last 4 characters, as in
 * `sk-ant-…a1b2`. Never more than half of a key: a key under 20 characters,
 * or one whose prefix and last 4 would pass half, keeps only "…" and its
 * last 2, and a key under 8 characters keeps nothing.
 */
export function keyHint(apiKey: string): string | null {
  if (apiKey.length < 8) return null;
  const prefix = KEY_PREFIXES.find((p) => apiKey.startsWith(p)) ?? '';
  if (apiKey.length < 20 || prefix.length + 4 > apiKey.length / 2) return `…${apiKey.slice(-2)}`;
  return `${prefix}…${apiKey.slice(-4)}`;
}

/** The sealed key and its hint, together, so one is never written without the other. */
function sealKey(deps: Pick<AppDeps, 'config'>, apiKey: string | null | undefined) {
  return apiKey
    ? { secrets: encryptSecret(apiKey, keyring(deps)), keyHint: keyHint(apiKey) }
    : { secrets: null, keyHint: null };
}

/** The extra header names; rows from before S-9 hold an object until start-up seals it. */
export function headerNames(row: Pick<ProviderRow, 'headers'>): string[] {
  const headers = row.headers ?? {};
  return Array.isArray(headers) ? (headers as string[]) : Object.keys(headers);
}

function headerValues(
  deps: Pick<AppDeps, 'config'>,
  row: Pick<ProviderRow, 'headers' | 'headerSecrets'>,
): Record<string, string> {
  if (row.headerSecrets) {
    return JSON.parse(decryptSecretString(row.headerSecrets, keyring(deps))) as Record<
      string,
      string
    >;
  }
  return Array.isArray(row.headers) ? {} : ((row.headers ?? {}) as Record<string, string>);
}

function sealHeaders(deps: Pick<AppDeps, 'config'>, headers: Record<string, string>) {
  const names = Object.keys(headers);
  return {
    headers: names,
    headerSecrets: names.length ? encryptSecret(JSON.stringify(headers), keyring(deps)) : null,
  };
}

/**
 * Seals header values stored in plain text before S-9. SQL cannot, since
 * sealing needs the master key, so `main.ts` calls it after the migrations.
 */
export async function sealPlaintextProviderHeaders(
  deps: Pick<AppDeps, 'db' | 'config'>,
): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const rows = await tx.select().from(schema.providers).for('update');
    let changed = 0;
    for (const row of rows) {
      if (Array.isArray(row.headers)) continue;
      await tx
        .update(schema.providers)
        .set(sealHeaders(deps, (row.headers ?? {}) as Record<string, string>))
        .where(eq(schema.providers.id, row.id));
      changed++;
    }
    return changed;
  });
}

/**
 * Recomputes every stored key's hint, which fills it for keys saved before
 * `key_hint` existed and rewrites hints in an older format. SQL cannot, since
 * reading a key needs the master key, so `main.ts` calls it after the
 * migrations. It logs nothing: neither the key nor its hint.
 */
export async function backfillProviderKeyHints(
  deps: Pick<AppDeps, 'db' | 'config'>,
): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: schema.providers.id,
        secrets: schema.providers.secrets,
        keyHint: schema.providers.keyHint,
      })
      .from(schema.providers)
      .where(isNotNull(schema.providers.secrets))
      .for('update');
    let changed = 0;
    for (const row of rows) {
      let hint: string | null;
      try {
        hint = keyHint(decryptSecretString(row.secrets!, keyring(deps)));
      } catch {
        // Sealed under a key this server no longer has: rotation reports it.
        continue;
      }
      if (hint === row.keyHint) continue;
      await tx
        .update(schema.providers)
        .set({ keyHint: hint })
        .where(eq(schema.providers.id, row.id));
      changed++;
    }
    return changed;
  });
}

/** The host a base URL sends to; null is the SDK's default endpoint. */
const hostOf = (baseUrl: string | null) => (baseUrl ? new URL(baseUrl).hostname : null);

/** Refuses a base URL on a private or unresolvable host unless the endpoint is marked local (S-12). */
async function assertEndpoint(
  deps: Pick<AppDeps, 'net'>,
  baseUrl: string | null,
  local: boolean,
): Promise<void> {
  if (!baseUrl || local) return;
  try {
    await checkedAddresses(new URL(baseUrl).hostname, deps.net);
  } catch (err) {
    if (!(err instanceof BlockedAddressError)) throw err;
    throw invalid(
      'PRIVATE_HOST',
      `${err.message}. If this endpoint runs on your own network, mark it as local.`,
    );
  }
}

export function slugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'provider';
}

/** Ollama answers the OpenAI protocol under `/v1`; `.env` often has just the host. */
export function ollamaBaseUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export const capabilitiesOf = (row: Pick<ProviderModelRow, 'capabilities'>): ModelCapabilities =>
  ModelCapabilitiesSchema.catch(DEFAULT_CAPABILITIES).parse({
    ...DEFAULT_CAPABILITIES,
    ...(row.capabilities as object),
  });

/**
 * Capability flags a failed Test turned off (L3), kept in the model's
 * capabilities jsonb beside the flags. A later passing Test turns only these
 * back on, and a flag the user sets by hand leaves the list, so Test never
 * undoes a manual edit. `capabilitiesOf` drops the key, so it never reaches
 * the API.
 */
const OFF_BY_TEST = 'off_by_test';
type TestedFlag = 'tools';

function offByTest(row: Pick<ProviderModelRow, 'capabilities'>): TestedFlag[] {
  const off = (row.capabilities as Record<string, unknown> | null)?.[OFF_BY_TEST];
  return Array.isArray(off) ? off.filter((f): f is TestedFlag => f === 'tools') : [];
}

const storedCapabilities = (capabilities: ModelCapabilities, off: readonly TestedFlag[]) =>
  off.length ? { ...capabilities, [OFF_BY_TEST]: [...new Set(off)] } : capabilities;

export const pricingOf = (row: Pick<ProviderModelRow, 'pricing'>): ModelPricing | null => {
  const parsed = ModelPricingSchema.safeParse(row.pricing);
  return parsed.success ? parsed.data : null;
};

export const testResultOf = (row: Pick<ProviderRow, 'testResult'>): ProviderTestResult | null => {
  const parsed = ProviderTestResultSchema.safeParse(row.testResult);
  return parsed.success ? parsed.data : null;
};

function toProviderModel(row: ProviderModelRow): ProviderModel {
  return {
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName,
    capabilities: capabilitiesOf(row),
    pricing: pricingOf(row),
    enabled: row.enabled,
  };
}

// --- Seeding (L1) ---------------------------------------------------------------

interface SeedSpec {
  presetId: string;
  slug: string;
  apiKey: string | null;
  baseUrl: string | null;
  local: boolean;
}

function seedSpecs(config: AppDeps['config']): SeedSpec[] {
  const keys = config.providerKeys;
  const specs: SeedSpec[] = [];
  for (const kind of ['anthropic', 'openai', 'google', 'xai'] as const) {
    const key = keys[kind];
    if (key) specs.push({ presetId: kind, slug: kind, apiKey: key, baseUrl: null, local: false });
  }
  if (keys.ollamaBaseUrl) {
    specs.push({
      presetId: 'ollama',
      slug: 'ollama',
      apiKey: null,
      baseUrl: ollamaBaseUrl(keys.ollamaBaseUrl),
      // OLLAMA_BASE_URL names a server next to OpenBots, usually a compose service.
      local: true,
    });
  }
  return specs;
}

/**
 * Upserts an instance-level provider for each key in `.env` (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, XAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, OLLAMA_BASE_URL)
 * with the catalog's models. Idempotent; never overwrites what an admin
 * changed: a stored key, name, base URL or edited model stays as it is.
 */
export async function seedProvidersFromEnv(
  deps: Pick<AppDeps, 'db' | 'config' | 'logger'>,
): Promise<void> {
  const specs = seedSpecs(deps.config);
  if (!specs.length) return;
  // Each organization on the managed service brings its own keys (plan 21.4).
  if (deps.config.deployment === 'managed') {
    deps.logger.warn(
      { providers: specs.map((s) => s.slug) },
      'provider keys in .env are not used on the managed service; organizations add their own',
    );
    return;
  }
  // The implicit organization of a self-hosted install, and the work in it (db/scope.ts).
  const workspace = await ensureWorkspace(deps.db);
  await inWorkspace(workspace.id, () => seedInto(deps, workspace.id, specs));
}

async function seedInto(
  deps: Pick<AppDeps, 'db' | 'config' | 'logger'>,
  workspaceId: string,
  specs: ReturnType<typeof seedSpecs>,
): Promise<void> {
  const workspace = { id: workspaceId };
  for (const spec of specs) {
    const preset = presetById(spec.presetId)!;
    await deps.db.transaction(async (tx) => {
      await tx
        .insert(schema.providers)
        .values({
          workspaceId: workspace.id,
          ownerId: null,
          kind: preset.kind,
          protocol: preset.protocol,
          name: preset.name,
          slug: spec.slug,
          baseUrl: spec.baseUrl,
          local: spec.local,
          headers: [],
          ...sealKey(deps, spec.apiKey),
          discovery: preset.discovery,
          presetId: preset.id,
          status: 'untested' satisfies ProviderStatus,
        })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(schema.providers)
        .where(
          and(
            eq(schema.providers.workspaceId, workspace.id),
            isNull(schema.providers.ownerId),
            eq(schema.providers.slug, spec.slug),
          ),
        );
      if (!row) return;
      if (spec.apiKey) {
        if (!row.secrets) {
          await tx
            .update(schema.providers)
            .set(sealKey(deps, spec.apiKey))
            .where(eq(schema.providers.id, row.id));
        } else if (decryptSecretString(row.secrets, keyring(deps)) !== spec.apiKey) {
          deps.logger.warn(
            { provider: spec.slug },
            'the provider key in Settings differs from .env; keeping the one in Settings',
          );
        }
      }
      await insertCatalogModels(tx, row);
    });
  }
}

/** Adds the preset's catalog models that are not there yet; existing rows are left alone. */
async function insertCatalogModels(db: Db, row: ProviderRow): Promise<void> {
  const preset = row.presetId ? presetById(row.presetId) : undefined;
  if (!preset?.models.length) return;
  await db
    .insert(schema.providerModels)
    .values(
      preset.models.map((m) => ({
        workspaceId: row.workspaceId,
        providerId: row.id,
        modelId: m.id,
        displayName: m.name,
        capabilities: m.capabilities,
        pricing: m.pricing ?? null,
        enabled: true,
        source: 'catalog' as const,
      })),
    )
    .onConflictDoNothing();
}

// --- Reads -----------------------------------------------------------------------

/** The organization's providers and the viewer's own, never another member's (L6). */
function visibleTo(viewer: Viewer) {
  return and(
    eq(schema.providers.workspaceId, viewer.workspaceId),
    or(isNull(schema.providers.ownerId), eq(schema.providers.ownerId, viewer.id)),
  );
}

/** The viewer's own providers first (they take priority for their Bots, L6), then by age. */
const viewerOrder = [
  sql`${schema.providers.ownerId} is null`,
  asc(schema.providers.createdAt),
  asc(schema.providers.id),
] as const;

/** Bots per provider id, read from `bots.model_config.provider_id` (L5). */
async function botCounts(db: Db, providerIds: string[]): Promise<Map<string, number>> {
  if (!providerIds.length) return new Map();
  const providerId = sql<string>`${schema.bots.modelConfig}->>'provider_id'`;
  const rows = await db
    .select({ providerId, n: count() })
    .from(schema.bots)
    .where(inArray(providerId, providerIds))
    .groupBy(providerId);
  return new Map(rows.map((r) => [r.providerId, Number(r.n)]));
}

async function records(
  db: Db,
  workspaceId: string,
  rows: ProviderRow[],
): Promise<ProviderRecord[]> {
  const counts = await botCounts(
    db,
    rows.map((r) => r.id),
  );
  const workspace = await getOrganization(db, workspaceId);
  const small = storedSettings(workspace).smallModels ?? {};
  return rows.map((row) => ({
    row,
    smallModelId: small[row.id] ?? null,
    botCount: counts.get(row.id) ?? 0,
  }));
}

export async function listProviders(db: Db, viewer: Viewer): Promise<ProviderRecord[]> {
  const rows = await db
    .select()
    .from(schema.providers)
    .where(visibleTo(viewer))
    .orderBy(...viewerOrder);
  return records(db, viewer.workspaceId, rows);
}

async function providerRow(db: Db, viewer: Viewer, id: string): Promise<ProviderRow> {
  const [row] = await db
    .select()
    .from(schema.providers)
    .where(and(eq(schema.providers.id, id), visibleTo(viewer)));
  if (!row) throw notFound('Provider not found');
  return row;
}

export async function getProvider(db: Db, viewer: Viewer, id: string): Promise<ProviderRecord> {
  const [record] = await records(db, viewer.workspaceId, [await providerRow(db, viewer, id)]);
  return record!;
}

export async function listProviderModels(
  db: Db,
  viewer: Viewer,
  providerId: string,
): Promise<ProviderModelRow[]> {
  await providerRow(db, viewer, providerId);
  return modelRows(db, [providerId]);
}

function modelRows(db: Db, providerIds: string[]): Promise<ProviderModelRow[]> {
  if (!providerIds.length) return Promise.resolve([]);
  return db
    .select()
    .from(schema.providerModels)
    .where(inArray(schema.providerModels.providerId, providerIds))
    .orderBy(asc(schema.providerModels.displayName), asc(schema.providerModels.modelId));
}

/** `GET /models`: enabled models grouped by provider, filtered by what the Bot needs (L4). */
export async function modelsByProvider(
  db: Db,
  viewer: Viewer,
  needs: readonly ModelNeed[],
): Promise<{ provider: ProviderRow; models: ProviderModelRow[] }[]> {
  const providers = await db
    .select()
    .from(schema.providers)
    .where(visibleTo(viewer))
    .orderBy(...viewerOrder);
  const models = await modelRows(
    db,
    providers.map((p) => p.id),
  );
  return providers
    .map((provider) => ({
      provider,
      models: models.filter(
        (m) =>
          m.providerId === provider.id &&
          m.enabled &&
          modelSupports({ capabilities: capabilitiesOf(m) }, needs),
      ),
    }))
    .filter((group) => group.models.length > 0);
}

/**
 * 400 unless a Bot's model is listed and enabled on its provider (L5), so a
 * bad pick fails when it is saved rather than blocking the next run. A Bot
 * saved with the model it already has is not checked again: turning a model
 * off must not stop its owner from saving the rest of the Bot's settings.
 */
export async function assertBotModel(
  db: Db,
  config: Pick<ModelConfig, 'provider_id' | 'model_id'>,
  current?: unknown,
): Promise<void> {
  const previous = current as Partial<ModelConfig> | null | undefined;
  if (previous?.provider_id === config.provider_id && previous.model_id === config.model_id) {
    return;
  }
  const [row] = await db
    .select({ enabled: schema.providerModels.enabled })
    .from(schema.providerModels)
    .where(
      and(
        eq(schema.providerModels.providerId, config.provider_id),
        eq(schema.providerModels.modelId, config.model_id),
      ),
    );
  if (!row) {
    throw invalid(
      'UNKNOWN_MODEL',
      `This provider has no model ${config.model_id}. Pick one of its models, or add it in Settings > Models.`,
    );
  }
  if (!row.enabled) {
    throw invalid(
      'MODEL_DISABLED',
      `${config.model_id} is turned off for this provider. Turn it on in Settings > Models, or pick another model.`,
    );
  }
}

/**
 * The model a new Bot gets (plan 3, 5.9): the catalog default of the first
 * usable provider (in the order they were added, skipping ones whose last
 * Test failed outright), with adaptive thinking on Anthropic models that
 * reason. What the Bot `prefers` comes first (vision for a Bot with a
 * computer, L4): a later provider's default with vision wins over an earlier
 * one's without, and failing any such default, the first enabled model with
 * it. Only when no model has it does the Bot get a default with tool calling
 * alone, and a provider without a catalog default (a local endpoint) lends
 * its first enabled model with tool calling. Null when nothing has tools.
 */
export async function defaultModelConfig(
  db: Db,
  viewer: Viewer,
  prefers: readonly ModelNeed[] = ['tools'],
): Promise<ModelConfig | null> {
  const providers = (
    await db
      .select()
      .from(schema.providers)
      .where(visibleTo(viewer))
      .orderBy(...viewerOrder)
  ).filter((p) => p.status !== 'error');
  const models = (
    await modelRows(
      db,
      providers.map((p) => p.id),
    )
  ).filter((m) => m.enabled && capabilitiesOf(m).tools);
  const configFor = (provider: ProviderRow, model: ProviderModelRow): ModelConfig => {
    const reasoning = defaultReasoning(provider, capabilitiesOf(model));
    return {
      provider_id: provider.id,
      model_id: model.modelId,
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
  };
  const catalogDefault = (provider: ProviderRow) =>
    provider.presetId
      ? presetById(provider.presetId)?.models.find((m) => m.default)?.id
      : undefined;
  for (const need of [prefers, ['tools'] as const]) {
    const has = (m: ProviderModelRow) => modelSupports({ capabilities: capabilitiesOf(m) }, need);
    for (const onlyDefaults of [true, false]) {
      for (const provider of providers) {
        const preferred = catalogDefault(provider);
        const model = models.find(
          (m) =>
            m.providerId === provider.id && (!onlyDefaults || m.modelId === preferred) && has(m),
        );
        if (model) return configFor(provider, model);
      }
    }
  }
  return null;
}

// --- Writes (admins) ---------------------------------------------------------------

function assertBaseUrl(baseUrl: string | null, protocol: ProviderProtocol) {
  if (protocol !== 'native' && !baseUrl) {
    throw invalid('BASE_URL_REQUIRED', 'A custom model provider needs a base URL');
  }
  if (baseUrl && /[{}]/.test(decodeURI(baseUrl))) {
    throw invalid('BASE_URL_PLACEHOLDER', 'Fill in the {placeholders} in the base URL');
  }
}

function modelValues(row: ProviderRow, input: ModelInput, source: 'catalog' | 'manual') {
  const known = catalogModel(row.presetId, input.modelId);
  return {
    workspaceId: row.workspaceId,
    providerId: row.id,
    modelId: input.modelId,
    displayName: input.displayName ?? known?.name ?? input.modelId,
    capabilities: {
      ...(known?.capabilities ?? DEFAULT_CAPABILITIES),
      ...input.capabilities,
    },
    pricing: input.pricing !== undefined ? input.pricing : (known?.pricing ?? null),
    enabled: input.enabled ?? true,
    source,
  };
}

export async function createProvider(
  deps: ProvidersDeps,
  viewer: Viewer,
  input: ProviderInput,
): Promise<ProviderRecord> {
  const preset = input.presetId ? presetById(input.presetId) : undefined;
  if (input.presetId && !preset) throw invalid('UNKNOWN_PRESET', `No preset ${input.presetId}`);
  const kind = preset?.kind ?? input.kind ?? 'custom';
  const protocol = preset?.protocol ?? input.protocol ?? (kind === 'custom' ? undefined : 'native');
  if (!protocol)
    throw invalid('PROTOCOL_REQUIRED', 'Pick openai_compatible or anthropic_compatible');
  if ((kind === 'custom') !== (protocol !== 'native')) {
    throw invalid(
      'INVALID_PROTOCOL',
      'Built-in providers use the native protocol; custom model providers use a compatible one',
    );
  }
  const name = input.name ?? preset?.name;
  if (!name) throw invalid('NAME_REQUIRED', 'Give the provider a name');
  // Built-ins talk to their SDK's default URL unless one is given.
  const baseUrl =
    input.baseUrl !== undefined
      ? input.baseUrl
      : protocol === 'native'
        ? null
        : (preset?.base_url ?? null);
  assertBaseUrl(baseUrl, protocol);
  const local = input.local ?? false;
  assertLocalAllowed(deps, local);
  await assertEndpoint(deps, baseUrl, local);
  if (preset?.key_required && !input.apiKey) {
    const accounts =
      protocol === 'native' && !baseUrl && !Object.keys(input.headers ?? {}).length
        ? await deps.db
            .select()
            .from(schema.coderAccounts)
            .where(
              and(
                eq(schema.coderAccounts.ownerId, viewer.id),
                eq(schema.coderAccounts.workspaceId, viewer.workspaceId),
              ),
            )
        : [];
    if (!subscriptionFor(kind, accounts))
      throw invalid(
        'API_KEY_REQUIRED',
        `${preset.name} needs an API key or a connected subscription`,
      );
  }
  const slug = input.slug ?? slugFromName(input.presetId && !input.name ? input.presetId : name);

  const id = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.providers)
      .values({
        workspaceId: viewer.workspaceId,
        ownerId: input.scope === 'account' ? viewer.id : null,
        kind,
        protocol,
        name,
        slug,
        baseUrl,
        local,
        ...sealHeaders(deps, input.headers ?? {}),
        ...sealKey(deps, input.apiKey),
        discovery: input.discovery ?? preset?.discovery ?? 'manual',
        presetId: preset?.id ?? null,
        status: 'untested' satisfies ProviderStatus,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new DomainError(409, 'SLUG_TAKEN', `A provider named ${slug} already exists`);
    await insertCatalogModels(tx, row);
    if (input.models?.length) {
      await tx
        .insert(schema.providerModels)
        .values(input.models.map((m) => modelValues(row, m, 'manual')))
        .onConflictDoNothing();
    }
    await audit(tx, viewer, 'provider.create', row.id, { slug, presetId: row.presetId });
    return row.id;
  });
  return getProvider(deps.db, viewer, id);
}

export async function updateProvider(
  deps: ProvidersDeps,
  viewer: Viewer,
  id: string,
  patch: ProviderPatch,
): Promise<ProviderRecord> {
  const row = await providerRow(deps.db, viewer, id);
  const set: Partial<typeof schema.providers.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.baseUrl !== undefined) {
    assertBaseUrl(patch.baseUrl, row.protocol);
    set.baseUrl = patch.baseUrl;
  }
  if (patch.local !== undefined) {
    assertLocalAllowed(deps, patch.local);
    set.local = patch.local;
  }
  if (patch.baseUrl !== undefined || patch.local === false) {
    await assertEndpoint(
      deps,
      patch.baseUrl !== undefined ? patch.baseUrl : row.baseUrl,
      patch.local ?? row.local,
    );
  }
  // The key and headers were entered for one host; a new host has to be given them again (S-12).
  const hostChanged = patch.baseUrl !== undefined && hostOf(patch.baseUrl) !== hostOf(row.baseUrl);
  if (patch.apiKey !== undefined) {
    Object.assign(set, sealKey(deps, patch.apiKey));
  } else if (hostChanged && row.secrets) {
    Object.assign(set, sealKey(deps, null));
  }
  const headersDropped = patch.headers === undefined && hostChanged && headerNames(row).length > 0;
  if (patch.headers !== undefined) Object.assign(set, sealHeaders(deps, patch.headers));
  else if (headersDropped) Object.assign(set, sealHeaders(deps, {}));
  if (patch.discovery !== undefined) set.discovery = patch.discovery;
  // A new endpoint or key has not been tested.
  if (set.baseUrl !== undefined || set.secrets !== undefined || set.headers !== undefined) {
    set.status = 'untested' satisfies ProviderStatus;
  }
  if (Object.keys(set).length) {
    await deps.db.update(schema.providers).set(set).where(eq(schema.providers.id, id));
    providerRegistry(deps).invalidate(id);
  }
  if (patch.smallModelId !== undefined) {
    if (patch.smallModelId !== null) {
      const models = await modelRows(deps.db, [id]);
      if (!models.some((m) => m.modelId === patch.smallModelId && m.enabled)) {
        throw invalid('UNKNOWN_MODEL', `No enabled model ${patch.smallModelId} on this provider`);
      }
    }
    await setSmallModel(deps.db, row.workspaceId, id, patch.smallModelId);
  }
  // Which fields changed, never the key or header values.
  const fields = Object.keys(patch).filter((k) => patch[k as keyof ProviderPatch] !== undefined);
  await audit(deps.db, viewer, 'provider.update', id, {
    fields,
    ...(patch.headers !== undefined ? { headerNames: Object.keys(patch.headers) } : {}),
    ...(patch.apiKey === undefined && set.secrets === null ? { keyDropped: true } : {}),
    ...(headersDropped ? { headersDropped: true } : {}),
  });
  return getProvider(deps.db, viewer, id);
}

async function setSmallModel(
  db: Db,
  workspaceId: string,
  providerId: string,
  modelId: string | null,
) {
  const workspace = await getOrganization(db, workspaceId);
  const small = { ...storedSettings(workspace).smallModels };
  if (modelId) small[providerId] = modelId;
  else delete small[providerId];
  await updateSettings(db, workspace, { smallModels: small });
}

/** Refused with 409 while any Bot references the provider (L5). */
export async function deleteProvider(
  deps: ProvidersDeps,
  viewer: Viewer,
  id: string,
): Promise<void> {
  const row = await providerRow(deps.db, viewer, id);
  await deps.db.transaction(async (tx) => {
    // Serializes with Bot edits only loosely; a Bot moved onto the provider in
    // the same instant is caught by the runtime's provider-not-found error.
    const inUse = (await botCounts(tx, [id])).get(id) ?? 0;
    if (inUse > 0) throw providerInUse(inUse);
    await tx.delete(schema.providers).where(eq(schema.providers.id, id));
    await audit(tx, viewer, 'provider.delete', id, {});
  });
  providerRegistry(deps).invalidate(id);
  await setSmallModel(deps.db, row.workspaceId, id, null);
}

export async function upsertProviderModels(
  deps: ProvidersDeps,
  viewer: Viewer,
  providerId: string,
  input: { models: ModelInput[]; remove?: string[] },
): Promise<ProviderModelRow[]> {
  const row = await providerRow(deps.db, viewer, providerId);
  await deps.db.transaction(async (tx) => {
    const existing = new Map(
      (await modelRows(tx, [providerId])).map((m) => [m.modelId, m] as const),
    );
    for (const model of input.models) {
      const current = existing.get(model.modelId);
      if (!current) {
        await tx.insert(schema.providerModels).values(modelValues(row, model, 'manual'));
        continue;
      }
      const set: Partial<typeof schema.providerModels.$inferInsert> = {};
      if (model.displayName !== undefined) set.displayName = model.displayName;
      if (model.capabilities !== undefined) {
        const edited = model.capabilities;
        set.capabilities = storedCapabilities(
          { ...capabilitiesOf(current), ...edited },
          offByTest(current).filter((flag) => edited[flag] === undefined),
        );
      }
      if (model.pricing !== undefined) set.pricing = model.pricing;
      if (model.enabled !== undefined) set.enabled = model.enabled;
      if (Object.keys(set).length) {
        await tx
          .update(schema.providerModels)
          .set(set)
          .where(eq(schema.providerModels.id, current.id));
      }
    }
    if (input.remove?.length) {
      await tx
        .delete(schema.providerModels)
        .where(
          and(
            eq(schema.providerModels.providerId, providerId),
            inArray(schema.providerModels.modelId, input.remove),
          ),
        );
    }
    await audit(tx, viewer, 'provider.update', providerId, {
      models: input.models.map((m) => m.modelId),
      remove: input.remove ?? [],
    });
  });
  return modelRows(deps.db, [providerId]);
}

// --- Discover and test (L3) ----------------------------------------------------------

export async function discoverProviderModels(
  deps: ProvidersDeps,
  viewer: Viewer,
  providerId: string,
  options: { fetch?: typeof fetch } = {},
): Promise<{ added: number; models: ProviderModelRow[] }> {
  const row = await providerRow(deps.db, viewer, providerId);
  if (row.protocol !== 'openai_compatible') {
    throw invalid(
      'DISCOVERY_UNSUPPORTED',
      'Discover models works on OpenAI-compatible endpoints; add models by hand here',
    );
  }
  let discovered;
  try {
    discovered = await discoverModels(providerConfig(deps, row), options);
  } catch (err) {
    if (err instanceof DiscoveryError) throw new DomainError(502, 'DISCOVERY_FAILED', err.message);
    throw err;
  }
  // New ids join as `discovered`; anything already listed keeps its edits.
  const inserted = discovered.length
    ? await deps.db
        .insert(schema.providerModels)
        .values(
          discovered.map((m) => ({
            workspaceId: row.workspaceId,
            providerId: row.id,
            modelId: m.modelId,
            displayName: m.displayName,
            capabilities: m.capabilities,
            pricing: m.pricing,
            enabled: true,
            source: 'discovered' as const,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: schema.providerModels.id })
    : [];
  return { added: inserted.length, models: await modelRows(deps.db, [providerId]) };
}

/** The model a test uses: the one asked for, the preset's default, or the first with tools. */
function testTarget(row: ProviderRow, models: ProviderModelRow[], modelId?: string) {
  if (modelId) return models.find((m) => m.modelId === modelId);
  const enabled = models.filter((m) => m.enabled);
  const preferred = row.presetId
    ? presetById(row.presetId)?.models.find((m) => m.default)?.id
    : undefined;
  return (
    enabled.find((m) => m.modelId === preferred) ??
    enabled.find((m) => capabilitiesOf(m).tools) ??
    enabled[0]
  );
}

export function statusFor(result: ProviderTestResult): ProviderStatus {
  if (result.streaming && result.tools) return 'ok';
  return result.streaming ? 'degraded' : 'error';
}

/**
 * Runs the test, stores `{streaming, tools, latency_ms, error}` in
 * `test_result`, and turns off the tools flag on the model when tool calling
 * failed on an endpoint that streams. A later passing test turns it back on,
 * unless the user has set it by hand since (`off_by_test`), so one transient
 * failure does not hide the model for good. A failing endpoint is a result,
 * not an error.
 */
export async function testProvider(
  deps: AppDeps,
  viewer: Viewer,
  providerId: string,
  input: { modelId?: string } = {},
  options: { timeoutMs?: number } = {},
): Promise<ProviderRecord> {
  const row = await providerRow(deps.db, viewer, providerId);
  const models = await modelRows(deps.db, [providerId]);
  const target = testTarget(row, models, input.modelId);
  if (!target) {
    throw invalid(
      input.modelId ? 'UNKNOWN_MODEL' : 'NO_MODELS',
      input.modelId
        ? `No model ${input.modelId} on this provider`
        : 'Add a model or run Discover models before testing',
    );
  }
  let result: ProviderTestResult;
  try {
    const config = providerConfig(deps, row);
    const model =
      (await subscriptionModelFor(
        deps,
        config,
        { provider_id: providerId, model_id: target.modelId },
        viewer,
        capabilitiesOf(target),
      )) ?? createModelFactory(config)(target.modelId);
    result = await testModel(model, { modelId: target.modelId, timeoutMs: options.timeoutMs });
  } catch (err) {
    result = {
      model_id: target.modelId,
      streaming: false,
      tools: false,
      latency_ms: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  await deps.db.transaction(async (tx) => {
    await tx
      .update(schema.providers)
      .set({ status: statusFor(result), lastTestedAt: new Date(), testResult: result })
      .where(eq(schema.providers.id, providerId));
    const capabilities = capabilitiesOf(target);
    const off = offByTest(target);
    let next: object | null = null;
    if (result.streaming && !result.tools && capabilities.tools) {
      next = storedCapabilities({ ...capabilities, tools: false }, [...off, 'tools']);
    } else if (result.streaming && result.tools && off.includes('tools')) {
      next = storedCapabilities(
        { ...capabilities, tools: true },
        off.filter((flag) => flag !== 'tools'),
      );
    }
    if (next) {
      await tx
        .update(schema.providerModels)
        .set({ capabilities: next })
        .where(eq(schema.providerModels.id, target.id));
    }
  });
  return getProvider(deps.db, viewer, providerId);
}

// --- Registry ----------------------------------------------------------------------

/**
 * A row with its key and headers opened, for the adapters. Endpoints not
 * marked local are reached through the outbound guard.
 */
export function providerConfig(
  deps: Pick<AppDeps, 'config' | 'net'>,
  row: ProviderRow,
): ProviderConfig {
  return {
    id: row.id,
    kind: row.kind,
    protocol: row.protocol,
    slug: row.slug,
    baseUrl: row.baseUrl,
    headers: headerValues(deps, row),
    apiKey: row.secrets ? decryptSecretString(row.secrets, keyring(deps)) : null,
    presetId: row.presetId,
    updatedAt: row.updatedAt,
    ...(row.local ? {} : { fetch: netFetch(deps.net) }),
  };
}

export function providerSource(deps: ProvidersDeps): ProviderSource {
  return {
    async getProvider(providerId) {
      const [row] = await deps.db
        .select()
        .from(schema.providers)
        .where(eq(schema.providers.id, providerId));
      return row ? providerConfig(deps, row) : null;
    },
    async listModels(providerId) {
      return (await modelRows(deps.db, [providerId])).map(toProviderModel);
    },
  };
}

const registries = new WeakMap<Db, ProviderRegistry>();

/** One registry per database handle, so its cache is shared by routes and runs. */
export function providerRegistry(deps: ProvidersDeps): ProviderRegistry {
  let registry = registries.get(deps.db);
  if (!registry) {
    registry = new ProviderRegistry(providerSource(deps));
    registries.set(deps.db, registry);
  }
  return registry;
}

/**
 * The background-task model on a provider: the workspace's override, else the
 * preset's catalog small model, else the cheapest with tools (`pickSmallModel`).
 */
export async function smallModelFor(
  deps: ProvidersDeps,
  providerId: string,
): Promise<ProviderModel | null> {
  const [provider] = await deps.db
    .select({ presetId: schema.providers.presetId, workspaceId: schema.providers.workspaceId })
    .from(schema.providers)
    .where(eq(schema.providers.id, providerId));
  const workspace = provider ? await getOrganization(deps.db, provider.workspaceId) : null;
  const override = workspace ? storedSettings(workspace).smallModels?.[providerId] : undefined;
  const models = (await modelRows(deps.db, [providerId])).map(toProviderModel);
  return pickSmallModel(models, override, provider?.presetId);
}

async function audit(
  db: Db,
  viewer: Viewer,
  action: string,
  targetId: string,
  data: Record<string, unknown>,
) {
  await db.insert(schema.auditLog).values({
    workspaceId: viewer.workspaceId,
    actorType: 'user',
    actorId: viewer.id,
    action,
    targetType: 'provider',
    targetId,
    metadata: data,
  });
}
