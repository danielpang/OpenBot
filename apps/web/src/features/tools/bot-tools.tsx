import { unwrap } from '@openbots/api-client';
import {
  acceptsEdits,
  withAcceptEdits,
  ACCEPT_EDITS_HELP,
  CODER_AGENT_LABELS,
  CODER_AGENTS,
  DEFAULT_CODER_ACTIONS,
  type CoderAgent,
  type PolicyDecision,
  type ToolGroupName,
  type ToolPolicy,
} from '@openbots/shared';
import { Button, Input, Select, Switch, Textarea } from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api, capabilitiesQuery } from '../../app/api.js';
import { blockedText, useManaged } from '../../app/deployment.js';
import { SettingsPanel, SettingsRow, SettingsSubheading } from '../../app/settings-layout.js';
import { botsQuery, type Bot } from '../bots/queries.js';
import { codersQuery } from '../coders/api.js';
import { reposQuery } from '../repos/api.js';
import {
  botConnectorsQuery,
  botToolsQuery,
  isMcp,
  putBotConnectors,
  type BotConnector,
  type BotConnectorPermission,
  type BotTool,
} from './api.js';
import { ErrorText } from './fields.js';
import { useCatalogIcon } from './hooks.js';
import { ConnectorIcon } from './icons.js';
import {
  CODER_ACTION_CLASSES,
  CODER_ACTION_LABELS,
  computerEnabled,
  connectorEnabled,
  connectorTools,
  DECISION_LABELS,
  defaultText,
  coderModelError,
  EDITED_GROUPS,
  GROUP_LABELS,
  GROUP_NOTES,
  groupTools,
  invalidCoderModels,
  parseHosts,
  permissionItems,
  readPolicy,
  serializePolicy,
  setAllowlist,
  setCoderModel,
  setCoderPolicy,
  setComputerEnabled,
  setConnectorEnabled,
  setDecision,
  setToolEnabled,
  toolEnabled,
  type AllowlistMode,
} from './policy.js';

// The Bot Settings "Tools and permissions" section (T1, T5): which of the
// owner's connectors and tools this Bot may use, and what each tool call
// gets: run without asking, ask first, or never, for every tool group and
// every tool. Each setting shows what it inherits, down to the policy
// engine's own default (`GET /bots/{id}/tools`), so leaving it on Default is
// a readable choice. The computer can be turned off for the Bot. Coding
// agents (CA9) get a default agent, a model per agent, the repositories they may use and a
// decision per action class under their group.

export function BotTools({ bot }: { bot: Bot }) {
  const connectors = useQuery(botConnectorsQuery(bot.id));
  const tools = useQuery(botToolsQuery(bot.id));
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const error = connectors.error ?? tools.error;
  if (error) return <ErrorText error={error} />;
  if (!connectors.data || !tools.data) return <p>Loading…</p>;
  return (
    <BotToolsForm
      // The form owns the settings while open; a new connector starts it afresh.
      key={[bot.id, ...connectors.data.items.map((i) => i.connector.id)].join()}
      bot={bot}
      entries={connectors.data.items}
      tools={tools.data.items}
      computer={capabilities?.computer ?? false}
    />
  );
}

