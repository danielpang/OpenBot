import { IconButton, PlusIcon } from '@openbots/ui';
import { SettingsSubheading } from '../../app/settings-layout.js';
import { SUBSCRIPTION_PROVIDERS } from '@openbots/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { capabilitiesQuery } from '../../app/api.js';
import { useManaged } from '../../app/deployment.js';
import {
  createProvider,
  presetsQuery,
  providersQuery,
  type CreateProvider,
  type Provider,
  type ProviderPreset,
} from './api.js';
import { AddEndpoint } from './add-endpoint.js';
import { ErrorText } from './error-text.js';
import { BUILT_IN_KINDS } from './format.js';
import { OllamaSetup } from './ollama.js';
import { KeyField, ProviderCard } from './provider-card.js';
import { AdditionalCodingSubscriptions, ProviderSubscription } from './provider-subscription.js';

// Settings > Models (L1 to L6): a card per built-in provider, then custom
// endpoints. A self-hosted install has one list, its owner's. On the managed
// service there are two (plan 21.4): the organization's, which every
// member's Bots use and its owners and admins change, and the caller's own,
// which they change and which come first for their Bots.

type Scope = NonNullable<CreateProvider['scope']>;

/** A built-in provider nobody has added yet: saving a key creates it from its preset. */
function UnconfiguredBuiltIn({
  preset,
  canEdit,
  scope,
}: {
  preset: ProviderPreset;
  canEdit: boolean;
  scope?: Scope;
}) {
  const queryClient = useQueryClient();
  return (
    <article className="flex flex-col gap-3 rounded-lg border bg-card p-4" aria-label={preset.name}>
      <h3 className="font-medium">{preset.name}</h3>
      {scope !== 'organization' && (
        <ProviderSubscription
          kind={preset.kind}
          canEdit={canEdit}
          configured={false}
          scope={scope}
        />
      )}
      <KeyField
        hasKey={false}
        canEdit={canEdit}
        onSave={(apiKey) =>
          createProvider({ presetId: preset.id, apiKey, ...(scope ? { scope } : {}) }).then(() =>
            queryClient.invalidateQueries({ queryKey: providersQuery.queryKey }),
          )
        }
      />
    </article>
  );
}

function ProviderList({
  providers,
  presets,
  canEdit,
  scope,
  allowLocal,
}: {
  providers: Provider[];
  presets: ProviderPreset[];
  canEdit: boolean;
  /** Set on the managed service: the list it is, and what it adds. */
  scope?: Scope;
  allowLocal: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<{ id: string; discoverError?: Error } | null>(null);
  const presetById = new Map(presets.map((p) => [p.id, p]));
  const custom = providers.filter((p) => p.kind === 'custom');

  return (
    <>
      <section className="flex flex-col gap-3">
        <SettingsSubheading>Providers</SettingsSubheading>
        {BUILT_IN_KINDS.map((kind) => {
          const configured = providers.filter((p) => p.kind === kind);
          const preset = presetById.get(kind);
          if (!configured.length) {
            if (!preset) return null;
            return kind === 'ollama' ? (
              <OllamaSetup
                key={kind}
                preset={preset}
                canEdit={canEdit}
                allowLocal={allowLocal}
                scope={scope}
              />
            ) : (
              <UnconfiguredBuiltIn key={kind} preset={preset} canEdit={canEdit} scope={scope} />
            );
          }
          const native = configured.find(
            (p) => p.protocol === 'native' && !p.baseUrl && !p.headers.length,
          );
          return (
            <section
              key={kind}
              className="flex flex-col gap-3"
              aria-label={`${preset?.name ?? kind} connections`}
            >
              {!native && kind in SUBSCRIPTION_PROVIDERS && scope !== 'organization' && (
                <article className="flex flex-col gap-3 rounded-lg border bg-card p-4">
                  <h3 className="font-medium">{preset?.name ?? kind}</h3>
                  <ProviderSubscription
                    kind={kind}
                    canEdit={canEdit}
                    configured={false}
                    scope={scope}
                  />
                </article>
              )}
              {configured.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  canEdit={canEdit}
                  showSubscription={scope !== 'organization' && provider.id === native?.id}
                />
              ))}
            </section>
          );
        })}
      </section>
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <SettingsSubheading>Custom model providers</SettingsSubheading>
          {canEdit && !adding && (
            <IconButton label="Add provider" onClick={() => setAdding(true)}>
              <PlusIcon />
            </IconButton>
          )}
        </div>
        {adding && (
          <AddEndpoint
            presets={presets}
            scope={scope}
            allowLocal={allowLocal}
            onAdded={(provider, discoverError) => {
              setAdding(false);
              setAdded({ id: provider.id, discoverError });
            }}
          />
        )}
        {custom.map((provider) => (
          <div key={provider.id} className="flex flex-col gap-1.5">
            {added?.id === provider.id && added.discoverError && (
              <p className="text-sm text-destructive">
                Added, but discovery failed: {added.discoverError.message}
              </p>
            )}
            <ProviderCard
              provider={provider}
              canEdit={canEdit}
              keyRequired={
                provider.presetId ? presetById.get(provider.presetId)?.keyRequired : false
              }
              defaultOpen={added?.id === provider.id}
            />
          </div>
        ))}
        {!custom.length && !adding && (
          <p className="text-sm text-muted-foreground">No custom model providers.</p>
        )}
      </section>
    </>
  );
}

