import { ApiError } from '@openbots/api-client';
import {
  Button,
  ChevronDownIcon,
  cn,
  ExternalIcon,
  IconButton,
  Input,
  RefreshIcon,
  Select,
  TrashIcon,
  UnlinkIcon,
} from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { GitActAs } from '@openbots/shared';
import { useManaged } from '../../app/deployment.js';
import {
  ACT_AS_NEEDS_SIGN_IN,
  addTokenConnection,
  ago,
  disconnect,
  GITHUB_APP_INSTALL_PATH,
  gitConnectionsQuery,
  githubAppQuery,
  reauthorizePath,
  removeGithubApp,
  startAppManifest,
  submitManifest,
  syncConnection,
  updateConnection,
  type GitConnectionView,
  type GithubAppStatus,
} from '../repos/api.js';
import { connectorsQuery } from './api.js';
import { RepoPicker } from '../repos/picker.js';
import { GitDeviceConnect, useGitDeviceConnection } from '../repos/github-device.js';
import { CommitIdentity } from './commit-identity.js';
import { ErrorText } from './fields.js';
import { ConnectorIcon } from './icons.js';

// The Connectors page's GitHub card for coding agents (GH1, GH2, GH8): install
// the OpenBots GitHub App (or, on a self-hosted install without one, create
// it through GitHub's manifest flow), or paste a fine-grained token. Each
// connection shows inline account details, status, repository count, who pull
// requests are opened as (App connections only), Sync, Disconnect and Pick
// repositories. A sync that finds GitHub wants the owner to grant access
// again offers Re-check access. GitHub sends the browser back with
// `?github_app=created` after the App is made and `?connection=<id>` after
// an install, which opens the picker.

export interface GithubArrival {
  githubApp?: 'created';
  connection?: string;
}

const STATUS: Record<GitConnectionView['status'], { label: string; tone: string }> = {
  pending: { label: 'Awaiting authorization', tone: 'bg-muted text-muted-foreground' },
  connected: {
    label: 'Connected',
    tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  },
  needs_reinstall: {
    label: 'Needs reinstall',
    tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  },
  revoked: { label: 'Revoked', tone: 'bg-destructive/15 text-destructive' },
  error: { label: 'Error', tone: 'bg-destructive/15 text-destructive' },
};

const KIND: Record<GitConnectionView['kind'], string> = {
  app: 'GitHub App',
  device: 'GitHub App · device authorization',
  oauth: 'Signed in with GitHub',
  token: 'Token',
};

const repoCount = (n: number) => (n === 1 ? '1 repository' : `${n} repositories`);

/** Sends the browser to GitHub's install page for this install's App. */
export function goToInstall() {
  window.location.assign(GITHUB_APP_INSTALL_PATH);
}

/** Sends the browser to GitHub so it can refresh what a connection may reach. */
export function goToReauthorize(id: string) {
  window.location.assign(reauthorizePath(id));
}

