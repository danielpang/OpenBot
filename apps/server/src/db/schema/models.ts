import { boolean, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { bytea, createdAt, id, timestamptz, updatedAt } from './columns.js';
import { workspaceId } from './workspace.js';

// Plan 4.10: Models and providers (L1 to L5). `bots.model_config.provider` holds a
// provider id; deleting a provider with Bots attached is refused in code (L5).

export const providerKind = pgEnum('provider_kind', [
  'anthropic',
  'openai',
  'google',
  'xai',
  'custom',
]);

export const providerProtocol = pgEnum('provider_protocol', [
  'native',
  'openai_compatible',
  'anthropic_compatible',
]);

export const providerDiscovery = pgEnum('provider_discovery', ['manual', 'list_models']);

export const modelSource = pgEnum('model_source', ['catalog', 'discovered', 'manual']);

/** Built-ins are seeded from `.env` keys at start; custom endpoints come from Settings (L1, L2). */
export const providers = pgTable(
  'providers',
  {
    id: id(),
    workspaceId: workspaceId(),
    /** Null for instance-level providers. */
    ownerId: uuid('owner_id').references(() => users.id),
    kind: providerKind('kind').notNull(),
    protocol: providerProtocol('protocol').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    baseUrl: text('base_url'),
    /** An admin marked the endpoint as on their own network, so it may be private (S-12). */
    local: boolean('local').notNull().default(false),
    /** Names of the extra request headers; their values are sealed in `header_secrets` (S-9). */
    headers: jsonb('headers').notNull().default({}),
    secrets: bytea('secrets'),
    /** The key's first few characters and "…", never more than half of it, to tell keys apart (P3). */
    keyHint: text('key_hint'),
    headerSecrets: bytea('header_secrets'),
    discovery: providerDiscovery('discovery').notNull().default('manual'),
    presetId: text('preset_id'),
    status: text('status').notNull(),
    lastTestedAt: timestamptz('last_tested_at'),
    testResult: jsonb('test_result'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique().on(t.workspaceId, t.ownerId, t.slug).nullsNotDistinct()],
);

/** Feeds `GET /models` and the picker (L3, L4). */
export const providerModels = pgTable(
  'provider_models',
  {
    id: id(),
    workspaceId: workspaceId(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    displayName: text('display_name').notNull(),
    /** tools, vision, reasoning, context_window, max_output. */
    capabilities: jsonb('capabilities').notNull().default({}),
    /** input, output, cached per 1M tokens. */
    pricing: jsonb('pricing'),
    enabled: boolean('enabled').notNull().default(true),
    source: modelSource('source').notNull(),
  },
  (t) => [unique().on(t.providerId, t.modelId)],
);
