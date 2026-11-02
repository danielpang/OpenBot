import type { ModelPricing } from '@openbots/shared';

// Cost estimates (plan 5.8, 5.9). Pricing comes from `provider_models.pricing`;
// when it is missing the answer is "no estimate", never a guess.

export interface TokenUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  /** Input tokens served from the provider's cache; part of `inputTokens`. */
  cachedInputTokens?: number | undefined;
}

/** US dollars, or null when the model has no pricing. */
export function estimateCost(
  usage: TokenUsage,
  pricing: ModelPricing | null | undefined,
): number | null {
  if (!pricing) return null;
  const input = usage.inputTokens ?? 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, input);
  const cachedRate = pricing.cached ?? pricing.input;
  const dollars =
    ((input - cached) * pricing.input +
      cached * cachedRate +
      (usage.outputTokens ?? 0) * pricing.output) /
    1_000_000;
  return dollars;
}