export function GithubCard({
  admin,
  arrival,
  onArrivalHandled,
}: {
  /** The viewer is a workspace admin, who can make or remove the install's App. */
  admin?: boolean;
  arrival?: GithubArrival;
  /** Drops the arrival from the URL once read, so a reload does not repeat it. */
  onArrivalHandled?(): void;
}) {
  const managed = useManaged();
  const app = useQuery(githubAppQuery);
  const connections = useQuery(gitConnectionsQuery);
  const queryClient = useQueryClient();
  const [pasting, setPasting] = useState(false);
  const [picking, setPicking] = useState<GitConnectionView | null>(null);
  const device = useGitDeviceConnection((connection) => {
    setPicking(connection);
  });

  // Back from GitHub: say what happened once, and open the picker for a new install.
  const handled = useRef(false);
  const pendingPick = useRef<string | null>(null);
  useEffect(() => {
    if (handled.current || (!arrival?.githubApp && !arrival?.connection)) return;
    handled.current = true;
    if (arrival.connection) {
      pendingPick.current = arrival.connection;
      void queryClient.invalidateQueries({ queryKey: gitConnectionsQuery.queryKey });
    } else {
      void queryClient.invalidateQueries({ queryKey: githubAppQuery.queryKey });
    }
    onArrivalHandled?.();
  }, [arrival, onArrivalHandled, queryClient]);
  const list = connections.data;
  useEffect(() => {
    const id = pendingPick.current;
    const found = id ? list?.find((c) => c.id === id) : undefined;
    if (!found) return;
    pendingPick.current = null;
    setPicking(found);
  }, [list]);

  const status = app.data;
  const single = list?.length === 1 ? list[0] : undefined;
  const connectionStatus =
    device.working || device.flow
      ? { label: 'Authorizing', tone: 'bg-muted text-muted-foreground', state: 'pending' }
      : single
        ? { ...STATUS[single.status], state: single.status }
        : undefined;
  const anyConnected = !!list?.some((connection) => connection.status === 'connected');
  const serverAppFolded =
    !!status?.deviceFlowAvailable && (status.configured || status.manifestAvailable);
  return (
    <section
      className="flex flex-col rounded-lg border bg-card text-sm"
      aria-labelledby="github-repos-title"
      data-github-card
    >
      <header className="flex items-start gap-3 px-4 py-3">
        <ConnectorIcon icon="github" name="GitHub" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="github-repos-title" className="font-medium">
              GitHub for coding agents
            </h2>
            {connectionStatus && (
              <span
                data-status={connectionStatus.state}
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-medium',
                  connectionStatus.tone,
                )}
              >
                {connectionStatus.label}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Lets coding agents clone your repositories, push branches and open pull requests.
          </p>
        </div>
      </header>
      {(app.error || connections.error) && (
        <div className="flex flex-col gap-1 px-4 pb-3">
          <ErrorText error={app.error} />
          <ErrorText error={connections.error} />
        </div>
      )}
      <div className="divide-y border-t">
        {!!list?.length && (
          <div className="flex flex-col gap-1 px-4 py-3">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Account
            </h3>
            <ul className="divide-y" aria-label="GitHub connections">
              {list.map((connection) => (
                <ConnectionRow
                  key={connection.id}
                  connection={connection}
                  inline={list.length === 1}
                  onPick={() => setPicking(connection)}
                  onReconnect={() => device.begin({ connectionId: connection.id })}
                  connecting={device.working || device.flow !== null}
                />
              ))}
            </ul>
            {anyConnected && (
              <p className="text-xs text-muted-foreground" data-reach-note>
                Agents see the repositories this GitHub account can reach, and push only where it
                has push access.
              </p>
            )}
          </div>
        )}
        {status?.deviceFlowAvailable && (
          <div className="px-4 py-3 empty:hidden">
            <GitDeviceConnect state={device} showConnect={!list?.length} />
          </div>
        )}
        {status && !status.deviceFlowAvailable && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <ServerAppSetup status={status} admin={admin} managed={managed} />
          </div>
        )}
        {anyConnected && (
          <div className="flex flex-col gap-1 px-4 py-3">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Commit identity
            </h3>
            <CommitIdentity />
          </div>
        )}
        {status && (
          <details className="group px-4 py-3" open={pasting || undefined}>
            <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
              <ChevronDownIcon className="size-4 -rotate-90 transition-transform group-open:rotate-0" />
              Other ways to connect
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              {!pasting ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    A fine grained personal access token, for one account or organization.
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setPasting(true)}>
                    Paste a token instead
                  </Button>
                </div>
              ) : (
                <TokenForm
                  onDone={(connection) => {
                    setPasting(false);
                    if (connection) setPicking(connection);
                  }}
                />
              )}
              {serverAppFolded && (
                <div className="flex flex-col gap-2 border-t pt-3 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Server managed GitHub App</span>
                  <ServerAppSetup status={status} admin={admin} managed={managed} />
                </div>
              )}
              {admin && !managed && status.source === 'instance' && (
                <div className="flex justify-end">
                  <RemoveApp />
                </div>
              )}
            </div>
          </details>
        )}
      </div>
      <RepoPicker connection={picking} onClose={() => setPicking(null)} />
    </section>
  );
}

function ServerAppSetup({
  status,
  admin,
  managed,
}: {
  status: GithubAppStatus;
  admin: boolean | undefined;
  managed: boolean;
}) {
  if (status.configured)
    return (
      <Button size="sm" onClick={goToInstall}>
        Install the OpenBots app
      </Button>
    );
  if (managed) return null;
  if (status.manifestAvailable && admin) return <CreateApp />;
  return (
    <p className="text-xs text-muted-foreground" data-no-app>
      {noAppText(status, admin)}
    </p>
  );
}

function noAppText(status: GithubAppStatus, admin: boolean | undefined) {
  if (!status.publicUrlOk) {
    return 'This install has no GitHub App. Creating one needs an https public URL (OPENBOTS_PUBLIC_URL) that GitHub can reach.';
  }
  if (!admin) return 'This install has no GitHub App yet. An admin can create one here.';
  return 'This install has no GitHub App yet.';
}

