import { CODER_AGENT_LABELS, SUBSCRIPTION_PROVIDERS, type ProviderKind } from '@openbots/shared';
import { Button, IconButton, RefreshIcon } from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { capabilitiesQuery } from '../../app/api.js';
import { codersQuery, setCoderApiKey } from '../coders/api.js';
import { CoderCard, LOGIN_POLL_MS } from '../coders/settings.js';
import { createProvider, providersQuery, type CreateProvider, type Provider } from './api.js';
import { ErrorText } from './error-text.js';

/** Select a saved key for a compatible coding agent without leaving its provider. */
export function ProviderCodingKey({ provider }: { provider: Provider }) {
  const capabilities = useQuery({ ...capabilitiesQuery, enabled: false });
  const enabled =
    capabilities.data?.computer === true && provider.protocol === 'native' && provider.hasKey;
  const accounts = useQuery({ ...codersQuery, enabled });
  const queryClient = useQueryClient();
  const agent =
    provider.kind === 'anthropic' ? 'claude' : provider.kind === 'openai' ? 'codex' : 'pi';
  const account = accounts.data?.agents.find((a) => a.agent === agent);
  const save = useMutation({
    mutationFn: () => setCoderApiKey(agent, provider.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: codersQuery.queryKey }),
  });
  if (!enabled || provider.kind === 'custom' || provider.kind === 'ollama') return null;
  const label = CODER_AGENT_LABELS[agent];
  return (
    <div className="flex flex-col gap-1.5">
      {account?.authKind === 'subscription' ? (
        <p className="text-xs text-muted-foreground">
          {label} uses your subscription before this key.
        </p>
      ) : account?.providerId === provider.id ? (
        <p className="text-xs text-muted-foreground">Also used by {label}.</p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <p className="text-xs text-muted-foreground">{label} does not use this key yet.</p>
          <Button
            size="sm"
            variant="outline"
            disabled={save.isPending}
            aria-label={`Use saved key for ${label}`}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : `Use for ${label}`}
          </Button>
        </div>
      )}
      <ErrorText error={save.error} />
    </div>
  );
}

/** Preserve access to pi's other coding-only plans when moving account management here. */
export function AdditionalCodingSubscriptions() {
  const capabilities = useQuery({ ...capabilitiesQuery, enabled: false });
  const enabled = capabilities.data?.computer === true;
  const accounts = useQuery({ ...codersQuery, enabled });
  const account = accounts.data?.agents.find((a) => a.agent === 'pi');
  const sharedPlans = new Set(['Anthropic (Claude Pro/Max)', 'OpenAI (ChatGPT Plus/Pro)', 'xAI']);
  if (
    !enabled ||
    account?.authKind !== 'subscription' ||
    !account.accountLabel?.split(', ').some((p) => !sharedPlans.has(p))
  )
    return null;
  return (
    <section
      className="space-y-4 rounded-lg border bg-card p-4"
      aria-label="Other coding subscriptions"
    >
      <div className="space-y-1">
        <h3 className="font-medium">Other coding subscriptions</h3>
        <p className="max-w-prose text-sm text-muted-foreground">
          These pi connections are available for coding tasks. Bot conversations currently support
          Claude, ChatGPT/Codex and xAI subscriptions. Disconnecting here signs out all pi
          providers.
        </p>
      </div>
      <CoderCard
        account={account}
        providers={[]}
        pollMs={LOGIN_POLL_MS}
        onNavigate={(href) => window.location.assign(href)}
        connectionOnly
      />
    </section>
  );
}

