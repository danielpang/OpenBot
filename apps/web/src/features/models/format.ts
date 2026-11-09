import type { ModelCapabilities, ProviderTestResult } from '@openbots/shared';

// Display helpers and form parsing shared by Settings > Models and the picker.

/** The built-in providers, in card order (L1). Their preset ids equal their kinds. */
export const BUILT_IN_KINDS = ['anthropic', 'openai', 'google', 'xai', 'ollama'] as const;

/** Presets offered by "Add custom model provider"; the generic ones stand behind "None". */
export const GENERIC_PRESETS = ['openai-compatible', 'anthropic-compatible'];

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });

export function formatTokens(tokens: number | null): string {
  if (tokens === null) return 'unknown';
  if (tokens >= 1_000_000) return `${number.format(Math.round(tokens / 10_000) / 100)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

export function capabilityList(capabilities: ModelCapabilities): string {
  const flags = (['tools', 'vision', 'reasoning'] as const).filter((flag) => capabilities[flag]);
  return flags.length ? flags.join(', ') : 'no tools';
}

export function testSummary(result: ProviderTestResult): string {
  const parts = [
    `streaming ${result.streaming ? 'works' : 'fails'}`,
    `tools ${result.tools ? 'work' : 'fail'}`,
  ];
  if (result.latency_ms !== null) parts.push(`${result.latency_ms} ms`);
  if (result.model_id) parts.push(result.model_id);
  return parts.join(' · ');
}

/** Why Delete is off for a provider Bots still use (L5); null when none do. */
export function providerInUseText(botCount: number): string | null {
  if (botCount <= 0) return null;
  return botCount === 1
    ? 'Used by 1 Bot. Move it to another provider first.'
    : `Used by ${botCount} Bots. Move them to another provider first.`;
}

/** `Name: value` lines to a headers object; blank lines are skipped. */
export function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error(`Write headers as "Name: value" (got "${line.trim()}")`);
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return headers;
}

/** One model id per line or comma-separated, de-duplicated in order. */
export function parseModelIds(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Discover persists new models server-side; the editor merges them into its
 * draft so unsaved edits to models it already lists survive. Returns the
 * merged list, new models appended in the server's order.
 */
export function mergeDiscovered<T extends { modelId: string }>(draft: T[], discovered: T[]): T[] {
  const known = new Set(draft.map((m) => m.modelId));
  return [...draft, ...discovered.filter((m) => !known.has(m.modelId))];
}
