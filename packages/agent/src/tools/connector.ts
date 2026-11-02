import type { PolicyDecision } from '@openbots/shared';
import { z } from 'zod';
import type { ToolAnnotations } from '../policy/index.js';
import type { AnyAgentTool, LoginNotice, ToolContext, ToolGroup } from './types.js';

// Connector tools (plan 5.4, 8; T1, T4): one agent tool per MCP tool the Bot
// may use, named `${connectorSlug}__${toolName}`, with the input schema and
// annotations cached in `connector_tools`. The server lists them
// (`listToolsForBot`, which already applies the Bot's allow and deny lists and
// the admin block list) and calls them through the MCP manager; the policy
// engine reads the annotations and the connector's `approval_override`.

/** One entry of `listToolsForBot`. */
export interface ConnectorToolEntry {
  connectorId: string;
  connectorSlug: string;
  connectorName: string;
  tool: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  approvalOverride: PolicyDecision | null;
  /** The connector is from the catalog or an admin trusts it, so its hints are believed (S-16). */
  hintsTrusted?: boolean;
}

/** An MCP `tools/call` result. */
export interface ConnectorCallResult {
  content?: { type: string; text?: string; [key: string]: unknown }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface ConnectorTools {
  entries: ConnectorToolEntry[];
  /** Calls the tool through the MCP host; throws `ConnectorNeedsLogin` on a 401 or an expired login. */
  call(entry: ConnectorToolEntry, args: Record<string, unknown>): Promise<ConnectorCallResult>;
}

/** A connector refused the call for want of a (fresh) login. */
export class ConnectorNeedsLogin extends Error {
  constructor(
    readonly connectorId: string,
    readonly connectorName: string,
    message = `${connectorName} needs you to sign in again`,
  ) {
    super(message);
    this.name = 'ConnectorNeedsLogin';
  }
}

export const connectorToolName = (entry: Pick<ConnectorToolEntry, 'connectorSlug' | 'tool'>) =>
  `${entry.connectorSlug}__${entry.tool}`;

/** Text of an MCP result for the model; images and other blocks are counted, not inlined. */
const MAX_RESULT_CHARS = 40_000;

export function connectorResult(result: ConnectorCallResult): unknown {
  const blocks = result.content ?? [];
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
  if (result.isError) throw new Error(text || 'The connector reported an error');
  const other = blocks.filter((b) => b.type !== 'text').map((b) => b.type);
  return {
    ...(text ? { text: text.slice(0, MAX_RESULT_CHARS) } : {}),
    ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
    ...(other.length ? { other } : {}),
  };
}

/**
 * Runs a connector call; a missing login is told to the run (the Bot is
 * blocked once it ends) and comes back to the model as a plain error.
 */
export async function withLoginCheck<T>(ctx: ToolContext, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof ConnectorNeedsLogin)) throw error;
    const notice: LoginNotice = {
      connectorId: error.connectorId,
      connectorName: error.connectorName,
      message: error.message,
    };
    ctx.needsLogin?.(notice);
    throw new Error(
      `${error.connectorName} needs the owner to sign in again on the Connectors page. Tell them; ` +
        'do not retry this connector in this run.',
      { cause: error },
    );
  }
}

/** The cached JSON Schema as zod; a schema zod cannot read accepts any object. */
function inputSchemaOf(schema: Record<string, unknown>): z.ZodType {
  try {
    return z.fromJSONSchema({ type: 'object', ...schema } as never);
  } catch {
    return z.record(z.string(), z.unknown());
  }
}

function annotationsOf(raw: Record<string, unknown>): ToolAnnotations {
  const out: ToolAnnotations = {};
  for (const key of [
    'readOnlyHint',
    'destructiveHint',
    'idempotentHint',
    'openWorldHint',
  ] as const) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  if (typeof raw.title === 'string') out.title = raw.title;
  return out;
}

export function connectorTool(entry: ConnectorToolEntry, source: ConnectorTools): AnyAgentTool {
  const annotations = annotationsOf(entry.annotations ?? {});
  const title = entry.title ?? annotations.title;
  return {
    description: `${entry.connectorName}: ${entry.description ?? title ?? entry.tool}`.slice(
      0,
      1_024,
    ),
    inputSchema: inputSchemaOf(entry.inputSchema ?? {}),
    annotations,
    label: { connectorName: entry.connectorName, ...(title ? { toolTitle: title } : {}) },
    connector: {
      slug: entry.connectorSlug,
      approvalOverride: entry.approvalOverride,
      ...(entry.hintsTrusted ? { hintsTrusted: true } : {}),
    },
    deferred: true,
    execute: (args: never, ctx: ToolContext) =>
      withLoginCheck(ctx, async () =>
        connectorResult(await source.call(entry, (args ?? {}) as Record<string, unknown>)),
      ),
  };
}

export const connectorTools: ToolGroup = {
  name: 'connector',
  tools: (ctx) => {
    const source = ctx.connectors;
    if (!source) return {};
    const tools: Record<string, AnyAgentTool> = {};
    for (const entry of source.entries)
      tools[connectorToolName(entry)] = connectorTool(entry, source);
    return tools;
  },
};
