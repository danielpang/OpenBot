import { z } from 'zod';
import type { ModelConfig } from './bots.js';
import { resolveToolPolicy } from './policy.js';

// Model provider values (plan 4.10, 5.9; L1 to L5). `provider_models`
// capabilities and pricing and `providers.test_result` are jsonb columns, so
// their keys stay snake_case as the plan writes them. The server, the models
// package and the web picker read the same shapes.

export const ProviderKindSchema = z.enum(['anthropic', 'openai', 'google', 'xai', 'custom']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderProtocolSchema = z.enum([
  'native',
  'openai_compatible',
  'anthropic_compatible',
]);
export type ProviderProtocol = z.infer<typeof ProviderProtocolSchema>;

export const ProviderDiscoverySchema = z.enum(['manual', 'list_models']);
export type ProviderDiscovery = z.infer<typeof ProviderDiscoverySchema>;

export const ModelSourceSchema = z.enum(['catalog', 'discovered', 'manual']);
export type ModelSource = z.infer<typeof ModelSourceSchema>;

/**
 * `providers.status`: `untested` until the first test, `ok` when streaming and
 * tool calling work, `degraded` when only streaming does, `error` otherwise.
 */
export const ProviderStatusSchema = z.enum(['untested', 'ok', 'degraded', 'error']);
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const ModelCapabilitiesSchema = z.object({
  tools: z.boolean(),
  vision: z.boolean(),
  reasoning: z.boolean(),
  /** Tokens; null when unknown. */
  context_window: z.number().int().positive().nullable(),
  max_output: z.number().int().positive().nullable(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

/** What a model is assumed to do when nothing says otherwise; Test corrects it. */
export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  tools: true,
  vision: false,
  reasoning: false,
  context_window: null,
  max_output: null,
};

/** US dollars per 1M tokens. `cached` is the cached-input rate. */
export const ModelPricingSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cached: z.number().nonnegative().optional(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

/** `providers.test_result`, written by `POST /providers/:id/test`. */
export const ProviderTestResultSchema = z.object({
  model_id: z.string().nullable(),
  streaming: z.boolean(),
  tools: z.boolean(),
  latency_ms: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
});
export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>;

export const ModelNeedSchema = z.enum(['tools', 'vision', 'reasoning']);
export type ModelNeed = z.infer<typeof ModelNeedSchema>;

/** The needs a model lacks, in the order asked; empty when it has them all. */
export function missingCapabilities(
  capabilities: ModelCapabilities,
  needs: readonly ModelNeed[],
): ModelNeed[] {
  return needs.filter((need) => !capabilities[need]);
}

/**
 * Capability gating (plan 5.9): the picker hides models that fail this, and
 * the runtime checks it again at run start.
 */
export function modelSupports(
  model: { capabilities: ModelCapabilities },
  needs: readonly ModelNeed[],
): boolean {
  return missingCapabilities(model.capabilities, needs).length === 0;
}

/**
 * A Bot uses its computer when the install has one and the Bot's tool policy
 * does not deny the computer group (plan 5.4, L4).
 */
export function usesComputer(toolPolicy: unknown, computerAvailable: boolean): boolean {
  return computerAvailable && resolveToolPolicy(toolPolicy).groups.computer !== 'deny';
}

/**
 * What a Bot's model must support (plan 5.9, L4): tool calling always, and
 * vision when the Bot uses its computer, since the screen comes back as
 * screenshots.
 */
export function botModelNeeds(toolPolicy: unknown, computerAvailable: boolean): ModelNeed[] {
  return usesComputer(toolPolicy, computerAvailable) ? ['tools', 'vision'] : ['tools'];
}

/** Whether a provider speaks the Anthropic Messages API, natively or as a compatible endpoint. */
export function speaksAnthropic(provider: {
  kind: ProviderKind;
  protocol?: ProviderProtocol | undefined;
}): boolean {
  return provider.kind === 'anthropic' || provider.protocol === 'anthropic_compatible';
}

/**
 * The thinking setting a Bot gets with a model (plan 3): adaptive thinking
 * (`true`) on an Anthropic model that reasons, nothing otherwise.
 */
export function defaultReasoning(
  provider: { kind: ProviderKind; protocol?: ProviderProtocol | undefined },
  capabilities: Pick<ModelCapabilities, 'reasoning'>,
): ModelConfig['reasoning'] {
  return speaksAnthropic(provider) && capabilities.reasoning ? true : undefined;
}
