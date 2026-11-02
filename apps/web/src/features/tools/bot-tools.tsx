import { unwrap } from '@openbots/api-client';
import type { PolicyDecision, ToolGroupName, ToolPolicy } from '@openbots/shared';
import { Button } from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api, capabilitiesQuery } from '../../app/api.js';
import { blockedText, useManaged } from '../../app/deployment.js';
import { botsQuery, type Bot } from '../bots/queries.js';
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
  computerEnabled,
  connectorEnabled,
  connectorTools,
  DECISION_LABELS,
  defaultText,
  EDITED_GROUPS,
  GROUP_LABELS,
  GROUP_NOTES,
  groupTools,
  parseHosts,
  permissionItems,
  readPolicy,
  serializePolicy,
  setAllowlist,
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
// a readable choice. The computer can be turned off for the Bot.

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
    <form className="flex flex-col gap-5" onSubmit={submit} aria-label="Tools and permissions">
      <p>Choose whether each tool runs, asks you first, or is refused.</p>

      {EDITED_GROUPS.filter((g) => g !== 'computer' && g !== 'connector').map((group) => (
        <GroupSection
          key={group}
          group={group}
          value={policy.groups?.[group]}
          onChange={decide('groups', group)}
        >
          {toolList(group)}
        </GroupSection>
      ))}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium text-foreground">Hosts HTTP request may call</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="http-allowlist"
            checked={mode === 'any'}
            onChange={() => setMode('any')}
          />
          Any public host
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="http-allowlist"
            checked={mode === 'list'}
            onChange={() => setMode('list')}
          />
          Only these hosts
        </label>
        {mode === 'list' && (
          <>
            <textarea
              aria-label="Allowed hosts"
              value={hostsText}
              onChange={(e) => setHostsText(e.target.value)}
              rows={3}
              placeholder={'api.example.com\n*.example.org'}
              className="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs text-foreground"
            />
            <span className="text-xs">One per line: a host, or *.domain for its subdomains.</span>
            {hosts.errors.length > 0 && (
              <ErrorText error={`Not a host: ${hosts.errors.join(', ')}`} />
            )}
          </>
        )}
      </fieldset>

      <div className="flex flex-col gap-2" data-group="computer">
        <h3 className="font-medium text-foreground">{GROUP_LABELS.computer}</h3>
        {computer ? (
          <>
            <label className="flex items-center gap-2 text-foreground">
              <input
                type="checkbox"
                checked={computerOn}
                onChange={(e) => setPolicy((p) => setComputerEnabled(p, e.target.checked))}
              />
              Use its computer
            </label>
            <p className="text-xs">
              {computerOn
                ? GROUP_NOTES.computer
                : 'Off: no computer tools, and no need for vision.'}
            </p>
            {computerOn && (
              <>
                <Row label={GROUP_LABELS.computer}>
                  <DecisionSelect
                    label={GROUP_LABELS.computer}
                    value={policy.groups?.computer}
                    inherited="Depends on the tool"
                    // Never is the switch above.
                    choices={['auto', 'ask']}
                    onChange={decide('groups', 'computer')}
                  />
                </Row>
                {toolList('computer')}
              </>
            )}
          </>
        ) : (
          <p className="text-xs">This install has no computer for its Bots.</p>
        )}
      </div>

      <div className="flex flex-col gap-2" data-group="connector">
        <h3 className="font-medium text-foreground">Connectors</h3>
        <Row label={GROUP_LABELS.connector}>
          <DecisionSelect
            label={GROUP_LABELS.connector}
            value={policy.groups?.connector}
            inherited="Depends on the tool"
            onChange={decide('groups', 'connector')}
          />
        </Row>
        {!entries.length && (
          <p>
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
      </div>

      <ErrorText error={save.error} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
        {save.isSuccess && <span className="text-xs">Saved</span>}
      </div>
    </form>
  );
}

function GroupSection({
  group,
  value,
  onChange,
  children,
}: {
  group: ToolGroupName;
  value: PolicyDecision | undefined;
  onChange(value: PolicyDecision | undefined): void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2" data-group={group}>
      <h3 className="font-medium text-foreground">{GROUP_LABELS[group]}</h3>
      <p className="text-xs">{GROUP_NOTES[group]}</p>
      <Row label="Whole group">
        <DecisionSelect
          label={GROUP_LABELS[group]}
          value={value}
          inherited="Depends on the tool"
          onChange={onChange}
        />
      </Row>
      {children}
    </div>
  );
}

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
    <details>
      <summary className="cursor-pointer select-none text-xs">
        {tools.length === 1 ? 'One tool' : `${tools.length} tools`}, one setting each
      </summary>
      <ul className="mt-2 flex flex-col gap-1.5">
        {tools.map((tool) => (
          <li key={tool.name} className="flex flex-wrap items-center gap-2" title={tool.why}>
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
      </ul>
    </details>
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
    <div className="flex flex-col gap-2 rounded-lg border p-3" data-connector={connector.id}>
      <div className="flex flex-wrap items-center gap-3">
        <ConnectorIcon icon={iconOf(connector)} name={connector.name} />
        <label className="flex items-center gap-2 font-medium text-foreground">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onPermission(setConnectorEnabled(permission, e.target.checked))}
          />
          {connector.name}
        </label>
        {connector.disabledByAdmin && <span className="text-xs">{blockedText(managed)}</span>}
        <span className="ml-auto">
          <DecisionSelect
            label={`${connector.name} approvals`}
            value={permission.approvalOverride ?? undefined}
            inherited="Per tool"
            onChange={(d) => onPermission({ ...permission, approvalOverride: d ?? null })}
          />
        </span>
      </div>
      {enabled && (
        <details>
          <summary className="cursor-pointer select-none text-xs">
            {mcp && !tools.length
              ? 'No tools yet. Test it on the Connectors page.'
              : `${tools.filter((t) => toolEnabled(permission, shortName(t))).length} of ${tools.length} tools allowed`}
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {tools.map((tool) => (
              <li key={tool.name} className="flex flex-wrap items-center gap-2" title={tool.why}>
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
          </ul>
        </details>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 text-foreground">{label}</span>
      {children}
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
    <select
      aria-label={label}
      value={value ?? ''}
      onChange={(e) => onChange((e.target.value || undefined) as PolicyDecision | undefined)}
      className="h-8 rounded-md border bg-transparent px-2 text-xs text-foreground"
    >
      <option value="">{`Default: ${inherited}`}</option>
      {choices.map((d) => (
        <option key={d} value={d}>
          {DECISION_LABELS[d]}
        </option>
      ))}
    </select>
  );
}