/** Makes the install's App through GitHub's manifest flow, on the admin's account or an organization. */
function CreateApp() {
  const [owner, setOwner] = useState<'personal' | 'organization'>('personal');
  const [organization, setOrganization] = useState('');
  const create = useMutation({
    mutationFn: startAppManifest,
    onSuccess: ({ url, manifest }) => submitManifest(url, manifest),
  });
  const login = organization.trim();
  const ready = owner === 'personal' || !!login;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (ready) create.mutate(owner === 'organization' ? login : undefined);
  }
  return (
    <form
      aria-label="Create a GitHub App"
      onSubmit={submit}
      className="flex w-full flex-col gap-2 rounded-md border p-3"
    >
      <span className="font-medium">Create a GitHub App for this install</span>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs text-muted-foreground">Where GitHub keeps the App</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="app-owner"
            value="personal"
            checked={owner === 'personal'}
            onChange={() => setOwner('personal')}
          />
          On your personal account
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="app-owner"
            value="organization"
            checked={owner === 'organization'}
            onChange={() => setOwner('organization')}
          />
          On an organization
        </label>
      </fieldset>
      {owner === 'organization' && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Organization login</span>
          <Input
            name="organization"
            aria-label="Organization login"
            autoComplete="off"
            value={organization}
            onChange={(e) => setOrganization(e.target.value)}
            placeholder="my-org"
            className="w-64"
          />
        </label>
      )}
      <ErrorText error={create.error} />
      <div>
        <Button type="submit" size="sm" disabled={create.isPending || !ready}>
          {create.isPending ? 'Opening GitHub…' : 'Create the App on GitHub'}
        </Button>
      </div>
    </form>
  );
}

function RemoveApp() {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: removeGithubApp,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['git-connections'] }),
  });
  if (!confirm) {
    return (
      <IconButton
        label="Remove the GitHub App"
        className="ml-auto"
        onClick={() => setConfirm(true)}
      >
        <TrashIcon />
      </IconButton>
    );
  }
  return (
    <div className="flex w-full flex-wrap items-center gap-2 border-t pt-2">
      <span className="min-w-0 flex-1 text-muted-foreground">
        Remove this install&apos;s GitHub App? Its connections stop working until you create a new
        one.
      </span>
      <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
        Cancel
      </Button>
      <Button
        size="sm"
        variant="destructive"
        disabled={remove.isPending}
        onClick={() => remove.mutate()}
      >
        Remove
      </Button>
      <ErrorText error={remove.error} />
    </div>
  );
}