/** Subscription setup lives beside the key. The same account backs coding and bot replies. */
export function ProviderSubscription({
  kind,
  canEdit,
  configured = true,
  scope,
  fallbackProviderId,
}: {
  kind: ProviderKind;
  canEdit: boolean;
  configured?: boolean;
  scope?: CreateProvider['scope'];
  fallbackProviderId?: string;
}) {
  const capabilities = useQuery({ ...capabilitiesQuery, enabled: false });
  const identity = SUBSCRIPTION_PROVIDERS[kind as keyof typeof SUBSCRIPTION_PROVIDERS];
  const supported = !!identity;
  const enabled = supported && capabilities.data?.computer === true;
  const accounts = useQuery({ ...codersQuery, enabled: supported && !!capabilities.data });
  const queryClient = useQueryClient();
  const agent = identity?.agent ?? 'pi';
  const native = accounts.data?.agents.find((a) => a.agent === agent);
  const pi = accounts.data?.agents.find((a) => a.agent === 'pi');
  const plan = identity?.plan ?? '';
  const piConnected =
    pi?.authKind === 'subscription' && pi.accountLabel?.split(', ').includes(plan);
  const account =
    native?.authKind === 'subscription' && agent !== 'pi' ? native : piConnected ? pi : native;
  const connected = account?.authKind === 'subscription' && (account.agent !== 'pi' || piConnected);
  const useSavedKey = useMutation({
    mutationFn: () => setCoderApiKey(account!.agent, fallbackProviderId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: codersQuery.queryKey }),
  });
  const provision = useMutation({
    mutationFn: async () => {
      const connections = await queryClient.fetchQuery(codersQuery);
      const matches = connections.agents.some(
        (a) =>
          a.authKind === 'subscription' &&
          ((a.agent === agent && agent !== 'pi') ||
            (a.agent === 'pi' && a.accountLabel?.split(', ').includes(plan))),
      );
      if (!matches) return;
      // A repeated sign-in/check reuses the provider created by the first attempt.
      const current = await queryClient.fetchQuery(providersQuery);
      const sameScope = current.items.filter((p) => !scope || p.scope === scope);
      if (
        !sameScope.some(
          (p) => p.kind === kind && p.protocol === 'native' && !p.baseUrl && !p.headers.length,
        )
      ) {
        let slug = kind as string;
        for (let n = 1; sameScope.some((p) => p.slug === slug); n++)
          slug = `${kind}-subscription${n === 1 ? '' : `-${n}`}`;
        await createProvider({ presetId: kind, slug, ...(scope ? { scope } : {}) });
        await queryClient.invalidateQueries({ queryKey: providersQuery.queryKey });
      }
    },
  });
  if (!canEdit || !supported || !capabilities.data) return null;
  if (!enabled && !connected)
    return (
      <section className="text-sm" aria-label={`${kind} subscription unavailable`}>
        <h3 className="font-medium">Subscription</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Configure a computer to connect a subscription. You can use an API key without one.
        </p>
      </section>
    );
  return (
    <section className="flex flex-col gap-2" aria-label={`${kind} connection`}>
      {connected && account?.needsSignIn && (
        <p className="text-xs font-medium text-destructive">Reconnect required</p>
      )}
      {!enabled && (
        <p className="text-sm text-destructive">
          A computer is required to use this subscription. Restore the computer connection, or
          disconnect the subscription to use an API key.
        </p>
      )}
      <ErrorText error={accounts.error ?? provision.error ?? useSavedKey.error} />
      {provision.isError && (
        <IconButton label="Retry" className="self-start" onClick={() => provision.mutate()}>
          <RefreshIcon />
        </IconButton>
      )}
      {!account && !accounts.error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading connection…
        </p>
      )}
      {account && (
        <CoderCard
          account={
            !connected
              ? { ...account, authKind: 'none', accountLabel: null, needsSignIn: true }
              : !enabled
                ? { ...account, needsSignIn: false, checkAvailable: false }
                : account.agent === 'pi'
                  ? { ...account, accountLabel: plan ?? null }
                  : account
          }
          providers={[]}
          pollMs={LOGIN_POLL_MS}
          onNavigate={(href) => window.location.assign(href)}
          connectionOnly
          connectionLabel={identity?.label}
          connectionBilling={
            kind === 'anthropic'
              ? 'Uses your Claude account.'
              : `Uses your ${identity?.label} subscription.`
          }
          onConnected={configured ? undefined : provision.mutate}
          onDisconnected={fallbackProviderId ? useSavedKey.mutate : undefined}
        />
      )}
      {enabled && connected && !configured && (
        <p className="text-xs text-muted-foreground">
          Enable this connection for bot conversations.
        </p>
      )}
      {connected && configured && (
        <p className="text-xs text-muted-foreground">
          Connection saved. Test a model to verify access.
        </p>
      )}
      {enabled && connected && !configured && (
        <Button
          className="self-start"
          size="sm"
          disabled={provision.isPending}
          onClick={() => provision.mutate()}
        >
          {provision.isPending ? 'Enabling…' : 'Enable'}
        </Button>
      )}
      {connected && (
        <p className="text-xs text-muted-foreground">
          If your plan expires or reaches a limit, requests stop. We do not switch to API billing.
          Disconnect the subscription to use your saved key. Disconnecting also signs the coding
          agent out{account?.agent === 'pi' ? ' of all pi providers' : ''}.
        </p>
      )}
      <p className="max-w-prose text-xs text-muted-foreground">
        One sign-in for bots and coding agents, used before an API key.
        {kind === 'xai' ? ' In pi, type /login and choose xAI for SuperGrok or X Premium.' : ''}
        {kind === 'anthropic'
          ? ' Claude plan access outside Claude Code may need extra usage and follows Anthropic’s account rules.'
          : ''}
      </p>
    </section>
  );
}
