import {
  CoderActionClassSchema,
  CoderModelNameSchema,
  DomainPatternSchema,
  resolveToolPolicy,
  ToolPolicySchema,
  type CoderAgent,
  type CoderPolicy,
  type PolicyDecision,
  type ToolGroupName,
  type ToolPolicy,
} from '@openbots/shared';
import type { BotConnectorPermission, BotTool } from './api.js';

// The Bot tools tab's model (T1, T5): the stored `tool_policy` in the strict
// shape from `@openbots/shared`, the per-connector allow and deny lists, and
// the defaults shown beside each setting. The defaults are the policy
// engine's own: `GET /bots/{id}/tools` lists every tool the Bot can have with
// the decision `@openbots/agent` gives it, so nothing here restates its rules.

export const DECISION_LABELS: Record<PolicyDecision, string> = {
  auto: 'Run without asking',
  ask: 'Ask first',
  deny: 'Never',
};

/** Every tool group, in the order the tab shows them. */
export const EDITED_GROUPS = [
  'conversation',
  'artifacts',
  'builtin',
  'connector',
  'computer',
  'coder',
] as const satisfies readonly ToolGroupName[];

export const GROUP_LABELS: Record<ToolGroupName, string> = {
  conversation: 'Conversation tools',
  artifacts: 'Artifact tools',
  builtin: 'Built-in tools',
  connector: 'Connector tools',
  computer: 'Computer tools',
  coder: 'Coding agents',
};

export const GROUP_NOTES: Record<ToolGroupName, string> = {
  conversation:
    'Widgets, questions, memory, reactions, Skills, Routines and messages to other Bots.',
  artifacts: 'Artifacts and the files attached to the chat.',
  builtin: 'On for every Bot unless set to Never or blocked.',
  connector: "Tools from your connectors; each connector's own setting wins.",
  computer: "The shell, files, browser and screen of the Bot's computer.",
  coder: 'Claude Code, Codex and pi, working in a repository on the computer.',
};

/** The tools of one group that sit in the group's own list, not under a connector. */
export function groupTools(tools: readonly BotTool[], group: ToolGroupName): BotTool[] {
  return tools.filter((t) => t.group === group && !t.needsConnector);
}

/** A connector's tools: its MCP tools, or a built-in connector's (Email, GitHub, Web search). */
export function connectorTools(tools: readonly BotTool[], connectorId: string): BotTool[] {
  return tools.filter((t) => t.connectorId === connectorId);
}

/** Whether the Bot may use its computer: `groups.computer = deny` turns it off (plan 5.4, L4). */
export const computerEnabled = (policy: ToolPolicy) => policy.groups?.computer !== 'deny';

/** Turns computer use off (`groups.computer = deny`), or back on with the defaults. */
export function setComputerEnabled(policy: ToolPolicy, enabled: boolean): ToolPolicy {
  return setDecision(policy, 'groups', 'computer', enabled ? undefined : 'deny');
}

/** What Default means for one tool: its group's or connector's setting, else the engine's default. */
export function defaultText(
  policy: ToolPolicy,
  tool: Pick<BotTool, 'decision' | 'why' | 'byArguments' | 'group'>,
  override?: PolicyDecision | null,
): string {
  const set = override ?? resolveToolPolicy(policy).groups[tool.group];
  if (set) return DECISION_LABELS[set];
  return tool.byArguments ? tool.why : DECISION_LABELS[tool.decision];
}

/** Sets or clears (`undefined`) one tool's or group's decision; empty maps are dropped. */
export function setDecision(
  policy: ToolPolicy,
  scope: 'tools' | 'groups',
  name: string,
  decision: PolicyDecision | undefined,
): ToolPolicy {
  const map: Record<string, PolicyDecision> = { ...policy[scope] };
  if (decision) map[name] = decision;
  else delete map[name];
  const { [scope]: _old, ...rest } = policy;
  return Object.keys(map).length ? { ...rest, [scope]: map } : rest;
}

export type AllowlistMode = 'any' | 'list';

/** `httpAllowlist`: absent allows every public host, a list allows those hosts (empty: none). */
export function setAllowlist(
  policy: ToolPolicy,
  mode: AllowlistMode,
  hosts: readonly string[],
): ToolPolicy {
  const { httpAllowlist: _old, ...rest } = policy;
  return mode === 'any' ? rest : { ...rest, httpAllowlist: [...hosts] };
}

/** Allowlist text, one host per line, as patterns; the lines that are not hosts come back as errors. */
export function parseHosts(text: string): { hosts: string[]; errors: string[] } {
  const hosts: string[] = [];
  const errors: string[] = [];
  for (const line of text.split(/[\n,]/)) {
    if (!line.trim()) continue;
    const parsed = DomainPatternSchema.safeParse(line);
    if (parsed.success) {
      if (!hosts.includes(parsed.data)) hosts.push(parsed.data);
    } else errors.push(line.trim());
  }
  return { hosts, errors };
}

