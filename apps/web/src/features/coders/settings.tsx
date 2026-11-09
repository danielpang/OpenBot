import { CODER_AGENT_LABELS, coderProviderFits, type CoderAgent } from '@openbots/shared';
import {
  Button,
  IconButton,
  LogOutIcon,
  RefreshIcon,
  Select,
  TerminalIcon,
  UnlinkIcon,
} from '@openbots/ui';
import { CoderSignInSteps } from '@openbots/widgets/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { capabilitiesQuery } from '../../app/api.js';
import { providersQuery, type Provider } from '../models/api.js';
import { ErrorText } from '../models/error-text.js';
import { agentNote } from './agents.js';
import {
  beginCoderLogin,
  cancelCoderLogin,
  checkCoder,
  codersQuery,
  getCoderLogin,
  sendCoderLoginCode,
  setCoderApiKey,
  signOutCoder,
  type CoderAccount,
  type CoderLogin,
  type TerminalLogin,
} from './api.js';
import { computerTerminalHref } from './session-host.js';

// Settings > Coding agents (CA2, CA3): one card per agent on the computer,
// saying whether it is signed in with a plan, uses an API key from Settings >
// Models, or neither. Sign in runs the vendor's own login: the card shows
// the link and code the login printed, as the transcript's sign-in widget
// does, and polls until the login ends. Nothing typed here is a password.
// An agent that signs in inside its own terminal UI (pi): Sign in opens the
// Computer page's terminal where the server says, and Check asks the
// computer afterwards.

export const LOGIN_POLL_MS = 2_000;

const OPEN_LOGIN = new Set<CoderLogin['status']>(['pending', 'awaiting_code']);

/**
 * The providers with a key the agent can use (CODER_PROVIDER_KINDS); the
 * picker offers no other, since the server refuses the rest with
 * CODER_PROVIDER_UNSUPPORTED.
 */
export function keyProviders(agent: CoderAgent, providers: readonly Provider[]): Provider[] {
  return providers.filter((p) => p.hasKey && coderProviderFits(agent, p));
}

/** The card's status line. */
export function accountWords(account: CoderAccount, providers: readonly Provider[]): string {
  switch (account.authKind) {
    case 'subscription': {
      // Older sign-ins stored the placeholder "Signed in" as their label.
      const label = account.accountLabel?.trim();
      return label && label.toLowerCase() !== 'signed in' ? `Signed in as ${label}` : 'Signed in';
    }
    case 'api_key': {
      const provider = providers.find((p) => p.id === account.providerId);
      return `Using API key: ${provider?.name ?? 'a provider from Settings > Models'}`;
    }
    default:
      return 'Not signed in';
  }
}

const goTo = (href: string) => window.location.assign(href);

export function CodingAgentsSettings({
  pollMs = LOGIN_POLL_MS,
  onNavigate = goTo,
  connectionsOnModels = false,
}: {
  connectionsOnModels?: boolean;
  pollMs?: number;
  /** Goes to an in-app path without a page load; a full load where absent. */
  onNavigate?: (href: string) => void;
} = {}) {
  const coders = useQuery(codersQuery);
  const providers = useQuery(providersQuery);
  const { data: capabilities } = useQuery(capabilitiesQuery);

  return (
    <section className="flex flex-col gap-4" aria-label="Coding agents">
      <p className="text-sm text-muted-foreground">
        Bots run these on their computer to work in your repositories. Manage subscriptions and API
        keys in{' '}
        <a
          href="/settings/models"
          className="font-medium text-foreground underline underline-offset-4"
        >
          Models
        </a>
        .
      </p>
      {capabilities && !capabilities.computer && (
        <p className="text-sm text-muted-foreground">
          This install has no computer for its Bots, so coding agents cannot run.
        </p>
      )}
      {coders.error ? (
        <ErrorText error={coders.error} />
      ) : !coders.data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        coders.data.agents.map((account) =>
          connectionsOnModels ? (
            <article
              key={account.agent}
              aria-label={account.label}
              data-agent={account.agent}
              className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm"
            >
              <header className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">{account.label}</h3>
                <span className="text-xs text-muted-foreground">
                  {account.version ? `Version ${account.version}` : 'Version not checked'}
                </span>
              </header>
              <p>{accountWords(account, providers.data?.items ?? [])}</p>
              {agentNote(account) && (
                <p className="text-xs text-muted-foreground">{agentNote(account)}</p>
              )}
              <AccountError account={account} label={account.label} />
              <a
                href="/settings/models"
                className="self-start font-medium underline underline-offset-4"
              >
                Manage
              </a>
            </article>
          ) : (
            <CoderCard
              key={account.agent}
              account={account}
              providers={providers.data?.items ?? []}
              pollMs={pollMs}
              onNavigate={onNavigate}
            />
          ),
        )
      )}
    </section>
  );
}

