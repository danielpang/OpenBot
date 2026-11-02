import { z } from 'zod';
import type { AnyAgentTool } from './types.js';

// Tool search (plan 5.4): above about 40 tools, sending every schema on every
// step costs more than it helps, so deferred tools (connector tools) are left
// out of the request and `search_tools` finds them. The run loop offers a
// tool once a search has returned it (`executeRun` tracks that, in provider
// spelling through the 1.3 name map).

export const SEARCH_TOOLS = 'search_tools';
export const TOOL_SEARCH_THRESHOLD = 40;
const MAX_MATCHES = 10;

export interface ToolMatch {
  name: string;
  description: string;
  input_schema: unknown;
}

/** Whether a run with these tools gets `search_tools` and defers its connector tools. */
export function needsToolSearch(tools: Record<string, Pick<AnyAgentTool, 'deferred'>>) {
  const names = Object.keys(tools);
  return names.length > TOOL_SEARCH_THRESHOLD && names.some((n) => tools[n]!.deferred);
}

function words(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

/** Deferred tools ranked by how many query words their name and description share. */
export function matchTools(tools: Record<string, AnyAgentTool>, query: string): ToolMatch[] {
  const wanted = new Set(words(query));
  const ranked: { name: string; score: number }[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.deferred) continue;
    const haystack = words(`${name} ${tool.label?.toolTitle ?? ''} ${tool.description}`);
    const score = haystack.filter((w) => wanted.has(w)).length;
    if (score > 0) ranked.push({ name, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return ranked.slice(0, MAX_MATCHES).map(({ name }) => ({
    name,
    description: tools[name]!.description,
    input_schema: z.toJSONSchema(tools[name]!.inputSchema, { unrepresentable: 'any' }),
  }));
}

export function searchToolsTool(tools: Record<string, AnyAgentTool>): AnyAgentTool {
  return {
    description:
      'Find more tools by what they do. This Bot has many connector tools and not all are ' +
      'offered at once: search with a few words (e.g. "create github issue"), then call a ' +
      'tool it returns.',
    inputSchema: z.object({ query: z.string().min(1).max(200) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async ({ query }: { query: string }) => ({ tools: matchTools(tools, query) }),
  } as AnyAgentTool;
}

/** Adds `search_tools` when the run has more tools than the threshold. */
export function withToolSearch(tools: Record<string, AnyAgentTool>): Record<string, AnyAgentTool> {
  if (!needsToolSearch(tools)) return tools;
  return { ...tools, [SEARCH_TOOLS]: searchToolsTool(tools) };
}
