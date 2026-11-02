import { DEFAULT_CAPABILITIES, type ModelCapabilities, type ModelPricing } from '@openbots/shared';
import { endpointHeaders, splitBaseUrl, type ProviderConfig } from './adapters.js';
import { catalogModel } from './catalog.js';

// Model discovery (plan 5.9, L3): `GET {base_url}/models` on OpenAI-compatible
// endpoints. Most return only ids; OpenRouter also returns context length,
// supported parameters, input modalities and per-token prices, which are used
// when present. The catalog's data wins for models it knows.

export interface DiscoveredModel {
  modelId: string;
  displayName: string;
  capabilities: ModelCapabilities;
  pricing: ModelPricing | null;
}

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

interface ListedModel {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  context_length?: unknown;
  supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown };
  top_provider?: { max_completion_tokens?: unknown };
  pricing?: { prompt?: unknown; completion?: unknown };
}

const positiveInt = (v: unknown) =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;

/** OpenRouter prices are dollars per token as strings. */
const perMillion = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000 * 1e6) / 1e6 : null;
};

export function parseModelList(body: unknown, presetId: string | null): DiscoveredModel[] {
  const data =
    (body as { data?: unknown } | null)?.data ?? (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(data)) throw new DiscoveryError('the provider did not return a model list');
  const seen = new Set<string>();
  const out: DiscoveredModel[] = [];
  for (const entry of data as ListedModel[]) {
    if (typeof entry?.id !== 'string' || !entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const known = catalogModel(presetId, entry.id);
    if (known) {
      out.push({
        modelId: entry.id,
        displayName: known.name,
        capabilities: known.capabilities,
        pricing: known.pricing ?? null,
      });
      continue;
    }
    const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : null;
    const modalities = Array.isArray(entry.architecture?.input_modalities)
      ? entry.architecture.input_modalities
      : null;
    const input = perMillion(entry.pricing?.prompt);
    const output = perMillion(entry.pricing?.completion);
    const name =
      typeof entry.name === 'string'
        ? entry.name
        : typeof entry.display_name === 'string'
          ? entry.display_name
          : entry.id;
    out.push({
      modelId: entry.id,
      displayName: name,
      capabilities: {
        tools: params ? params.includes('tools') : DEFAULT_CAPABILITIES.tools,
        vision: modalities ? modalities.includes('image') : DEFAULT_CAPABILITIES.vision,
        reasoning: params ? params.includes('reasoning') : DEFAULT_CAPABILITIES.reasoning,
        context_window: positiveInt(entry.context_length),
        max_output: positiveInt(entry.top_provider?.max_completion_tokens),
      },
      pricing: input !== null && output !== null ? { input, output } : null,
    });
  }
  return out;
}

export async function discoverModels(
  config: ProviderConfig,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<DiscoveredModel[]> {
  if (config.protocol !== 'openai_compatible' || !config.baseUrl) {
    throw new DiscoveryError('model discovery needs an OpenAI-compatible provider with a base URL');
  }
  const { baseURL, queryParams } = splitBaseUrl(config.baseUrl);
  const url = new URL(`${baseURL}/models`);
  for (const [k, v] of Object.entries(queryParams)) url.searchParams.set(k, v);
  const doFetch = options.fetch ?? config.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { accept: 'application/json', ...endpointHeaders(config) },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new DiscoveryError(`could not reach ${url.origin}: ${errorMessage(err)}`);
  }
  if (!res.ok)
    throw new DiscoveryError(`GET /models answered ${res.status} ${res.statusText}`.trim());
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new DiscoveryError('GET /models did not return JSON');
  }
  return parseModelList(body, config.presetId);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error && cause.message && !err.message.includes(cause.message)
      ? `${err.message} (${cause.message})`
      : err.message;
  }
  return String(err);
}