export function BotToolsForm({
  bot,
  entries,
  tools,
  computer,
}: {
  bot: Bot;
  entries: BotConnector[];
  tools: BotTool[];
  /** Whether this install has a computer for its Bots. */
  computer: boolean;
}) {
  const queryClient = useQueryClient();
  const saved = readPolicy(bot.toolPolicy);
  const [policy, setPolicy] = useState<ToolPolicy>(saved);
  const [permissions, setPermissions] = useState(() => entries.map((e) => e.permission));
  const [hostsText, setHostsText] = useState((saved.httpAllowlist ?? []).join('\n'));
  const [mode, setMode] = useState<AllowlistMode>(saved.httpAllowlist ? 'list' : 'any');
  const hosts = parseHosts(hostsText);

  const save = useMutation({
    mutationFn: async () => {
      const toolPolicy = serializePolicy(setAllowlist(policy, mode, hosts.hosts));
      await unwrap(
        api.PATCH('/api/v1/bots/{id}', { params: { path: { id: bot.id } }, body: { toolPolicy } }),
      );
      return putBotConnectors(bot.id, permissionItems(permissions));
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: botsQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: botConnectorsQuery(bot.id).queryKey }),
      ]),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === 'list' && hosts.errors.length) return;
    if (invalidCoderModels(policy).length) return;
    save.mutate();
  }

  const decide = (scope: 'tools' | 'groups', name: string) => (d: PolicyDecision | undefined) =>
    setPolicy((p) => setDecision(p, scope, name, d));
  const updatePermission = (next: BotConnectorPermission) =>
    setPermissions((all) => all.map((p) => (p.connectorId === next.connectorId ? next : p)));
  const computerOn = computerEnabled(policy);

  const toolList = (group: ToolGroupName) => (
    <ToolList
      tools={groupTools(tools, group)}
      policy={policy}
      onDecision={(tool, d) => setPolicy((p) => setDecision(p, 'tools', tool, d))}
    />
  );

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} aria-label="Tools and permissions">
      <SettingsPanel>
        <SettingsRow
          title="Accept edits"
          description={ACCEPT_EDITS_HELP}
          control={
            <Select
              className="w-auto"
              aria-label="Accept edits"
              value={acceptsEdits(policy) ? 'on' : 'off'}
              onChange={(event) =>
                setPolicy((current) => withAcceptEdits(current, event.target.value === 'on'))
              }
            >
              <option value="off">Ask before edits</option>
              <option value="on">Accept edits</option>
            </Select>
          }
        />
      </SettingsPanel>
      <SettingsSubheading>Tool groups</SettingsSubheading>
      <SettingsPanel>
        {EDITED_GROUPS.filter((g) => g !== 'computer' && g !== 'connector').map((group) => (
          <SettingsRow
            key={group}
            data-group={group}
            title={GROUP_LABELS[group]}
            description={GROUP_NOTES[group]}
            control={
              <DecisionSelect
                label={GROUP_LABELS[group]}
                value={policy.groups?.[group]}
                inherited="Depends on the tool"
                onChange={decide('groups', group)}
              />
            }
          >
            {toolList(group)}
            {group === 'coder' && computer && policy.groups?.coder !== 'deny' && (
              <CoderSettings policy={policy} onChange={setPolicy} />
            )}
          </SettingsRow>
        ))}
      </SettingsPanel>

      <SettingsSubheading>Web requests</SettingsSubheading>
      <SettingsPanel>
        <fieldset className="flex flex-col gap-2 px-4 py-3">
          <legend className="float-left mb-1 font-medium text-foreground">
            Hosts HTTP request may call
          </legend>
          <label className="flex items-center gap-2 text-foreground">
            <input
              type="radio"
              name="http-allowlist"
              checked={mode === 'any'}
              onChange={() => setMode('any')}
            />
            Any public host
          </label>
          <label className="flex items-center gap-2 text-foreground">
            <input
              type="radio"
              name="http-allowlist"
              checked={mode === 'list'}
              onChange={() => setMode('list')}
            />
            Only these hosts
          </label>
          {mode === 'list' && (
            <div className="flex flex-col gap-1.5 pl-6">
              <Textarea
                aria-label="Allowed hosts"
                value={hostsText}
                onChange={(e) => setHostsText(e.target.value)}
                rows={3}
                placeholder={'api.example.com\n*.example.org'}
                className="w-full font-mono text-xs"
              />
              <span className="text-xs">One per line: a host, or *.domain for its subdomains.</span>
              {hosts.errors.length > 0 && (
                <ErrorText error={`Not a host: ${hosts.errors.join(', ')}`} />
              )}
            </div>
          )}
        </fieldset>
      </SettingsPanel>

      <SettingsSubheading>{GROUP_LABELS.computer}</SettingsSubheading>
      <SettingsPanel data-group="computer">
        {computer ? (
          <>
            <SettingsRow
              title="Use its computer"
              control={
                <Switch
                  aria-label="Use its computer"
                  checked={computerOn}
                  onChange={(e) => setPolicy((p) => setComputerEnabled(p, e.target.checked))}
                />
              }
              description={
                computerOn
                  ? GROUP_NOTES.computer
                  : 'Off: no computer tools, and no need for vision.'
              }
            />
            {computerOn && (
              <SettingsRow
                title={GROUP_LABELS.computer}
                control={
                  <DecisionSelect
                    label={GROUP_LABELS.computer}
                    value={policy.groups?.computer}
                    inherited="Depends on the tool"
                    // Never is the switch above.
                    choices={['auto', 'ask']}
                    onChange={decide('groups', 'computer')}
                  />
                }
              >
                {toolList('computer')}
              </SettingsRow>
            )}
          </>
        ) : (
          <p className="px-4 py-3 text-xs">This install has no computer for its Bots.</p>
        )}
      </SettingsPanel>

      <SettingsSubheading>Connectors</SettingsSubheading>
      <SettingsPanel data-group="connector">
        <SettingsRow
          title={GROUP_LABELS.connector}
          description={GROUP_NOTES.connector}
          control={
            <DecisionSelect
              label={GROUP_LABELS.connector}
              value={policy.groups?.connector}
              inherited="Depends on the tool"
              onChange={decide('groups', 'connector')}
            />
          }
        />
        {!entries.length && (
          <p className="px-4 py-3">
            No connectors yet. Add them on the{' '}
            <Link to="/connectors" className="underline">
              Connectors page
            </Link>
            .
          </p>
        )}
        {entries.map((entry) => (
          <ConnectorPermissions
            key={entry.connector.id}
            entry={entry}
            tools={connectorTools(tools, entry.connector.id)}
            permission={permissions.find((p) => p.connectorId === entry.connector.id)!}
            policy={policy}
            onPermission={updatePermission}
            onDecision={(tool, d) => setPolicy((p) => setDecision(p, 'tools', tool, d))}
          />
        ))}
      </SettingsPanel>

      <ErrorText error={save.error} />
      <div className="flex items-center gap-3 pt-1">
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
        {save.isSuccess && <span className="text-xs">Saved</span>}
      </div>
    </form>
  );
}