function TokenForm({ onDone }: { onDone(connection?: GitConnectionView): void }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');
  const add = useMutation({
    mutationFn: addTokenConnection,
    onSuccess: async (connection) => {
      await queryClient.invalidateQueries({ queryKey: gitConnectionsQuery.queryKey });
      onDone(connection);
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (token.trim()) add.mutate(token.trim());
  }
  return (
    <form
      aria-label="Paste a GitHub token"
      onSubmit={submit}
      className="flex flex-col gap-2 border-t pt-3"
    >
      <label className="flex flex-col gap-1">
        <span className="font-medium">Fine-grained personal access token</span>
        <Input
          type="password"
          name="token"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="github_pat_…"
        />
        <span className="text-xs text-muted-foreground">
          Make one on GitHub under Settings, Developer settings. Give it access to the repositories
          you want, with Contents and Pull requests set to read and write. OpenBots stores it
          encrypted and never shows it again.
        </span>
      </label>
      <ErrorText error={add.error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={add.isPending || !token.trim()}>
          Connect with this token
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onDone()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ConnectionRow({
  connection,
  onPick,
  onReconnect,
  connecting,
  inline,
}: {
  connection: GitConnectionView;
  inline: boolean;
  onPick(): void;
  onReconnect(): void;
  connecting: boolean;
}) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const write = (next: GitConnectionView) =>
    queryClient.setQueryData(gitConnectionsQuery.queryKey, (current) =>
      current?.map((c) => (c.id === next.id ? next : c)),
    );
  const [reauthorize, setReauthorize] = useState(false);
  const actAs = useMutation({
    mutationFn: (value: GitActAs) => updateConnection(connection.id, value),
    onSuccess: write,
  });
  const sync = useMutation({
    mutationFn: () => syncConnection(connection.id),
    onSuccess: (answer) => {
      write(answer.connection);
      setReauthorize(!!answer.needsReauthorize);
    },
  });
  const signIn =
    actAs.error instanceof ApiError && actAs.error.code === ACT_AS_NEEDS_SIGN_IN
      ? actAs.error
      : null;
  const remove = useMutation({
    mutationFn: () => disconnect(connection.id),
    onSuccess: () =>
      queryClient.setQueryData(gitConnectionsQuery.queryKey, (current) =>
        current?.filter((c) => c.id !== connection.id),
      ),
  });
  const status = STATUS[connection.status];
  const synced = ago(connection.lastSyncedAt);
  const usable = connection.status === 'connected';
  const pending = connection.kind === 'device' && connection.status === 'pending';
  const awaitingIdentity =
    connection.kind === 'device' && (pending || connection.accountLogin === 'GitHub');
  if (inline && pending && connecting) return null;

  return (
    <li className="flex flex-col gap-2.5 py-2" data-connection={connection.id}>
      {!(inline && awaitingIdentity) && (
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium">{connection.accountLogin}</span>
              {!inline && (
                <span
                  data-status={connection.status}
                  className={cn('rounded-full px-2 py-0.5 text-xs font-medium', status.tone)}
                >
                  {status.label}
                </span>
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              {!inline && (
                <>
                  {connection.accountType === 'organization' ? 'Organization' : 'User'} ·{' '}
                  {KIND[connection.kind]} ·{' '}
                </>
              )}
              {repoCount(connection.repoCount)}
              {synced && ` · synced ${synced}`}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {connection.kind === 'device' && connection.appSlug && !pending && (
              <Button asChild size="icon-sm" variant="ghost" className="text-muted-foreground">
                <a
                  href={`https://github.com/apps/${encodeURIComponent(connection.appSlug)}/installations/new`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Manage repositories on GitHub"
                  title="Manage repositories on GitHub"
                >
                  <ExternalIcon />
                </a>
              </Button>
            )}
            {!pending && (
              <IconButton
                label={sync.isPending ? 'Syncing…' : 'Sync'}
                busy={sync.isPending}
                onClick={() => sync.mutate()}
              >
                <RefreshIcon />
              </IconButton>
            )}
            {!confirm && (
              <IconButton
                label={`Disconnect ${connection.accountLogin}`}
                onClick={() => setConfirm(true)}
              >
                <UnlinkIcon />
              </IconButton>
            )}
          </div>
        </div>
      )}
      {connection.error && (
        <p className="break-words text-xs text-destructive">{connection.error}</p>
      )}
      {(usable ||
        reauthorize ||
        (connection.kind === 'device' && !usable) ||
        (connection.kind === 'app' && connection.status === 'needs_reinstall')) && (
        <div className="flex flex-wrap gap-1.5">
          {connection.kind === 'device' && !usable && (
            <Button size="sm" variant="outline" disabled={connecting} onClick={onReconnect}>
              {connection.status === 'pending' ? 'Finish connecting' : 'Reconnect GitHub'}
            </Button>
          )}
          {usable && (
            <Button size="sm" onClick={onPick}>
              Choose repositories
            </Button>
          )}
          {connection.kind === 'app' && connection.status === 'needs_reinstall' && (
            <Button size="sm" onClick={goToInstall}>
              Reinstall the app
            </Button>
          )}
          {reauthorize && (
            <Button size="sm" onClick={() => goToReauthorize(connection.id)}>
              Re-check access
            </Button>
          )}
        </div>
      )}
      {connection.kind === 'app' && (
        <label className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">Pull requests open as</span>
            <span className="text-xs text-muted-foreground">Act as the Bot, or as you.</span>
          </span>
          <Select
            size="sm"
            aria-label={`Act as for ${connection.accountLogin}`}
            className="w-auto"
            value={connection.actAs}
            disabled={actAs.isPending}
            onChange={(e) => actAs.mutate(e.target.value as GitActAs)}
          >
            <option value="bot">The Bot (OpenBots app)</option>
            <option value="owner">Me</option>
          </Select>
        </label>
      )}
      {connection.kind === 'device' && connection.status !== 'pending' && (
        <p className="text-xs text-muted-foreground">
          Pull requests open as {connection.accountLogin}, limited to the repositories the App can
          reach and your GitHub permissions.
        </p>
      )}
      {confirm && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-2">
          <span className="min-w-0 flex-1 text-muted-foreground">
            Disconnect {connection.accountLogin}? Its repositories stay on the computer, but coding
            agents can no longer push to them through this connection.
          </span>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Disconnect
          </Button>
        </div>
      )}
      {signIn && <SignInFirst message={signIn.message} />}
      <ErrorText error={(signIn ? null : actAs.error) ?? sync.error ?? remove.error} />
    </li>
  );
}

/** "Act as me" needs the owner's GitHub sign-in: the server's words, and a way to the GitHub connector. */
function SignInFirst({ message }: { message: string }) {
  const connectors = useQuery(connectorsQuery);
  const github = connectors.data?.items.find((c) => c.catalogId === 'github');
  return (
    <p role="alert" className="text-sm text-destructive" data-act-as-sign-in>
      {message}{' '}
      <a
        href={github ? `/connectors?connector=${encodeURIComponent(github.id)}` : '#catalog-title'}
        className="font-medium underline underline-offset-2"
      >
        Open the GitHub connector
      </a>
    </p>
  );
}
