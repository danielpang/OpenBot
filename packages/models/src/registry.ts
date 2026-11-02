import type { ModelCapabilities, ModelConfig, ModelPricing } from '@openbots/shared';
import type { LanguageModel } from 'ai';
import {
  createModelFactory,
  sdkFactories,
  type ModelFactory,
  type ProviderConfig,
  type SdkFactories,
} from './adapters.js';
import { presetById } from './catalog.js';
import { reasoningProviderOptions, type ProviderOptions } from './reasoning.js';
import { createToolNameMap, toolNameRules, type ToolNameMap } from './tool-names.js';

// The provider registry (plan 5.9). It loads providers and their models
// through a `ProviderSource` (the server reads Postgres and opens secrets),
// keeps one AI SDK provider instance per row, and rebuilds it when the row's
// `updatedAt` moves.

/** A `provider_models` row as the registry and the picker need it. */
export interface ProviderModel {
  providerId: string;
  modelId: string;
  displayName: string;
  capabilities: ModelCapabilities;
  pricing: ModelPricing | null;
  enabled: boolean;
}

export interface ProviderSource {
  getProvider(providerId: string): Promise<ProviderConfig | null>;
  listModels(providerId: string): Promise<ProviderModel[]>;
}

export interface ResolvedModel {
  model: LanguageModel;
  provider: ProviderConfig;
  /** Null when the model id is not in `provider_models` (the call is still attempted). */
  info: ProviderModel | null;
  /** Pass to `streamText`; carries the reasoning setting. */
  providerOptions: ProviderOptions;
  /** Builds the tool-name map for this provider's naming limits. */
  toolNames(names: Iterable<string>): ToolNameMap;
}

export class ProviderNotFoundError extends Error {
  constructor(readonly providerId: string) {
    super(`provider ${providerId} does not exist`);
    this.name = 'ProviderNotFoundError';
  }
}

export class ModelDisabledError extends Error {
  constructor(
    readonly providerId: string,
    readonly modelId: string,
  ) {
    super(`model ${modelId} is disabled on this provider`);
    this.name = 'ModelDisabledError';
  }
}

interface CacheEntry {
  version: number;
  factory: ModelFactory;
}

export class ProviderRegistry {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly source: ProviderSource,
    private readonly sdk: SdkFactories = sdkFactories,
  ) {}

  /** Drops a provider's cached instance; the next resolve rebuilds it. */
  invalidate(providerId: string): void {
    this.cache.delete(providerId);
  }

  /** The AI SDK provider instance for a row, cached until the row changes. */
  factoryFor(config: ProviderConfig): ModelFactory {
    const version = new Date(config.updatedAt).getTime();
    const hit = this.cache.get(config.id);
    if (hit && hit.version === version) return hit.factory;
    const factory = createModelFactory(config, this.sdk);
    this.cache.set(config.id, { version, factory });
    return factory;
  }

  /** A Bot's `model_config` to an AI SDK model. Changes apply on the next run (L5). */
  async resolve(
    modelConfig: Pick<ModelConfig, 'provider_id' | 'model_id' | 'reasoning'>,
  ): Promise<ResolvedModel> {
    const provider = await this.source.getProvider(modelConfig.provider_id);
    if (!provider) throw new ProviderNotFoundError(modelConfig.provider_id);
    const models = await this.source.listModels(provider.id);
    const info = models.find((m) => m.modelId === modelConfig.model_id) ?? null;
    if (info && !info.enabled) throw new ModelDisabledError(provider.id, info.modelId);
    const model = this.factoryFor(provider)(modelConfig.model_id);
    const rules = toolNameRules(provider);
    return {
      model,
      provider,
      info,
      providerOptions: reasoningProviderOptions(
        provider,
        modelConfig.reasoning,
        info?.capabilities.reasoning ?? false,
      ),
      toolNames: (names) => createToolNameMap(names, rules),
    };
  }

  /** The model for background tasks on a provider; see `pickSmallModel`. */
  async smallModel(
    providerId: string,
    overrideModelId?: string | null,
  ): Promise<ProviderModel | null> {
    const provider = await this.source.getProvider(providerId);
    return pickSmallModel(
      await this.source.listModels(providerId),
      overrideModelId,
      provider?.presetId,
    );
  }
}

/**
 * Small model for the classifier, label fallback and memory extraction (plan
 * 5.9), among the enabled models with tools: the override when it names an
 * enabled model, else the preset's catalog pick (`small` in `catalog.json`),
 * else the cheapest priced model (input plus output price), else the first
 * one, which is display-name order on an endpoint without pricing.
 */
export function pickSmallModel(
  models: readonly ProviderModel[],
  overrideModelId?: string | null,
  presetId?: string | null,
): ProviderModel | null {
  const enabled = models.filter((m) => m.enabled);
  if (overrideModelId) {
    const chosen = enabled.find((m) => m.modelId === overrideModelId);
    if (chosen) return chosen;
  }
  const withTools = enabled.filter((m) => m.capabilities.tools);
  const small = new Set(
    (presetId ? presetById(presetId)?.models : undefined)?.filter((m) => m.small).map((m) => m.id),
  );
  const picked = withTools.find((m) => small.has(m.modelId));
  if (picked) return picked;
  const price = (m: ProviderModel) => (m.pricing ? m.pricing.input + m.pricing.output : Infinity);
  const sorted = [...withTools].sort((a, b) => price(a) - price(b));
  return sorted[0] ?? null;
}
