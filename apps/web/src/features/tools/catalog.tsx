import { Button, Input } from '@openbots/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { blockedText, useManaged } from '../../app/deployment.js';
import {
  catalogQuery,
  connectorsQuery,
  createConnector,
  updateConnector,
  type CatalogEntry,
  type CreateConnector,
  type UpdateConnector,
} from './api.js';
import { ErrorText, Labelled, SecretInputs } from './fields.js';
import {
  ALWAYS_ON,
  connectKind,
  isLegacyGitHubTool,
  needsForm,
  oauthClientBody,
  paramValues,
  signInAction,
} from './forms.js';
import { useConnectorsAdded } from './hooks.js';
import { ConnectorIcon } from './icons.js';
import { needsClient, useOAuthConnect, waitingText, type ConnectState } from './oauth.js';

// One-click connectors and built-ins from the catalog (T2). Connect on an
// entry whose provider registers OpenBots itself (dynamic registration) adds
// it and opens the provider's sign-in at once. An entry with required
// settings or keys asks for them first, then signs in. GitHub, Slack and
// Google need the owner's own OAuth app for now, entered under Advanced; a
// token works instead where the entry takes one. Blocked entries say
// "Disabled by admin", or "Blocked by policy" on a self-hosted install (T3).

export function Catalog() {
  const catalog = useQuery(catalogQuery);
  const connectors = useQuery(connectorsQuery);
  const added = new Set(connectors.data?.items.map((c) => c.catalogId));
  return (
    <section className="flex flex-col gap-3" aria-labelledby="catalog-title">
      <h2 id="catalog-title" className="font-medium">
        Add a connector
      </h2>
      <ErrorText error={catalog.error} />
      <ul className="grid gap-3 sm:grid-cols-2">
        {catalog.data?.items
          .filter((entry) => !isLegacyGitHubTool(entry.id))
          .map((entry) => (
            <CatalogCard key={entry.id} entry={entry} added={added.has(entry.id)} />
          ))}
      </ul>
    </section>
  );
}

type OAuthClient = { clientId: string; clientSecret?: string; githubAppSlug?: string };