/** A stored `tool_policy` read for editing; anything unreadable starts empty. */
export function readPolicy(stored: unknown): ToolPolicy {
  const parsed = ToolPolicySchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : {};
}

/** What `PATCH /bots/{id}` gets; throws if the editor produced something the server would refuse. */
export function serializePolicy(policy: ToolPolicy): ToolPolicy {
  return ToolPolicySchema.parse(JSON.parse(JSON.stringify(policy)));
}

// Per-connector permissions (`bot_connectors`): no row means every tool with
// the policy's approvals; `toolAllowlist: []` turns the connector off for the
// Bot; the deny list wins over the allow list.

export const defaultPermission = (connectorId: string): BotConnectorPermission => ({
  connectorId,
  toolAllowlist: null,
  toolDenylist: [],
  approvalOverride: null,
});

export const connectorEnabled = (p: BotConnectorPermission) =>
  p.toolAllowlist === null || p.toolAllowlist.length > 0;

export function setConnectorEnabled(
  p: BotConnectorPermission,
  enabled: boolean,
): BotConnectorPermission {
  return { ...p, toolAllowlist: enabled ? null : [] };
}

export const toolEnabled = (p: BotConnectorPermission, tool: string) =>
  (p.toolAllowlist === null || p.toolAllowlist.includes(tool)) && !p.toolDenylist.includes(tool);

export function setToolEnabled(
  p: BotConnectorPermission,
  tool: string,
  enabled: boolean,
): BotConnectorPermission {
  const deny = p.toolDenylist.filter((t) => t !== tool);
  if (!enabled) return { ...p, toolDenylist: [...deny, tool] };
  const allow =
    p.toolAllowlist === null || p.toolAllowlist.includes(tool)
      ? p.toolAllowlist
      : [...p.toolAllowlist, tool];
  return { ...p, toolAllowlist: allow, toolDenylist: deny };
}

export const isDefaultPermission = (p: BotConnectorPermission) =>
  p.toolAllowlist === null && p.toolDenylist.length === 0 && p.approvalOverride === null;

/** The `PUT /bots/{id}/connectors` items: only connectors that differ from the defaults. */
export const permissionItems = (permissions: readonly BotConnectorPermission[]) =>
  permissions.filter((p) => !isDefaultPermission(p));

/** The action classes a coding session asks about, in the order the tab shows them (CA9). */
export const CODER_ACTION_CLASSES = CoderActionClassSchema.options;

export const CODER_ACTION_LABELS: Record<(typeof CODER_ACTION_CLASSES)[number], string> = {
  push: 'Push a branch',
  pr: 'Open a pull request',
  outside_worktree: 'Work outside its worktree',
  install: 'Install packages',
  destructive: 'Delete or rewrite history',
  other: 'Anything else in its worktree',
};

/**
 * Changes the Bot's `coder` settings: `undefined` clears a field, an empty
 * `allowedRepos` means every repository (the field is dropped), and nothing
 * left drops `coder` altogether, so an untouched Bot stores nothing.
 */
export function setCoderPolicy(policy: ToolPolicy, patch: Partial<CoderPolicy>): ToolPolicy {
  const next: CoderPolicy = { ...policy.coder };
  for (const [key, value] of Object.entries(patch) as [keyof CoderPolicy, unknown][]) {
    if (value === undefined) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  if (next.actions && !Object.keys(next.actions).length) delete next.actions;
  if (next.allowedRepos && !next.allowedRepos.length) delete next.allowedRepos;
  const { coder: _old, ...rest } = policy;
  return Object.keys(next).length ? { ...rest, coder: next } : rest;
}

/**
 * Sets the model one agent runs with (`coder.models[agent]`); an empty
 * field removes the key, so the agent uses its own default again.
 */
export function setCoderModel(policy: ToolPolicy, agent: CoderAgent, value: string): ToolPolicy {
  const models = { ...policy.coder?.models };
  if (value.trim()) models[agent] = value;
  else delete models[agent];
  return setCoderPolicy(policy, { models: Object.keys(models).length ? models : undefined });
}

/** Why a model name would be refused, or null when it is fine (or empty). */
export function coderModelError(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const parsed = CoderModelNameSchema.safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Not a model name');
}

/** The agents whose model name would be refused. */
export function invalidCoderModels(policy: ToolPolicy): CoderAgent[] {
  return (Object.entries(policy.coder?.models ?? {}) as [CoderAgent, string][])
    .filter(([, value]) => coderModelError(value))
    .map(([agent]) => agent);
}
