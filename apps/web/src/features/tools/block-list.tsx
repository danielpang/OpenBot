import { unwrap } from '@openbots/api-client';
import { Button } from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../app/api.js';
import { adminLabel, useManaged } from '../../app/deployment.js';
import { useSavedCheckbox } from '../../app/saved-checkbox.js';
import { settingsQuery } from '../settings/admin-settings.js';
import {
  catalogQuery,
  connectorPolicyQuery,
  putConnectorPolicy,
  setConnectorLocal,
  setConnectorTrusted,
  type Connector,
  type ConnectorPolicy,
} from './api.js';
import { ErrorText, Labelled } from './fields.js';
import { lines } from './forms.js';

// The admin connector policy: custom stdio servers on or off (S-1), the block
// list (T3) of catalog entries by id and URL or command patterns, and the
// allow list (U3) of catalog entries. Blocked connectors, and while the allow
// list has entries everything not on it, show as "Disabled by admin" to every
// member. Admins also choose which custom connectors' read-only hints to trust
// (S-16), and which HTTP connectors run on their own network (S-8). On a
// self-hosted install the owner sets all of it, so nothing says "admin".

export function CustomStdioSetting() {
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery);
  const managed = useManaged();
  const { error, ...box } = useSavedCheckbox(
    settings.data?.customStdioEnabled ?? false,
    (customStdioEnabled) => unwrap(api.PATCH('/api/v1/settings', { body: { customStdioEnabled } })),
    (data) => {
      queryClient.setQueryData(settingsQuery.queryKey, data);
      return queryClient.invalidateQueries({ queryKey: ['connectors'] });
    },
  );
  if (!settings.data) return <ErrorText error={settings.error} />;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" {...box} />
        {managed ? 'Let admins add command (stdio) servers' : 'Allow command (stdio) servers'}
      </label>
      <p className="text-xs text-muted-foreground">
        They run programs on the OpenBots server. Catalog servers are unaffected.
      </p>
      <ErrorText error={error} />
    </div>
  );
}

/** Whether a custom connector's read-only tools may run without asking (S-16); catalog ones always may. */
export function TrustedHintsSetting({ connector }: { connector: Connector }) {
  const queryClient = useQueryClient();
  const managed = useManaged();
  const { error, ...box } = useSavedCheckbox(
    connector.trusted,
    (trusted) => setConnectorTrusted(connector.id, trusted),
    () => queryClient.invalidateQueries({ queryKey: ['connectors'] }),
  );
  return (
    <div className="flex flex-col gap-1 border-t pt-2 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" {...box} />
        {adminLabel(managed, 'trust its read-only hints')}
      </label>
      <p className="text-xs text-muted-foreground">
        Its read-only tools then run without asking, so trust only servers you know.
      </p>
      <ErrorText error={error} />
    </div>
  );
}

/** Whether an HTTP connector's server may be on a private or local address (S-8). */
export function LocalNetworkSetting({ connector }: { connector: Connector }) {
  const queryClient = useQueryClient();
  const managed = useManaged();
  const { error, ...box } = useSavedCheckbox(
    connector.local,
    (local) => setConnectorLocal(connector.id, local),
    () => queryClient.invalidateQueries({ queryKey: ['connectors'] }),
  );
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" {...box} />
        {adminLabel(managed, 'runs on my network (allows a private or local address)')}
      </label>
      <ErrorText error={error} />
    </div>
  );
}

export function BlockList() {
  const policy = useQuery(connectorPolicyQuery);
  if (policy.error) return <ErrorText error={policy.error} />;
  if (!policy.data) return null;
  return <BlockListForm key={JSON.stringify(policy.data)} saved={policy.data} />;
}

function BlockListForm({ saved }: { saved: ConnectorPolicy }) {
  const queryClient = useQueryClient();
  const catalog = useQuery(catalogQuery);
  const [ids, setIds] = useState<string[]>(saved.catalogIds);
  const [allowed, setAllowed] = useState<string[]>(saved.allowedCatalogIds);
  const [patterns, setPatterns] = useState(saved.urlPatterns.join('\n'));
  const save = useMutation({
    mutationFn: putConnectorPolicy,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: connectorPolicyQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: ['connectors'] }),
      ]),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate({ catalogIds: ids, urlPatterns: lines(patterns), allowedCatalogIds: allowed });
  }

  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((i) => i !== id);

  return (
    <form className="flex flex-col gap-3 text-sm" onSubmit={submit} aria-label="Block list">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 font-medium">Blocked catalog connectors</legend>
        {catalog.data?.items.map((entry) => (
          <label key={entry.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={ids.includes(entry.id)}
              onChange={(e) => {
                setIds(toggle(ids, entry.id, e.target.checked));
                if (e.target.checked) setAllowed(toggle(allowed, entry.id, false));
              }}
            />
            {entry.name}
            <span className="text-xs text-muted-foreground">{entry.id}</span>
          </label>
        ))}
      </fieldset>
      <Labelled
        label="Blocked URL and command patterns"
        help="One per line; * matches anything, e.g. https://*.example.com/* or npx *"
      >
        <textarea
          value={patterns}
          onChange={(e) => setPatterns(e.target.value)}
          rows={4}
          className="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
        />
      </Labelled>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 font-medium">Allowed catalog connectors</legend>
        <p className="text-xs text-muted-foreground">
          If any are ticked, only those are allowed, and no custom servers.
        </p>
        {catalog.data?.items.map((entry) => (
          <label key={entry.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allowed.includes(entry.id)}
              onChange={(e) => {
                setAllowed(toggle(allowed, entry.id, e.target.checked));
                if (e.target.checked) setIds(toggle(ids, entry.id, false));
              }}
            />
            {entry.name}
            <span className="text-xs text-muted-foreground">{entry.id}</span>
          </label>
        ))}
      </fieldset>
      <ErrorText error={save.error} />
      <div>
        <Button type="submit" size="sm" disabled={save.isPending}>
          Save connector policy
        </Button>
      </div>
    </form>
  );
}
