import type { PolicyDecision, ToolGroupName } from '@openbots/shared';
import type { PolicyRule } from './policy.js';

// The built-in defaults (plan 8, T5): reads run, anything that can change
// something outside OpenBots asks. A tool is judged, in order, by a rule for
// its name, then by its annotations (MCP's, or a built-in's own), then by its
// group. Nothing here reads the Bot's settings; engine.ts layers those on top.
// An MCP server's read-only hint is its own claim, so it counts only for
// catalog connectors and those an admin marked trusted (S-16).

/** MCP tool annotations (spec 2025-06-18); built-in tools may declare the same hints. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** What the policy knows about a tool besides its name and arguments. */
export interface ToolFacts {
  group: ToolGroupName;
  annotations?: ToolAnnotations;
  /**
   * Connector tools: the connector's slug, the Bot's
   * `bot_connectors.approval_override`, and whether its tools' hints are
   * believed (a catalog connector, or one an admin marked trusted).
   */
  connector?: { slug: string; approvalOverride?: PolicyDecision | null; hintsTrusted?: boolean };
}

export interface DefaultRule {
  rule: Extract<PolicyRule, 'default' | 'annotations'>;
  decision: PolicyDecision;
  why: string;
  /** Can change something; a trigger override's `default` applies only to these. */
  sideEffects: boolean;
  /** A GET fetch: the host it reads from (null when the URL cannot be read); webhook runs check it. */
  fetchHost?: string | null;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const ask = (why: string): DefaultRule => ({
  rule: 'default',
  decision: 'ask',
  why,
  sideEffects: true,
});
const read = (why: string): DefaultRule => ({
  rule: 'default',
  decision: 'auto',
  why,
  sideEffects: false,
});
/** Runs, but can change something, so a trigger override's `default` still applies. */
const act = (why: string): DefaultRule => ({
  rule: 'default',
  decision: 'auto',
  why,
  sideEffects: true,
});
const onScreen = (name: string) => act(`${name} only operates the Bot's own screen`);

/** Rules for tools known by name, whatever group registers them. */
const NAMED_RULES: Record<string, (args: Record<string, unknown>) => DefaultRule> = {
  bash: () => ask('bash runs commands on the computer'),
  write_file: () => ask('write_file writes files'),
  edit_file: () => ask('edit_file writes files'),
  delete_file: () => ask('delete_file deletes files'),
  send_email: () => ask('send_email sends email on your behalf'),
  http_request: (args) => {
    const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
    return READ_METHODS.has(method)
      ? { ...read(`http_request ${method} only reads`), fetchHost: hostOf(args.url) }
      : ask(`http_request ${method} can change data on another server`);
  },
  read_file: () => read('read_file only reads'),
  list_files: () => read('list_files only reads'),
  list_dir: () => read('list_dir only reads'),
  browser_snapshot: () => read('browser_snapshot only reads the page'),
  browser_screenshot: () => read('browser_screenshot only reads the page'),
  browser_navigate: () => onScreen('browser_navigate'),
  browser_click: () => onScreen('browser_click'),
  browser_type: () => onScreen('browser_type'),
  browser_press: () => onScreen('browser_press'),
  computer: () => onScreen('computer'),
  web_search: () => read('web_search only reads'),
  web_fetch: (args) => ({ ...read('web_fetch only reads'), fetchHost: hostOf(args.url) }),
  // Starting a session runs; what the agent does inside it is judged action
  // by action (`coderActionDecision`), and pushes and pull requests ask (I7, I9).
  code_task: () =>
    act(
      'code_task starts a coding session; pushes, pull requests and risky commands ask inside it',
    ),
};

/** Tools whose default depends on the call's arguments, said before any call is made. */
const BY_ARGUMENTS: Record<string, { decision: PolicyDecision; why: string }> = {
  http_request: {
    decision: 'ask',
    why: 'GET, HEAD and OPTIONS requests run without asking; other methods ask first',
  },
};

/** A tool's default before any call, as Bot Settings shows it (T5). */
export interface DefaultSummary {
  decision: PolicyDecision;
  why: string;
  /** The decision depends on the call's arguments; `why` says how, `decision` is the stricter. */
  byArguments: boolean;
}

/** The engine's default for a tool, with no arguments known yet: what Bot Settings shows. */
export function defaultSummary(toolName: string, facts: ToolFacts): DefaultSummary {
  const varies = BY_ARGUMENTS[toolName];
  if (varies) return { ...varies, byArguments: true };
  const { decision, why } = defaultRule(toolName, {}, facts);
  return { decision, why, byArguments: false };
}

export function defaultRule(toolName: string, args: unknown, facts: ToolFacts): DefaultRule {
  const named = NAMED_RULES[toolName];
  if (named) return named(asRecord(args));

  const hints = facts.annotations;
  if (hints && hasHints(hints)) {
    if (
      hints.readOnlyHint === true &&
      facts.group === 'connector' &&
      !facts.connector?.hintsTrusted
    ) {
      return {
        ...ask(
          `${toolName} says it is read-only, but its connector is not from the catalog or trusted`,
        ),
        rule: 'annotations',
      };
    }
    if (hints.readOnlyHint === true) {
      const where = hints.openWorldHint === false ? '' : ', reaching outside OpenBots';
      return { ...read(`${toolName} is marked read-only${where}`), rule: 'annotations' };
    }
    const why = hints.destructiveHint
      ? `${toolName} is marked destructive`
      : `${toolName} is not marked read-only`;
    return { ...ask(why), rule: 'annotations' };
  }

  switch (facts.group) {
    case 'conversation':
      return read('Conversation tools only talk to you and use the Bot’s memory');
    case 'artifacts':
      return read('Artifact tools only write documents you can edit and roll back');
    case 'connector':
      // MCP's own default: a tool without hints may write and may be destructive.
      return ask(`${toolName} is a connector tool without a read-only hint`);
    default:
      return ask(`${toolName} is not known to be read-only`);
  }
}

function hasHints(hints: ToolAnnotations) {
  return (
    hints.readOnlyHint !== undefined ||
    hints.destructiveHint !== undefined ||
    hints.openWorldHint !== undefined
  );
}

function hostOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