export function CatalogCard({ entry, added }: { entry: CatalogEntry; added: boolean }) {
  const connectors = useQuery(connectorsQuery);
  const [form, setForm] = useState<'add' | 'token' | null>(null);
  const [clientMissing, setClientMissing] = useState(false);
  const managed = useManaged();
  const onAdded = useConnectorsAdded();
  const { state, connect, reset } = useOAuthConnect();
  const create = useMutation({
    mutationFn: createConnector,
    onSuccess: async (connector) => {
      setForm(null);
      await onAdded([connector]);
    },
  });
  const kind = connectKind(entry);
  const label = entry.kind === 'mcp_http' ? 'Connect' : 'Add';
  // The owner's sign-in connector from this entry, if they have one: Connect reuses it.
  const existing = connectors.data?.items.find((c) => c.catalogId === entry.id && c.oauth);
  const connected = existing && signInAction(existing) === null;
  const busy = create.isPending || state.phase === 'working' || state.phase === 'device';
  const askClient = clientMissing || (state.phase === 'idle' && needsClient(state.error));

  function signIn(body: CreateConnector, client?: OAuthClient) {
    connect(async () => {
      if (!existing) return createConnector(body);
      if (!client) return existing;
      // The generated type for this nullable object is unusable (`& Record<string, never>`).
      return updateConnector(existing.id, {
        oauthClient: client as UpdateConnector['oauthClient'],
      });
    });
  }

  function onConnect() {
    const clientReady = kind !== 'client' || existing?.oauth?.clientConfigured;
    if (needsForm(entry) || !clientReady) {
      setForm('add');
    } else if (kind === 'plain') {
      create.mutate({ catalogId: entry.id });
    } else {
      signIn({ catalogId: entry.id });
    }
  }

  function onSubmit(values: {
    params: Record<string, string>;
    secrets: Record<string, string>;
    client?: OAuthClient;
  }) {
    const body: CreateConnector = {
      catalogId: entry.id,
      ...(Object.keys(values.params).length ? { params: values.params } : {}),
      ...(Object.keys(values.secrets).length ? { secrets: values.secrets } : {}),
    };
    // A typed token signs in with it instead of OAuth.
    if (kind === 'plain' || Object.keys(values.secrets).length) {
      create.mutate(body);
      return;
    }
    if (kind === 'client' && !values.client && !existing?.oauth?.clientConfigured) {
      setClientMissing(true);
      return;
    }
    setClientMissing(false);
    setForm(null);
    signIn(values.client ? { ...body, oauthClient: values.client } : body, values.client);
  }

  let action;
  if (entry.disabledByAdmin) {
    action = <span className="text-xs text-muted-foreground">{blockedText(managed)}</span>;
  } else if (ALWAYS_ON.has(entry.id)) {
    action = <span className="text-xs text-muted-foreground">Always on</span>;
  } else if (connected) {
    action = <span className="text-xs text-emerald-600">Connected</span>;
  } else if (!form && !askClient) {
    action = (
      <Button size="sm" variant="outline" disabled={busy} onClick={onConnect}>
        {label}
      </Button>
    );
  }
  // A token instead of OAuth (Cloudflare, Supabase, Neon), for those who prefer one.
  const tokenOption =
    kind === 'oauth' && entry.secrets.length > 0 && !form && !connected && !entry.disabledByAdmin;

  return (
    <li
      className="flex flex-col gap-3 rounded-lg border p-3 text-sm"
      data-catalog={entry.id}
      data-disabled={entry.disabledByAdmin || undefined}
    >
      <div className="flex items-start gap-3">
        <ConnectorIcon icon={entry.icon} name={entry.name} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium">
            {entry.name}
            {added && kind === 'plain' && (
              <span className="ml-2 text-xs text-muted-foreground">added</span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">{entry.description}</span>
          {tokenOption && (
            <button
              type="button"
              className="self-start text-xs text-muted-foreground hover:underline"
              onClick={() => setForm('token')}
            >
              Use a token instead
            </button>
          )}
        </div>
        {action}
      </div>
      {(form || askClient) && !entry.disabledByAdmin && (
        <AddForm
          entry={entry}
          kind={form === 'token' ? 'token' : kind}
          label={label}
          clientRequired={askClient}
          clientConfigured={existing?.oauth?.clientConfigured}
          pending={busy}
          onCancel={() => {
            setForm(null);
            setClientMissing(false);
          }}
          onSubmit={onSubmit}
        />
      )}
      {(existing?.oauth?.installationUrl ?? entry.oauth?.installationUrl) && (
        <a
          href={existing?.oauth?.installationUrl ?? entry.oauth?.installationUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs underline"
        >
          Manage repositories
        </a>
      )}
      <ConnectStatus state={state} onCancel={reset} />
      <ErrorText error={create.error ?? (askClient ? null : idleError(state))} />
    </li>
  );
}

const idleError = (state: ConnectState) => (state.phase === 'idle' ? state.error : null);

/** The line under a Connect button while the sign-in is open, or the link when nothing could open. */
export function ConnectStatus({ state, onCancel }: { state: ConnectState; onCancel?: () => void }) {
  if (state.phase === 'device') {
    return (
      <div role="status" className="space-y-2 text-xs text-muted-foreground">
        <p>
          1.{' '}
          <a
            href={state.installationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Install the GitHub App
          </a>{' '}
          on your account or organization and select the repositories to share.
        </p>
        <p>2. Open GitHub authorization and enter this code:</p>
        <code className="block select-all text-lg font-semibold tracking-widest text-foreground">
          {state.userCode}
        </code>
        <p>
          <a
            href={state.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Open GitHub authorization
          </a>{' '}
          and approve access. This code expires at {new Date(state.expiresAt).toLocaleTimeString()}.
        </p>
        <p>Waiting for GitHub approval…</p>
        {onCancel && (
          <button type="button" className="underline" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    );
  }
  const text = waitingText(state);
  if (state.phase === 'blocked') {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Your browser blocked the sign-in window.{' '}
        <a href={state.url} target="_blank" rel="noopener" className="underline">
          Open the sign-in page
        </a>
      </p>
    );
  }
  return text ? (
    <p role="status" className="text-xs text-muted-foreground">
      {text}
    </p>
  ) : null;
}

function AddForm({
  entry,
  kind,
  label,
  clientRequired,
  clientConfigured,
  pending,
  onCancel,
  onSubmit,
}: {
  entry: CatalogEntry;
  /** `token` asks for the token only. */
  kind: 'oauth' | 'client' | 'plain' | 'token';
  label: string;
  /** The server needs the owner's OAuth client: open Advanced and say so. */
  clientRequired: boolean;
  clientConfigured?: boolean;
  pending: boolean;
  onCancel(): void;
  onSubmit(values: {
    params: Record<string, string>;
    secrets: Record<string, string>;
    client?: OAuthClient;
  }): void;
}) {
  const [params, setParams] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [client, setClient] = useState<{
    clientId: string;
    clientSecret: string;
    githubAppSlug?: string;
  }>({ clientId: '', clientSecret: '', githubAppSlug: '' });
  const [error, setError] = useState<string | null>(null);
  const catalog = useQuery(catalogQuery);

  function submit(event: FormEvent) {
    event.preventDefault();
    let values;
    try {
      values = paramValues(entry, params);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    const typed = Object.fromEntries(
      Object.entries(secrets)
        .map(([k, v]) => [k, v.trim()] as const)
        .filter(([, v]) => v),
    );
    if (kind === 'token' && !Object.keys(typed).length) {
      setError('Enter the token.');
      return;
    }
    const oauthClient = kind === 'client' ? oauthClientBody(client) : undefined;
    setError(null);
    onSubmit({ params: values, secrets: typed, ...(oauthClient ? { client: oauthClient } : {}) });
  }

  // The token of an OAuth entry is the other way in; an OAuth-only form shows none.
  const shownSecrets = kind === 'oauth' ? entry.secrets.filter((s) => s.required) : entry.secrets;
  return (
    <form className="flex flex-col gap-3 border-t pt-3" onSubmit={submit}>
      {kind !== 'token' &&
        entry.params.map((param) => (
          <Labelled
            key={param.name}
            label={param.label}
            note={param.required ? 'required' : 'optional'}
            help={param.description}
          >
            <Input
              name={`param:${param.name}`}
              value={params[param.name] ?? ''}
              onChange={(e) => setParams({ ...params, [param.name]: e.target.value })}
              required={param.required}
            />
          </Labelled>
        ))}
      {kind === 'client' && entry.secrets.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Paste a token, or add your own {entry.id === 'github' ? 'GitHub App' : 'OAuth app'} under
          Advanced.
        </p>
      )}
      {kind === 'client' && !entry.secrets.length && (
        <p className="text-xs text-muted-foreground">
          {`${entry.name} needs your own ${entry.id === 'github' ? 'GitHub App' : 'OAuth app'}. Add it under Advanced.`}
        </p>
      )}
      <SecretInputs secrets={shownSecrets} values={secrets} onChange={setSecrets} />
      {kind === 'client' && (
        <OAuthAdvanced
          name={entry.name}
          githubDevice={entry.id === 'github'}
          setupUrl={entry.oauth?.clientSetupUrl ?? null}
          callbackUrl={catalog.data?.oauthCallbackUrl ?? defaultCallbackUrl()}
          value={client}
          onChange={setClient}
          open={clientRequired}
          configured={clientConfigured}
        />
      )}
      <ErrorText
        error={error ?? (clientRequired ? 'Add your OAuth client under Advanced.' : null)}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {kind === 'token' ? 'Add' : label}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The owner's own OAuth client, folded under Advanced: only for servers that
 * cannot register OpenBots themselves. Says why, and the callback URL to
 * register, with a copy button.
 */
export function OAuthAdvanced({
  name,
  githubDevice = false,
  setupUrl,
  callbackUrl,
  value,
  onChange,
  open,
  why,
  configured,
}: {
  name: string;
  githubDevice?: boolean;
  setupUrl?: string | null;
  callbackUrl: string;
  value: { clientId: string; clientSecret: string; githubAppSlug?: string };
  onChange(value: { clientId: string; clientSecret: string; githubAppSlug?: string }): void;
  /** Opened, when the client is what is missing. */
  open?: boolean;
  /** The one line on why; says the server cannot register OpenBots by default. */
  why?: string;
  configured?: boolean;
}) {
  return (
    <details open={open || undefined} className="rounded-md border px-3 py-2 text-sm">
      <summary className="cursor-pointer select-none text-xs font-medium">Advanced</summary>
      <div className="flex flex-col gap-2 pt-2">
        <p className="text-xs text-muted-foreground">
          {githubDevice
            ? 'To use your own GitHub App, enable Device Flow and enter its public client ID and app slug. Install the app on selected repositories. No private key, client secret or callback is needed.'
            : (why ??
              `${name} cannot register OpenBots by itself, so it needs your own OAuth app.`)}
          {setupUrl && (
            <>
              {' '}
              <a href={setupUrl} target="_blank" rel="noreferrer" className="underline">
                Create one
              </a>
            </>
          )}
        </p>
        {!githubDevice && <CallbackUrl url={callbackUrl} />}
        <Labelled label="OAuth client ID" note={configured ? 'set' : undefined}>
          <Input
            name="oauth:clientId"
            value={value.clientId}
            onChange={(e) => onChange({ ...value, clientId: e.target.value })}
            placeholder={configured ? 'Enter a new client to replace it' : ''}
          />
        </Labelled>
        {githubDevice && (
          <Labelled
            label="GitHub App slug"
            help="The name in github.com/apps/your-app-slug, not the numeric app ID."
          >
            <Input
              name="oauth:githubAppSlug"
              value={value.githubAppSlug ?? ''}
              onChange={(e) => onChange({ ...value, githubAppSlug: e.target.value })}
            />
          </Labelled>
        )}
        {!githubDevice && (
          <Labelled
            label="OAuth client secret"
            note={githubDevice ? 'leave empty for device flow' : 'optional'}
          >
            <Input
              type="password"
              autoComplete="new-password"
              name="oauth:clientSecret"
              value={value.clientSecret}
              onChange={(e) => onChange({ ...value, clientSecret: e.target.value })}
            />
          </Labelled>
        )}
      </div>
    </details>
  );
}

function CallbackUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium">Callback URL</span>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={url}
          aria-label="Callback URL"
          className="font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

/** Where the server's callback is when it did not say (it always does). */
export const defaultCallbackUrl = () =>
  `${typeof window === 'undefined' ? '' : window.location.origin}/api/v1/connectors/oauth/callback`;
