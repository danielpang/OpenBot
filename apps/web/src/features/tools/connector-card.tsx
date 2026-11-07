import { Button, cn, Input } from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  catalogQuery,
  connectorToolsQuery,
  deleteConnector,
  isMcp,
  updateConnector,
  type CatalogEntry,
  type Connector,
  type UpdateConnector,
} from './api.js';
import { blockedText, useManaged } from '../../app/deployment.js';
import { LocalNetworkSetting, TrustedHintsSetting } from './block-list.js';
import { ConnectStatus, OAuthAdvanced, defaultCallbackUrl } from './catalog.js';
import { ErrorText, Labelled, SecretInputs } from './fields.js';
import { oauthClientBody, secretsPatch, signInAction, statusText } from './forms.js';
import { useTestConnector } from './hooks.js';
import { ConnectorIcon } from './icons.js';
import { needsClient, useOAuthConnect } from './oauth.js';

// One of the owner's connectors (T1): status and last error, Test, its tool
// list, one OAuth button (Connect before the first login, Reconnect once the
// tokens expired or were revoked; the same one-click flow), settings and
// write-only secrets (P3), and delete. A server that needs the owner's own
// OAuth client opens the settings at Advanced. For admins, a custom
// connector's tool list has the trusted-hints switch (S-16), and an HTTP
// connector has the "runs on my network" switch (S-8).

const STATUS_STYLES: Record<Connector['status'], string> = {
  untested: 'text-muted-foreground',
  ok: 'text-emerald-600',
  error: 'text-destructive',
  needs_auth: 'text-amber-600',
};

export function ConnectorCard({
  connector,
  entry,
  highlighted,
  admin,
}: {
  connector: Connector;
  entry: CatalogEntry | undefined;
  highlighted?: boolean;
  /** The viewer is a workspace admin. */
  admin?: boolean;
}) {
  const queryClient = useQueryClient();
  const [panel, setPanel] = useState<'tools' | 'settings' | 'delete' | null>(null);
  const test = useTestConnector();
  const { state: signIn, connect, reset } = useOAuthConnect();
  const clientRequired = signIn.phase === 'idle' && needsClient(signIn.error);
  const action = signInAction(connector);
  const remove = useMutation({
    mutationFn: () => deleteConnector(connector.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['connectors'] }),
  });
  const toggle = (next: typeof panel) => setPanel(panel === next ? null : next);
  const blocked = connector.disabledByAdmin;
  const managed = useManaged();

  return (
    <li
      id={`connector-${connector.id}`}
      data-connector={connector.id}
      className={cn(
        'flex scroll-mt-8 flex-col gap-2 rounded-lg border p-3 text-sm',
        highlighted && 'ring-2 ring-ring',
      )}
    >
      <div className="flex items-start gap-3">
        <ConnectorIcon icon={entry?.icon} name={connector.name} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium">{connector.name}</span>
          <span
            className={cn(
              'text-xs',
              blocked ? 'text-muted-foreground' : STATUS_STYLES[connector.status],
            )}
            data-status={connector.status}
          >
            {blocked ? blockedText(managed) : statusText(connector)}
            {isMcp(connector) &&
              connector.status === 'ok' &&
              ` · ${toolCount(connector.toolCount)}`}
            {connector.local && <span className="text-muted-foreground"> · on my network</span>}
          </span>
        </div>
      </div>
      {connector.lastError && !blocked && (
        <p className="break-words text-xs text-destructive">{connector.lastError}</p>
      )}
      {!blocked && (
        <div className="flex flex-wrap gap-1.5">
          {isMcp(connector) && (
            <Button
              size="sm"
              variant="outline"
              disabled={test.isPending}
              onClick={() => test.mutate(connector.id)}
            >
              {test.isPending ? 'Testing…' : 'Test'}
            </Button>
          )}
          {action && (
            <Button
              size="sm"
              disabled={signIn.phase === 'working' || signIn.phase === 'device'}
              onClick={() => {
                setPanel(null);
                connect(async () => connector);
              }}
            >
              {action}
            </Button>
          )}
          {isMcp(connector) && (
            <Button size="sm" variant="ghost" onClick={() => toggle('tools')}>
              Tools
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => toggle('settings')}>
            Settings
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => toggle('delete')}>
            Delete
          </Button>
        </div>
      )}
      {blocked && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => toggle('delete')}>
            Delete
          </Button>
        </div>
      )}
      {admin && !blocked && connector.kind === 'mcp_http' && (
        <LocalNetworkSetting connector={connector} />
      )}
      <ConnectStatus state={signIn} onCancel={reset} />
      <ErrorText
        error={
          test.error ??
          (signIn.phase === 'idle' && !clientRequired ? signIn.error : null) ??
          remove.error
        }
      />
      {panel === 'tools' && <ToolList connectorId={connector.id} />}
      {panel === 'tools' && admin && !connector.catalogId && (
        <TrustedHintsSetting connector={connector} />
      )}
      {(panel === 'settings' || clientRequired) && (
        <ConnectorSettings
          connector={connector}
          entry={entry}
          clientRequired={clientRequired}
          onDone={() => {
            setPanel(null);
            reset();
          }}
        />
      )}
      {panel === 'delete' && (
        <div className="flex items-center gap-2 border-t pt-2">
          <span className="text-muted-foreground">
            Delete {connector.name}, its login and its per-Bot settings?
          </span>
          <Button
            size="sm"
            variant="destructive"
            className="ml-auto"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>
            Cancel
          </Button>
        </div>
      )}
    </li>
  );
}

