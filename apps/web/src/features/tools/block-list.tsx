import { unwrap } from '@openbots/api-client';
import { CheckIcon, IconButton, Input, PlusIcon, Switch, XIcon } from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../app/api.js';
import { adminLabel, useManaged } from '../../app/deployment.js';
import { SettingsRow } from '../../app/settings-layout.js';
import { useSavedCheckbox } from '../../app/saved-checkbox.js';
import { settingsQuery } from '../settings/admin-settings.js';
import {
  connectorPolicyQuery,
  putConnectorPolicy,
  setConnectorLocal,
  setConnectorTrusted,
  type Connector,
} from './api.js';
import { ErrorText } from './fields.js';

// The admin restrictions: custom stdio servers on or off (S-1) and the blocked
// URL and command patterns (T3). A connector that matches a pattern shows as
// "Disabled by admin" to every member. Admins also choose which custom connectors' read-only hints to trust
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
  const label = managed ? 'Let admins add command servers' : 'Command servers';
  return (
    <SettingsRow
      title={label}
      description="Custom servers that run a program on the OpenBots server. Catalog servers are unaffected."
      control={<Switch aria-label={label} {...box} />}
    >
      <ErrorText error={error} />
    </SettingsRow>
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

/** URL and command patterns no connector may match (T3). Each change saves at once. */
export function BlockedAddresses() {
  const queryClient = useQueryClient();
  const policy = useQuery(connectorPolicyQuery);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const save = useMutation({
    mutationFn: putConnectorPolicy,
    onSuccess: (data) => {
      queryClient.setQueryData(connectorPolicyQuery.queryKey, data);
      return queryClient.invalidateQueries({ queryKey: ['connectors'] });
    },
  });
  const patterns = policy.data?.urlPatterns ?? [];

  function add(event: FormEvent) {
    event.preventDefault();
    const pattern = draft.trim();
    if (!pattern) return;
    save.mutate(
      { urlPatterns: [...patterns.filter((p) => p !== pattern), pattern] },
      {
        onSuccess: () => {
          setDraft('');
          setAdding(false);
        },
      },
    );
  }

  return (
    <SettingsRow
      title="Blocked addresses"
      description="URLs or commands no connector may use. * matches anything, such as https://*.example.com/* or npx *"
      control={
        <IconButton label="Block an address" onClick={() => setAdding((on) => !on)}>
          <PlusIcon />
        </IconButton>
      }
    >
      {adding && (
        <form className="flex items-center gap-1.5" onSubmit={add} aria-label="Block an address">
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
            placeholder="https://*.example.com/*"
            aria-label="Address pattern"
            className="h-8 font-mono text-xs"
          />
          <IconButton label="Add" type="submit" variant="default" busy={save.isPending}>
            <CheckIcon />
          </IconButton>
          <IconButton label="Cancel" onClick={() => setAdding(false)}>
            <XIcon />
          </IconButton>
        </form>
      )}
      {!!patterns.length && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Blocked addresses">
          {patterns.map((pattern) => (
            <li
              key={pattern}
              className="flex h-7 items-center gap-1 rounded-full border bg-background pr-1 pl-2.5 font-mono text-xs text-foreground"
            >
              {pattern}
              <button
                type="button"
                aria-label={`Unblock ${pattern}`}
                disabled={save.isPending}
                onClick={() => save.mutate({ urlPatterns: patterns.filter((p) => p !== pattern) })}
                className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <XIcon className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={policy.error ?? save.error} />
    </SettingsRow>
  );
}