/** The Bot's coding agent settings (CA9): default agent, allowed repositories, action decisions. */
function CoderSettings({
  policy,
  onChange,
}: {
  policy: ToolPolicy;
  onChange(update: (p: ToolPolicy) => ToolPolicy): void;
}) {
  const repos = useQuery(reposQuery);
  const coders = useQuery(codersQuery);
  const coder = policy.coder ?? {};
  // Only the agents this build runs; a stored default stays listed so it can be changed.
  const runnable = coders.data?.agents
    ? coders.data.agents.filter((a) => a.available !== false).map((a) => a.agent)
    : coders.error
      ? CODER_AGENTS
      : [];
  const agentChoices = CODER_AGENTS.filter(
    (agent) => runnable.includes(agent) || agent === coder.defaultAgent,
  );
  // A model per agent the Bot can run; a stored one stays listed so it can be cleared.
  const modelAgents = CODER_AGENTS.filter(
    (agent) => runnable.includes(agent) || coder.models?.[agent] !== undefined,
  );
  const allowed = coder.allowedRepos ?? [];
  const known = (repos.data?.repos ?? []).map((r) => r.fullName);
  // A stored repository the owner has since forgotten stays listed, so it can be unticked.
  const names = [...known, ...allowed.filter((name) => !known.includes(name))];

  function toggleRepo(name: string, on: boolean) {
    const next = on ? [...allowed, name] : allowed.filter((n) => n !== name);
    onChange((p) => setCoderPolicy(p, { allowedRepos: next }));
  }

  function decideAction(
    action: (typeof CODER_ACTION_CLASSES)[number],
    d: PolicyDecision | undefined,
  ) {
    onChange((p) => {
      const actions = { ...p.coder?.actions };
      if (d) actions[action] = d;
      else delete actions[action];
      return setCoderPolicy(p, { actions });
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3" data-coder-settings>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-foreground">Default agent</span>
        <Select
          size="sm"
          aria-label="Default coding agent"
          value={coder.defaultAgent ?? ''}
          onChange={(e) =>
            onChange((p) =>
              setCoderPolicy(p, {
                defaultAgent: (e.target.value || undefined) as CoderAgent | undefined,
              }),
            )
          }
          className="max-w-64"
        >
          <option value="">Not set</option>
          {agentChoices.map((agent) => (
            <option key={agent} value={agent}>
              {CODER_AGENT_LABELS[agent]}
            </option>
          ))}
        </Select>
      </label>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-foreground">Model</legend>
        <span className="text-xs">Leave a field empty to use the agent&apos;s own default.</span>
        <ul className="flex flex-col gap-2">
          {modelAgents.map((agent) => {
            const value = coder.models?.[agent] ?? '';
            const problem = coderModelError(value);
            return (
              <li key={agent} className="flex flex-col gap-1" data-coder-model={agent}>
                <label className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 text-xs text-foreground">
                    {CODER_AGENT_LABELS[agent]}
                  </span>
                  <Input
                    type="text"
                    aria-label={`${CODER_AGENT_LABELS[agent]} model`}
                    aria-invalid={problem ? true : undefined}
                    placeholder="the agent's default"
                    value={value}
                    maxLength={100}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => onChange((p) => setCoderModel(p, agent, e.target.value))}
                    className="h-8 w-64 max-w-full font-mono text-xs placeholder:font-sans"
                  />
                </label>
                {problem && (
                  <span className="text-xs text-destructive" role="alert">
                    {problem}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-foreground">Allowed repositories</legend>
        <span className="text-xs">
          {allowed.length ? 'Only the ticked ones.' : 'None ticked: every repository you keep.'}
        </span>
        {names.length ? (
          <ul className="flex flex-col gap-1" aria-label="Allowed repositories">
            {names.map((name) => (
              <li key={name}>
                <label className="flex items-center gap-2 font-mono text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={allowed.includes(name)}
                    onChange={(e) => toggleRepo(name, e.target.checked)}
                  />
                  {name}
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-xs">No repositories yet. Add them on the Computer page.</span>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-foreground">What a session may do</legend>
        <ul className="divide-y rounded-md border bg-background/50">
          {CODER_ACTION_CLASSES.map((action) => (
            <li key={action} className={TOOL_ROW} data-coder-action={action}>
              <span className="min-w-0 flex-1 text-xs text-foreground">
                {CODER_ACTION_LABELS[action]}
              </span>
              <DecisionSelect
                label={`${CODER_ACTION_LABELS[action]} approval`}
                value={coder.actions?.[action]}
                inherited={DECISION_LABELS[DEFAULT_CODER_ACTIONS[action]]}
                onChange={(d) => decideAction(action, d)}
              />
            </li>
          ))}
        </ul>
        <p className="text-xs" data-coder-actions-note>
          {CODER_ACTIONS_NOTE}
        </p>
      </fieldset>
    </div>
  );
}

/** Under the action classes: which agents ask, and that a push always does. */
export const CODER_ACTIONS_NOTE =
  'Codex asks before leaving its sandbox. Accept edits applies to file edits; protected actions keep their own approval rules. Pushes always need your approval.';

/** A collapsed list under a row, one tool per line. */
function ToolDetails({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="inline-block transition-transform group-open:rotate-90">
          ›
        </span>
        {summary}
      </summary>
      <ul className="mt-2 divide-y rounded-md border bg-muted/30">{children}</ul>
    </details>
  );
}

const TOOL_ROW = 'flex flex-wrap items-center gap-2 px-3 py-1.5';

/** One select per tool, each defaulting to its group's setting or the engine's default. */
function ToolList({
  tools,
  policy,
  override,
  onDecision,
}: {
  tools: BotTool[];
  policy: ToolPolicy;
  /** The connector's approval setting, which comes before the group's. */
  override?: PolicyDecision | null;
  onDecision(tool: string, decision: PolicyDecision | undefined): void;
}) {
  const managed = useManaged();
  if (!tools.length) return null;
  return (
    <ToolDetails
      summary={`${tools.length === 1 ? 'One tool' : `${tools.length} tools`}, one setting each`}
    >
      {tools.map((tool) => (
        <li key={tool.name} className={TOOL_ROW} title={tool.why}>
          <code className="min-w-0 flex-1 truncate text-xs text-foreground">{tool.name}</code>
          {tool.disabledByAdmin && <span className="text-xs">{blockedText(managed)}</span>}
          <DecisionSelect
            label={`${tool.name} approval`}
            value={policy.tools?.[tool.name]}
            inherited={defaultText(policy, tool, override)}
            onChange={(d) => onDecision(tool.name, d)}
          />
        </li>
      ))}
    </ToolDetails>
  );
}

function ConnectorPermissions({
  entry,
  tools,
  permission,
  policy,
  onPermission,
  onDecision,
}: {
  entry: BotConnector;
  tools: BotTool[];
  permission: BotConnectorPermission;
  policy: ToolPolicy;
  onPermission(next: BotConnectorPermission): void;
  onDecision(tool: string, decision: PolicyDecision | undefined): void;
}) {
  const { connector } = entry;
  const iconOf = useCatalogIcon();
  const managed = useManaged();
  const mcp = isMcp(connector);
  const enabled = connectorEnabled(permission);
  // A built-in connector's tools are named as they are; an MCP tool's lists drop the prefix.
  const shortName = (tool: BotTool) =>
    mcp ? tool.name.slice(connector.slug.length + 2) : tool.name;

  return (
    <div className="flex flex-col gap-3 px-4 py-3" data-connector={connector.id}>
      <div className="flex flex-wrap items-center gap-3">
        <ConnectorIcon icon={iconOf(connector)} name={connector.name} />
        <label className="flex min-w-0 flex-1 items-center gap-2 font-medium text-foreground">
          <Switch
            checked={enabled}
            onChange={(e) => onPermission(setConnectorEnabled(permission, e.target.checked))}
          />
          {connector.name}
          {connector.disabledByAdmin && (
            <span className="text-xs font-normal text-muted-foreground">
              {blockedText(managed)}
            </span>
          )}
        </label>
        <DecisionSelect
          label={`${connector.name} approvals`}
          value={permission.approvalOverride ?? undefined}
          inherited="Per tool"
          onChange={(d) => onPermission({ ...permission, approvalOverride: d ?? null })}
        />
      </div>
      {enabled &&
        (mcp && !tools.length ? (
          <p className="text-xs">No tools yet. Test it on the Connectors page.</p>
        ) : (
          <ToolDetails
            summary={`${tools.filter((t) => toolEnabled(permission, shortName(t))).length} of ${tools.length} tools allowed`}
          >
            {tools.map((tool) => (
              <li key={tool.name} className={TOOL_ROW} title={tool.why}>
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={toolEnabled(permission, shortName(tool))}
                    onChange={(e) =>
                      onPermission(setToolEnabled(permission, shortName(tool), e.target.checked))
                    }
                  />
                  <code className="truncate text-xs text-foreground">{shortName(tool)}</code>
                </label>
                <DecisionSelect
                  label={`${shortName(tool)} approval`}
                  value={policy.tools?.[tool.name]}
                  inherited={defaultText(policy, tool, permission.approvalOverride)}
                  onChange={(d) => onDecision(tool.name, d)}
                />
              </li>
            ))}
          </ToolDetails>
        ))}
    </div>
  );
}

/** Default (and what that means here), or a decision of its own. */
export function DecisionSelect({
  label,
  value,
  inherited,
  choices = Object.keys(DECISION_LABELS) as PolicyDecision[],
  onChange,
}: {
  label: string;
  value: PolicyDecision | undefined;
  inherited: string;
  choices?: PolicyDecision[];
  onChange(value: PolicyDecision | undefined): void;
}) {
  return (
    <Select
      size="sm"
      aria-label={label}
      value={value ?? ''}
      onChange={(e) => onChange((e.target.value || undefined) as PolicyDecision | undefined)}
      className="max-w-64"
    >
      <option value="">{`Default: ${inherited}`}</option>
      {choices.map((d) => (
        <option key={d} value={d}>
          {DECISION_LABELS[d]}
        </option>
      ))}
    </Select>
  );
}