export function CoderCard({
  account,
  providers,
  pollMs,
  onNavigate,
  connectionOnly = false,
  onConnected,
  onDisconnected,
  connectionLabel,
  connectionBilling,
}: {
  account: CoderAccount;
  providers: Provider[];
  pollMs: number;
  onNavigate: (href: string) => void;
  connectionOnly?: boolean;
  onConnected?: () => void;
  onDisconnected?: () => void;
  connectionLabel?: string;
  connectionBilling?: string;
}) {
  const queryClient = useQueryClient();
  const agent = account.agent;
  const label = connectionLabel ?? (account.label || CODER_AGENT_LABELS[agent]);
  const [picking, setPicking] = useState(false);
  const [providerId, setProviderId] = useState('');
  const [login, setLogin] = useState<CoderLogin | null>(null);
  // Set once the owner sends a code; "Checking the code" shows until the login moves on.
  const [submitted, setSubmitted] = useState<{ status: string; error: string | null } | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: codersQuery.queryKey });
  const writeAccount = (next: CoderAccount) =>
    queryClient.setQueryData(codersQuery.queryKey, (current) =>
      current
        ? { agents: current.agents.map((a) => (a.agent === next.agent ? next : a)) }
        : current,
    );

  // A sign-in that happens in the terminal: kept in the cache so it
  // still shows when the owner comes back from the Computer page.
  const terminalKey = ['coders', agent, 'terminal-login'] as const;
  const { data: inTerminal = null } = useQuery<TerminalLogin | null>({
    queryKey: terminalKey,
    queryFn: () => null,
    enabled: false,
    initialData: null,
  });
  const setInTerminal = (next: TerminalLogin | null) => queryClient.setQueryData(terminalKey, next);
  // The terminal sign-in panel follows the account: it stays while the agent
  // is not signed in, across reloads, and goes once Check finds the sign-in.
  const terminalPanel = account.signIn === 'terminal' && account.needsSignIn;

  const loginKey = ['coders', agent, 'login', login?.id ?? null] as const;
  const polled = useQuery({
    queryKey: loginKey,
    queryFn: () => getCoderLogin(agent, login!.id),
    enabled: !!login,
    initialData: login ?? undefined,
    refetchInterval: (query) =>
      query.state.data && OPEN_LOGIN.has(query.state.data.status) ? pollMs : false,
  });
  const current = login ? (polled.data ?? login) : null;
  const status = current?.status;

  // A finished sign-in changes the account; the card reads it again.
  useEffect(() => {
    if (status === 'signed_in') {
      void queryClient.invalidateQueries({ queryKey: codersQuery.queryKey });
      onConnected?.();
    }
  }, [status, queryClient, onConnected]);

  const signIn = useMutation({
    mutationFn: () => beginCoderLogin(agent),
    onSuccess: (next) => {
      setPicking(false);
      setSubmitted(null);
      if ('terminal' in next) {
        setLogin(null);
        setInTerminal(next.terminal);
        onNavigate(computerTerminalHref(next.terminal.terminal));
      } else {
        setInTerminal(null);
        setLogin(next.login);
      }
    },
  });
  const check = useMutation({
    mutationFn: () => checkCoder(agent),
    onSuccess: (next) => {
      writeAccount(next);
      if (next.authKind !== 'none') setInTerminal(null);
      if (next.authKind === 'subscription') onConnected?.();
      void refresh();
    },
  });
  const sendCode = useMutation({
    mutationFn: (code: string) => sendCoderLoginCode(agent, current!.id, code),
    onSuccess: (next) => {
      queryClient.setQueryData(loginKey, next);
      setSubmitted({ status: next.status, error: next.error });
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelCoderLogin(agent, current!.id),
    onSettled: () => setLogin(null),
  });
  const applyKey = useMutation({
    mutationFn: () => setCoderApiKey(agent, providerId),
    onSuccess: (next) => {
      writeAccount(next);
      setPicking(false);
      void refresh();
    },
  });
  const signOut = useMutation({
    mutationFn: () => signOutCoder(agent),
    onSuccess: (next) => {
      writeAccount(next);
      void refresh();
      onDisconnected?.();
    },
  });

  const signingIn = !!current && OPEN_LOGIN.has(current.status);
  const checking =
    signingIn &&
    !!submitted &&
    submitted.status === current.status &&
    submitted.error === current.error;
  const again = account.lastErrorKind === 'sign_in';
  const signInWords = connectionOnly
    ? again
      ? 'Reconnect'
      : 'Connect'
    : again
      ? 'Sign in again'
      : 'Sign in';
  const choices = keyProviders(agent, providers);
  const signedIn = account.authKind !== 'none';
  const note = agentNote(account);

  return (
    <article
      className={
        connectionOnly
          ? 'flex min-w-0 flex-col gap-3 text-sm'
          : 'flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm'
      }
      aria-label={connectionOnly ? `${label} subscription` : label}
      data-agent={agent}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-medium">{connectionOnly ? 'Subscription' : label}</h3>
        {!connectionOnly && account.version && (
          <span className="text-xs text-muted-foreground">Version {account.version}</span>
        )}
        <span className="ml-auto text-sm" data-account-status>
          {accountWords(account, providers)}
        </span>
      </div>
      {account.authKind === 'subscription' && connectionBilling && (
        <p className="text-xs text-muted-foreground" data-plan>
          {connectionBilling}
        </p>
      )}
      {!connectionOnly && note && <p className="text-xs text-muted-foreground">{note}</p>}
      <AccountError account={account} label={label} />

      {signingIn && current && (
        <div className="flex flex-col gap-2 rounded-md border p-3" data-login={current.id}>
          <p className="font-medium">Sign in to {label}</p>
          {checking ? (
            <p role="status" className="text-muted-foreground">
              Checking the code with {label}…
            </p>
          ) : (
            <>
              <CoderSignInSteps
                agent={agent}
                url={current.url}
                deviceCode={current.deviceCode}
                onCode={(code) => sendCode.mutate(code)}
                disabled={sendCode.isPending}
              />
              {current.error && <p className="text-xs text-destructive">{current.error}</p>}
            </>
          )}
          <ErrorText error={sendCode.error} />
          <div>
            <Button
              size="sm"
              variant="ghost"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {terminalPanel && !picking && (
        <div className="flex flex-col gap-2 rounded-md border p-3" data-terminal-login>
          <p className="font-medium">Sign in to {label} in the terminal</p>
          <p className="text-muted-foreground">
            {inTerminal?.message ??
              `${label} signs in inside its own terminal on the Computer page.`}
          </p>
          <p className="text-xs text-muted-foreground">
            When you have signed in there, choose Check to read the account again.
          </p>
          <ErrorText error={signIn.error ?? check.error} />
          <div className="flex flex-wrap gap-2">
            {inTerminal ? (
              <IconButton
                label="Terminal"
                variant="outline"
                onClick={() => onNavigate(computerTerminalHref(inTerminal.terminal))}
              >
                <TerminalIcon />
              </IconButton>
            ) : (
              <Button size="sm" disabled={signIn.isPending} onClick={() => signIn.mutate()}>
                {signInWords}
              </Button>
            )}
            <IconButton
              label={check.isPending ? 'Checking…' : 'Check'}
              busy={check.isPending}
              onClick={() => check.mutate()}
            >
              <RefreshIcon />
            </IconButton>
          </div>
        </div>
      )}
      {current && !signingIn && current.status !== 'signed_in' && (
        <p role="status" className="text-xs text-muted-foreground">
          {current.status === 'expired'
            ? 'The sign-in expired before it was finished.'
            : current.status === 'cancelled'
              ? 'The sign-in was cancelled.'
              : `Not signed in.${current.error ? ` ${current.error}` : ''}`}
        </p>
      )}

      {picking && (
        <div className="flex flex-col gap-2 rounded-md border p-3">
          {choices.length ? (
            <label className="flex flex-col gap-1">
              <span className="font-medium">API key</span>
              <Select
                aria-label={`${label} API key`}
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              >
                <option value="">Choose a provider</option>
                {choices.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </label>
          ) : (
            <p className="text-muted-foreground">
              No provider with a key that {label} can use yet. Add one in{' '}
              <a href="/settings/models" className="underline">
                Settings &gt; Models
              </a>
              .
            </p>
          )}
          <ErrorText error={applyKey.error} />
          <div className="flex gap-2">
            {choices.length > 0 && (
              <Button
                size="sm"
                disabled={!providerId || applyKey.isPending}
                onClick={() => applyKey.mutate()}
              >
                Use this key
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setPicking(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <ErrorText
        error={
          (terminalPanel ? null : (signIn.error ?? check.error)) ?? signOut.error ?? cancel.error
        }
      />
      {!signingIn && !picking && (
        <div className="flex flex-wrap gap-2">
          {!terminalPanel && (account.authKind !== 'subscription' || account.needsSignIn) && (
            <Button size="sm" disabled={signIn.isPending} onClick={() => signIn.mutate()}>
              {signInWords}
            </Button>
          )}
          {!connectionOnly && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setProviderId(account.authKind === 'api_key' ? (account.providerId ?? '') : '');
                setPicking(true);
              }}
            >
              Use API key
            </Button>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            {!terminalPanel && account.checkAvailable && (
              <IconButton
                label={check.isPending ? 'Checking…' : 'Check'}
                busy={check.isPending}
                onClick={() => check.mutate()}
              >
                <RefreshIcon />
              </IconButton>
            )}
            {signedIn && (
              <IconButton
                label={connectionOnly ? 'Disconnect' : 'Sign out'}
                busy={signOut.isPending}
                onClick={() => signOut.mutate()}
              >
                {connectionOnly ? <UnlinkIcon /> : <LogOutIcon />}
              </IconButton>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * The account's last error, as the server sorts it: a lapsed sign-in asks to
 * sign in again, a rejected key points at Settings > Models, and anything
 * else shows the error's own text.
 */
function AccountError({ account, label }: { account: CoderAccount; label: string }) {
  if (!account.lastError) return null;
  const words =
    account.lastErrorKind === 'sign_in' ? (
      <>{label} is not signed in on the computer any more. Sign in again.</>
    ) : account.lastErrorKind === 'key' ? (
      <>
        The API key was rejected. Change it under{' '}
        <a href="/settings/models" className="underline">
          Settings &gt; Models
        </a>
        .
      </>
    ) : (
      account.lastError
    );
  return (
    <p className="text-xs text-destructive" data-account-error={account.lastErrorKind ?? 'other'}>
      {words}
    </p>
  );
}