const toolCount = (n: number) => (n === 1 ? '1 tool' : `${n} tools`);

function ToolList({ connectorId }: { connectorId: string }) {
  const tools = useQuery(connectorToolsQuery(connectorId));
  if (tools.error) return <ErrorText error={tools.error} />;
  if (!tools.data) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (!tools.data.items.length) {
    return (
      <p className="border-t pt-2 text-xs text-muted-foreground">
        No tools yet. Test the connector to list them.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5 border-t pt-2">
      {tools.data.items.map((tool) => (
        <li key={tool.name} className="flex flex-col">
          <span>
            <code className="text-xs">{tool.name}</code>
            {tool.annotations.readOnlyHint === true && (
              <span className="ml-2 text-xs text-muted-foreground">read-only</span>
            )}
            {tool.annotations.destructiveHint === true && (
              <span className="ml-2 text-xs text-amber-600">destructive</span>
            )}
          </span>
          {tool.description && (
            <span className="line-clamp-2 text-xs text-muted-foreground">{tool.description}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Name, the catalog's settings, write-only secrets and the OAuth client. */
export function ConnectorSettings({
  connector,
  entry,
  clientRequired,
  onDone,
}: {
  connector: Connector;
  entry: CatalogEntry | undefined;
  /** Connect said the server needs the owner's own OAuth client: open Advanced. */
  clientRequired?: boolean;
  onDone(): void;
}) {
  const queryClient = useQueryClient();
  const catalog = useQuery(catalogQuery);
  const [name, setName] = useState(connector.name);
  const [params, setParams] = useState<Record<string, string>>(connector.params);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<string[]>([]);
  const [client, setClient] = useState({ clientId: '', clientSecret: '' });
  const save = useMutation({
    mutationFn: (body: Parameters<typeof updateConnector>[1]) =>
      updateConnector(connector.id, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['connectors'] });
      onDone();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const secretChanges = secretsPatch(secrets, removed);
    const oauthClient = oauthClientBody(client);
    const paramsChanged = JSON.stringify(params) !== JSON.stringify(connector.params);
    save.mutate({
      ...(name.trim() && name.trim() !== connector.name ? { name: name.trim() } : {}),
      ...(paramsChanged ? { params } : {}),
      ...(secretChanges ? { secrets: secretChanges } : {}),
      // The generated type for this nullable object is unusable (`& Record<string, never>`).
      ...(oauthClient ? { oauthClient: oauthClient as UpdateConnector['oauthClient'] } : {}),
    });
  }

  const declared = entry?.params ?? [];
  return (
    <form className="flex flex-col gap-3 border-t pt-3" onSubmit={submit}>
      <Labelled label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
      </Labelled>
      {declared.map((param) => (
        <Labelled
          key={param.name}
          label={param.label}
          note={param.required ? 'required' : 'optional'}
          help={param.description}
        >
          <Input
            value={params[param.name] ?? ''}
            onChange={(e) => setParams({ ...params, [param.name]: e.target.value })}
            required={param.required}
          />
        </Labelled>
      ))}
      <SecretInputs
        secrets={connector.secrets}
        values={secrets}
        onChange={setSecrets}
        removed={removed}
        onToggleRemove={(n) =>
          setRemoved(removed.includes(n) ? removed.filter((r) => r !== n) : [...removed, n])
        }
      />
      {connector.oauth && entry?.oauth?.dynamicRegistration !== true && (
        <OAuthAdvanced
          name={connector.name}
          githubDevice={connector.catalogId === 'github'}
          setupUrl={entry?.oauth?.clientSetupUrl}
          callbackUrl={catalog.data?.oauthCallbackUrl ?? defaultCallbackUrl()}
          value={client}
          onChange={setClient}
          open={clientRequired}
          why={
            clientRequired
              ? 'This server cannot register OpenBots by itself. Add your own OAuth app, then Connect.'
              : undefined
          }
          configured={connector.oauth.clientConfigured}
        />
      )}
      <ErrorText error={save.error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
