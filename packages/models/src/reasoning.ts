import {
  speaksOpenAI,
  type ModelConfig,
  type ProviderKind,
  type ProviderProtocol,
} from '@openbots/shared';
import type { JSONValue } from 'ai';

// `model_config.reasoning` to AI SDK `providerOptions` (plan 5.9). The Bot's
// setting is provider-neutral (`true` or a level); each provider spells it its
// own way. Models without the reasoning capability get nothing.

export type ProviderOptions = Record<string, Record<string, JSONValue>>;

type Level = 'low' | 'medium' | 'high';

export function reasoningProviderOptions(
  provider: { kind: ProviderKind; protocol: ProviderProtocol },
  reasoning: ModelConfig['reasoning'],
  modelCanReason: boolean,
): ProviderOptions {
  if (!modelCanReason || reasoning === undefined || reasoning === false) return {};
  const level: Level | undefined = reasoning === true ? undefined : reasoning;

  if (speaksOpenAI(provider)) {
    // `openaiCompatible` is the key the adapter reads whatever the endpoint's name.
    return { openaiCompatible: { reasoningEffort: level ?? 'medium' } };
  }
  if (provider.protocol === 'anthropic_compatible' || provider.kind === 'anthropic') {
    return {
      anthropic: { thinking: { type: 'adaptive' }, ...(level ? { effort: level } : {}) },
    };
  }
  switch (provider.kind) {
    case 'openai':
      return { openai: { reasoningEffort: level ?? 'medium' } };
    case 'xai':
      return { xai: { reasoningEffort: level ?? 'medium' } };
    case 'google':
      return {
        google: {
          thinkingConfig: { includeThoughts: true, ...(level ? { thinkingLevel: level } : {}) },
        },
      };
    default:
      return {};
  }
}
