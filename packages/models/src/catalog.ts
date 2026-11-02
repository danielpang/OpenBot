import { readFileSync } from 'node:fs';
import {
  ModelCapabilitiesSchema,
  ModelPricingSchema,
  ProviderDiscoverySchema,
  ProviderKindSchema,
  ProviderProtocolSchema,
} from '@openbots/shared';
import { z } from 'zod';

// Presets for built-in providers and custom endpoints (plan 5.9, L2). The data
// lives in `catalog.json` at the package root so it can be edited without
// touching code; this module validates it once and serves lookups.

export const CatalogModelSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  /** The model a new Bot gets on this provider. */
  default: z.boolean().optional(),
  /** The preset's pick for background tasks when pricing cannot decide. */
  small: z.boolean().optional(),
  capabilities: ModelCapabilitiesSchema,
  pricing: ModelPricingSchema.optional(),
});
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

export const PresetSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    kind: ProviderKindSchema,
    protocol: ProviderProtocolSchema,
    /** May hold `{placeholders}` the user fills in (Azure). Null when the user must supply one. */
    base_url: z.url().nullable(),
    /** How the API key is sent: `<header>: [<scheme> ]<key>`. */
    auth: z.strictObject({ header: z.string().min(1), scheme: z.string().nullable() }),
    key_required: z.boolean(),
    /** Whether `GET {base_url}/models` lists the endpoint's models. */
    discovery: ProviderDiscoverySchema,
    /** The environment variable that seeds this provider at start (L1). */
    env: z.string().optional(),
    notes: z.string().optional(),
    models: z.array(CatalogModelSchema),
  })
  .refine((p) => (p.kind === 'custom') === (p.protocol !== 'native'), {
    message: 'built-in kinds use the native protocol; custom model providers do not',
  })
  .refine((p) => new Set(p.models.map((m) => m.id)).size === p.models.length, {
    message: 'model ids must be unique within a preset',
  })
  .refine((p) => p.models.filter((m) => m.default).length <= 1, {
    message: 'at most one default model per preset',
  });
export type Preset = z.infer<typeof PresetSchema>;

export const CatalogSchema = z
  .strictObject({ version: z.literal(1), presets: z.array(PresetSchema) })
  .refine((c) => new Set(c.presets.map((p) => p.id)).size === c.presets.length, {
    message: 'preset ids must be unique',
  });
export type Catalog = z.infer<typeof CatalogSchema>;

/** `catalog.json` sits one level above both `src/` and `dist/`. */
export const CATALOG_URL = new URL('../catalog.json', import.meta.url);

let cached: Catalog | undefined;

export function loadCatalog(): Catalog {
  cached ??= CatalogSchema.parse(JSON.parse(readFileSync(CATALOG_URL, 'utf8')));
  return cached;
}

export function presetById(id: string): Preset | undefined {
  return loadCatalog().presets.find((p) => p.id === id);
}

/** The preset each built-in kind is seeded from. */
export function builtinPreset(kind: Exclude<Preset['kind'], 'custom'>): Preset {
  const preset = presetById(kind);
  if (!preset) throw new Error(`catalog has no preset for ${kind}`);
  return preset;
}

/** Catalog data for a model id on a preset, if the catalog knows it. */
export function catalogModel(presetId: string | null, modelId: string): CatalogModel | undefined {
  if (!presetId) return undefined;
  return presetById(presetId)?.models.find((m) => m.id === modelId);
}
