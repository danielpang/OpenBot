import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import { speaksOpenAI, type ProviderKind, type ProviderProtocol } from '@openbots/shared';
import type { LanguageModel } from 'ai';
import { presetById } from './catalog.js';

// Adapters (plan 5.9): one AI SDK provider instance per `providers` row.
// Native kinds use their own package; custom endpoints speak either the
// OpenAI chat completions protocol or the Anthropic Messages protocol.

/** A `providers` row with its secret opened, as the registry needs it. */
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  protocol: ProviderProtocol;
  slug: string;
  baseUrl: string | null;
  headers: Record<string, string>;
  apiKey: string | null;
  presetId: string | null;
  /** Changes whenever the row does; the registry rebuilds the instance then. */
  updatedAt: Date;
  /** Makes every request; the server's outbound guard unless the endpoint is local. */
  fetch?: typeof fetch;
}

export type ModelFactory = (modelId: string) => LanguageModel;

/** The SDK factories, injectable so tests can stand in for them. */
export interface SdkFactories {
  createAnthropic: typeof createAnthropic;
  createOpenAI: typeof createOpenAI;
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI;
  createXai: typeof createXai;
  createOpenAICompatible: typeof createOpenAICompatible;
}

export const sdkFactories: SdkFactories = {
  createAnthropic,
  createOpenAI,
  createGoogleGenerativeAI,
  createXai,
  createOpenAICompatible,
};

/**
 * The header that carries the key. Presets say how (`api-key` for Azure,
 * `x-api-key` for Anthropic); endpoints without a preset use the protocol's.
 */
export function authFor(config: Pick<ProviderConfig, 'presetId' | 'protocol'>): {
  header: string;
  scheme: string | null;
} {
  const preset = config.presetId ? presetById(config.presetId) : undefined;
  if (preset) return preset.auth;
  return config.protocol === 'anthropic_compatible'
    ? { header: 'x-api-key', scheme: null }
    : { header: 'Authorization', scheme: 'Bearer' };
}

/** Request headers for a custom endpoint: the extra headers plus the key, if any. */
export function endpointHeaders(config: ProviderConfig): Record<string, string> {
  const headers = { ...config.headers };
  if (config.apiKey) {
    const auth = authFor(config);
    headers[auth.header] = auth.scheme ? `${auth.scheme} ${config.apiKey}` : config.apiKey;
  }
  return headers;
}

/**
 * Splits query parameters off a base URL. Azure OpenAI needs `api-version` on
 * every request, and the OpenAI-compatible adapter appends paths to the base.
 */
export function splitBaseUrl(baseUrl: string): {
  baseURL: string;
  queryParams: Record<string, string>;
} {
  const url = new URL(baseUrl);
  const queryParams = Object.fromEntries(url.searchParams);
  url.search = '';
  return { baseURL: url.toString().replace(/\/+$/, ''), queryParams };
}

export function createModelFactory(
  config: ProviderConfig,
  sdk: SdkFactories = sdkFactories,
): ModelFactory {
  const baseURL = config.baseUrl ?? undefined;
  const apiKey = config.apiKey ?? undefined;
  const headers = config.headers;
  const fetch = config.fetch;

  if (speaksOpenAI(config)) {
    if (!config.baseUrl) throw new Error(`provider ${config.slug} has no base URL`);
    const split = splitBaseUrl(config.baseUrl);
    const provider = sdk.createOpenAICompatible({
      name: config.slug,
      baseURL: split.baseURL,
      queryParams: split.queryParams,
      // The key goes in whichever header the endpoint expects, so it is set
      // here rather than through `apiKey`, which always means Bearer.
      headers: endpointHeaders(config),
      includeUsage: true,
      fetch,
    });
    return (modelId) => provider.chatModel(modelId);
  }

  if (config.protocol === 'anthropic_compatible') {
    if (!config.baseUrl) throw new Error(`provider ${config.slug} has no base URL`);
    const provider = sdk.createAnthropic({ baseURL: config.baseUrl, apiKey, headers, fetch });
    return (modelId) => provider(modelId);
  }

  switch (config.kind) {
    case 'anthropic': {
      const provider = sdk.createAnthropic({ baseURL, apiKey, headers, fetch });
      return (modelId) => provider(modelId);
    }
    case 'openai': {
      const provider = sdk.createOpenAI({ baseURL, apiKey, headers, fetch });
      return (modelId) => provider(modelId);
    }
    case 'google': {
      const provider = sdk.createGoogleGenerativeAI({ baseURL, apiKey, headers, fetch });
      return (modelId) => provider(modelId);
    }
    case 'xai': {
      const provider = sdk.createXai({ baseURL, apiKey, headers, fetch });
      return (modelId) => provider(modelId);
    }
    case 'ollama':
    case 'custom':
      throw new Error(
        `custom provider ${config.slug} needs an openai_compatible or anthropic_compatible protocol`,
      );
  }
}
