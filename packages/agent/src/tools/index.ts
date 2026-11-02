import { ToolGroupNameSchema, type ToolGroupName } from '@openbots/shared';
import { defaultSummary, type DefaultSummary, type ToolFacts } from '../policy/index.js';
import { artifactTools } from './artifacts.js';
import { builtinTools, NEEDS_CONNECTOR, TOOL_CONNECTOR, type BuiltinConnector } from './builtin.js';
import { computerTools } from './computer.js';
import { connectorTools } from './connector.js';
import { conversationTools } from './conversation.js';
import { routineTools } from './routines.js';
import { needsToolSearch, SEARCH_TOOLS, withToolSearch } from './search.js';
import type { AnyAgentTool, ToolContext, ToolGroup } from './types.js';

// Every tool group, in the order their tools are offered (stable, so provider
// prompt caches hit). Later phases add one line each.
export const TOOL_GROUPS: ToolGroup[] = [
  conversationTools,
  routineTools,
  artifactTools,
  builtinTools,
  connectorTools,
  computerTools,
];

function groupTools(ctx: ToolContext, groups: ToolGroup[]) {
  const tools: Record<string, AnyAgentTool> = {};
  for (const group of groups) Object.assign(tools, group.tools(ctx));
  return tools;
}

/**
 * The run's tools by name, with `search_tools` above the threshold (plan
 * 5.4). Tools named in `omit` are left out before the search index is built,
 * e.g. `IMAGE_TOOLS` for a model without vision (L4).
 */
export function toolsFor(
  ctx: ToolContext,
  groups: ToolGroup[] = TOOL_GROUPS,
  omit: readonly string[] = [],
) {
  const tools = groupTools(ctx, groups);
  for (const name of omit) delete tools[name];
  return withToolSearch(tools);
}

/** What the policy needs to know about each of the run's tools: its group and hints. */
export function toolFacts(ctx: ToolContext, groups: ToolGroup[] = TOOL_GROUPS) {
  const facts = new Map<string, ToolFacts>();
  for (const group of groups) {
    const name = ToolGroupNameSchema.safeParse(group.name);
    for (const [toolName, tool] of Object.entries(group.tools(ctx))) {
      facts.set(toolName, {
        group: name.success ? name.data : 'builtin',
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(tool.connector ? { connector: tool.connector } : {}),
      });
    }
  }
  if (needsToolSearch(groupTools(ctx, groups))) {
    facts.set(SEARCH_TOOLS, { group: 'conversation', annotations: { readOnlyHint: true } });
  }
  return facts;
}

/** A tool as Bot Settings lists it (T5): its group and the engine's default. */
export interface ToolDefault extends DefaultSummary {
  name: string;
  group: ToolGroupName;
  /** The built-in connector (catalog `builtin`) the tool belongs to, if any. */
  builtin: string | null;
  /** Offered only once the owner adds that built-in connector (email, GitHub). */
  needsConnector: boolean;
}

/**
 * Every tool a Bot can have besides its MCP connectors' (those come from the
 * cached tool lists), with the default the policy engine gives it. Each group
 * is asked with every optional service present, so none is left out; the
 * install and the Bot's connectors decide which a run really gets.
 */
export function everyToolDefault(groups: ToolGroup[] = TOOL_GROUPS): ToolDefault[] {
  const builtin = (id: string): BuiltinConnector => ({
    id,
    slug: id,
    name: id,
    approvalOverride: null,
    permits: () => true,
  });
  const present = {};
  const ctx = {
    run: { id: '', botId: '', chatId: null, trigger: 'message' },
    memory: present,
    artifacts: present,
    attachments: present,
    computer: present,
    bots: present,
    reactions: present,
    skills: present,
    logins: present,
    builtins: {
      connectors: Object.fromEntries(Object.values(TOOL_CONNECTOR).map((id) => [id, builtin(id)])),
    },
  } as unknown as ToolContext;
  const out: ToolDefault[] = [];
  for (const group of groups) {
    const name = ToolGroupNameSchema.safeParse(group.name);
    if (name.data === 'connector') continue;
    for (const [toolName, tool] of Object.entries(group.tools(ctx))) {
      const groupName = name.success ? name.data : 'builtin';
      const facts: ToolFacts = {
        group: groupName,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      };
      out.push({
        name: toolName,
        group: groupName,
        builtin: TOOL_CONNECTOR[toolName] ?? null,
        needsConnector: NEEDS_CONNECTOR.has(toolName),
        ...defaultSummary(toolName, facts),
      });
    }
  }
  return out;
}

export * from './artifacts.js';
export * from './attachments.js';
export * from './builtin.js';
export * from './computer.js';
export * from './connector.js';
export * from './conversation.js';
export * from './routines.js';
export * from './search.js';
export * from './types.js';