export function ModelsSettings({ canEdit }: { canEdit: boolean }) {
  const providers = useQuery(providersQuery);
  const presets = useQuery(presetsQuery);
  const capabilities = useQuery({ ...capabilitiesQuery, enabled: false });
  const managed = useManaged();
  const allowLocal = capabilities.data?.localEndpoints ?? true;
  const error = providers.error ?? presets.error;
  if (error) return <ErrorText error={error} />;
  if (!providers.data || !presets.data)
    return (
      <div role="status" className="animate-pulse space-y-3" aria-label="Loading model connections">
        <div className="h-24 rounded-md bg-muted" />
        <div className="h-24 rounded-md bg-muted" />
      </div>
    );

  if (!managed) {
    return (
      <div className="flex flex-col gap-8">
        <header className="space-y-2">
          <h2 className="text-base font-semibold">Model connections</h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Connect a subscription or add an API key. Your bots and coding agents share these
            connections.
          </p>
        </header>
        <ProviderList
          providers={providers.data.items}
          presets={presets.data.items}
          canEdit={canEdit}
          allowLocal={allowLocal}
        />
        <AdditionalCodingSubscriptions />
      </div>
    );
  }
  const of = (scope: Scope) => providers.data.items.filter((p) => p.scope === scope);
  return (
    <div className="flex flex-col gap-10">
      <header className="space-y-2">
        <h2 className="text-base font-semibold">Model connections</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Subscriptions belong to your account. Your bots use your subscription before an API key,
          including for organization providers.
        </p>
      </header>
      <section className="flex flex-col gap-6" aria-label="Organization">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">Organization</h2>
          <p className="text-sm text-muted-foreground">Every member&apos;s Bots can use these.</p>
        </div>
        <ProviderList
          providers={of('organization')}
          presets={presets.data.items}
          canEdit={canEdit}
          scope="organization"
          allowLocal={allowLocal}
        />
      </section>
      <section className="flex flex-col gap-6" aria-label="Yours">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">Yours</h2>
          <p className="text-sm text-muted-foreground">
            Only you see these. Your Bots use them first.
          </p>
        </div>
        <ProviderList
          providers={of('account')}
          presets={presets.data.items}
          canEdit
          scope="account"
          allowLocal={allowLocal}
        />
      </section>
      <AdditionalCodingSubscriptions />
    </div>
  );
}
