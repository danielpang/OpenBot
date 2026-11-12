import {
  Button,
  ChevronDownIcon,
  cn,
  IconButton,
  Input,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  SaveButton,
  Select,
  Switch,
  TrashIcon,
  useSaveState,
} from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useSavedCheckbox } from '../../app/saved-checkbox.js';
import {
  deleteProvider,
  providerModelsQuery,
  providersQuery,
  testProvider,
  updateProvider,
  type Provider,
} from './api.js';
import { ErrorText } from './error-text.js';
import { providerInUseText, testSummary } from './format.js';
import { ModelEditor } from './model-editor.js';
import { BaseUrlField, isOllamaCloud } from './ollama.js';
import { ProviderCodingKey, ProviderSubscription } from './provider-subscription.js';

// One provider: key status, Test (of the default model or one the admin
// picks, L3), models, small model and delete. Keys are
// write-only (P3): the card knows `hasKey`, and for admins `keyHint` (the
// vendor prefix and last four characters, to tell keys apart), and never
// holds a stored key, and
// extra headers arrive by name only (S-9). Custom endpoints say whether they
// run on the admin's network, which lets their base URL be private (S-12).

const STATUS_LABELS: Record<Provider['status'], string> = {
  untested: 'Untested',
  ok: 'Working',
  degraded: 'No tool calling',
  error: 'Failing',
};

const STATUS_STYLES: Record<Provider['status'], string> = {
  untested: 'text-muted-foreground',
  ok: 'text-success',
  degraded: 'text-amber-600',
  error: 'text-destructive',
};

/**
 * The key row. With a key stored it shows its hint (`sk-ant-…a1b2`), or "set"
 * when the viewer gets none, and offers Replace; the input is a password
 * field that starts empty and is cleared after saving.
 */
export function KeyField({
  hasKey,
  keyHint,
  canEdit,
  required,
  onSave,
}: {
  hasKey: boolean;
  keyHint?: string | null;
  canEdit: boolean;
  required?: boolean;
  onSave: (apiKey: string) => Promise<unknown>;
}) {
  const [replacing, setReplacing] = useState(false);
  const save = useMutation({
    mutationFn: onSave,
    onSuccess: () => saved.afterCheck(() => setReplacing(false)),
  });
  const saved = useSaveState(save);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const apiKey = String(new FormData(form).get('apiKey')).trim();
    if (apiKey) save.mutate(apiKey, { onSuccess: () => form.reset() });
  }

  const value = hasKey ? (keyHint ?? 'set') : required === false ? 'none (optional)' : 'not set';
  const status = (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-sm font-medium text-foreground">API key</span>
      <span
        className={cn('truncate text-xs text-muted-foreground', hasKey && keyHint && 'font-mono')}
        data-key-status
      >
        {value}
      </span>
    </div>
  );
  // An optional key that is not set stays a line with an Add button, not an open form.
  if (!canEdit || ((hasKey || required === false) && !replacing)) {
    return (
      <div className="flex items-center gap-3">
        {status}
        {canEdit && (
          <IconButton label={hasKey ? 'Replace key' : 'Add key'} onClick={() => setReplacing(true)}>
            {hasKey ? <PencilIcon /> : <PlusIcon />}
          </IconButton>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {status}
      <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
        <Input
          name="apiKey"
          type="password"
          autoComplete="off"
          placeholder="Paste an API key"
          aria-label="API key"
          className="h-8 max-w-xs flex-1"
          required
        />
        <SaveButton type="submit" size="sm" state={saved.state}>
          Save key
        </SaveButton>
        {replacing && (
          <Button variant="ghost" size="sm" onClick={() => setReplacing(false)}>
            Cancel
          </Button>
        )}
      </form>
      <ErrorText error={save.error} />
    </div>
  );
}

export function TestResult({ provider }: { provider: Provider }) {
  const result = provider.testResult;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
      <span className={cn('font-medium', STATUS_STYLES[provider.status])}>
        {STATUS_LABELS[provider.status]}
      </span>
      {result && (
        <span className="text-xs text-muted-foreground">
          {testSummary(result)}
          {provider.lastTestedAt && ` · tested ${new Date(provider.lastTestedAt).toLocaleString()}`}
        </span>
      )}
      {result?.error && <span className="text-xs text-destructive">{result.error}</span>}
    </div>
  );
}

function SmallModel({ provider, canEdit }: { provider: Provider; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { data } = useQuery(providerModelsQuery(provider.id));
  const save = useMutation({
    mutationFn: (smallModelId: string | null) => updateProvider(provider.id, { smallModelId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: providersQuery.queryKey }),
  });
  const candidates = data?.items.filter((m) => m.enabled && m.capabilities.tools) ?? [];
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      Small model for background tasks
      <Select
        value={provider.smallModelId ?? ''}
        disabled={!canEdit || save.isPending}
        onChange={(event) => save.mutate(event.currentTarget.value || null)}
        className="max-w-xs"
      >
        <option value="">Automatic (catalog pick, else cheapest with tools)</option>
        {candidates.map((m) => (
          <option key={m.id} value={m.modelId}>
            {m.displayName}
          </option>
        ))}
      </Select>
      <ErrorText error={save.error} />
    </label>
  );
}

export function ProviderCard({
  provider,
  canEdit,
  keyRequired,
  defaultOpen = false,
  showSubscription = true,
}: {
  provider: Provider;
  canEdit: boolean;
  keyRequired?: boolean;
  defaultOpen?: boolean;
  showSubscription?: boolean;
}) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: providersQuery.queryKey });
  const { data: models } = useQuery({ ...providerModelsQuery(provider.id), enabled: canEdit });
  // Empty tests the provider's default model; any other model can be checked too.
  const [testModelId, setTestModelId] = useState('');
  const test = useMutation({
    mutationFn: () => testProvider(provider.id, testModelId || undefined),
    onSuccess: (updated) => {
      queryClient.setQueryData(providersQuery.queryKey, (old) =>
        old ? { items: old.items.map((p) => (p.id === updated.id ? updated : p)) } : old,
      );
      // A failed tool call turns the model's tools flag off.
      return queryClient.invalidateQueries({ queryKey: ['providers', provider.id, 'models'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteProvider(provider.id),
    onSuccess: refresh,
  });
  const { error: localError, ...localBox } = useSavedCheckbox(
    provider.local,
    (local) => updateProvider(provider.id, { local }),
    refresh,
  );
  const headerNames = provider.headers;
  const inUse = providerInUseText(provider.botCount);
  const cloud = provider.kind === 'ollama' && isOllamaCloud(provider);

  const subscription =
    showSubscription &&
    provider.protocol === 'native' &&
    !provider.baseUrl &&
    provider.headers.length === 0;

  return (
    <article className="rounded-lg border bg-card text-sm" aria-label={provider.name}>
      <header className="flex items-start gap-3 py-3 pr-2 pl-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="font-medium">{provider.name}</h3>
          {provider.kind === 'custom' && (
            <p className="truncate text-xs text-muted-foreground">
              {provider.baseUrl} ·{' '}
              {provider.protocol === 'anthropic_compatible' ? 'Anthropic Messages' : 'OpenAI chat'}
              {provider.local && ' · on my network'}
              {/* Header values can carry credentials, so only their names are shown. */}
              {headerNames.length > 0 && ` · headers: ${headerNames.join(', ')}`}
            </p>
          )}
          {canEdit && inUse && (
            <p id={`${provider.id}-in-use`} className="text-xs text-muted-foreground">
              {inUse}
            </p>
          )}
        </div>
        {canEdit && (
          <IconButton
            label="Delete"
            tooltip={inUse ?? 'Delete'}
            // A provider in use cannot be deleted (L5); say so before the confirm, not after.
            disabled={inUse !== null}
            busy={remove.isPending}
            aria-describedby={inUse ? `${provider.id}-in-use` : undefined}
            onClick={() => {
              if (window.confirm(`Delete ${provider.name} and its models?`)) remove.mutate();
            }}
          >
            <TrashIcon />
          </IconButton>
        )}
      </header>
      <ErrorText error={remove.error} />
      <div className="divide-y border-t">
        {subscription && (
          <div className="px-4 py-3">
            <ProviderSubscription
              kind={provider.kind}
              canEdit={canEdit}
              fallbackProviderId={provider.hasKey ? provider.id : undefined}
            />
          </div>
        )}
        {provider.kind === 'ollama' && !cloud && (
          <div className="py-3 pr-2 pl-4">
            <BaseUrlField provider={provider} canEdit={canEdit} />
          </div>
        )}
        <div className="flex flex-col gap-2 py-3 pr-2 pl-4">
          <KeyField
            hasKey={provider.hasKey}
            keyHint={provider.keyHint}
            canEdit={canEdit}
            required={provider.kind === 'ollama' ? cloud : keyRequired}
            onSave={(apiKey) => updateProvider(provider.id, { apiKey }).then(refresh)}
          />
          {canEdit && <ProviderCodingKey provider={provider} />}
        </div>
        {canEdit && (provider.kind === 'custom' || (provider.kind === 'ollama' && !cloud)) && (
          <label className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">Runs on my network</span>
              <span className="text-xs text-muted-foreground">
                Allows a private or local base URL
              </span>
            </span>
            <Switch {...localBox} />
          </label>
        )}
        <ErrorText error={localError} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 pr-2 pl-4">
          <TestResult provider={provider} />
          {canEdit && (
            <div className="flex items-center gap-1">
              <Select
                size="sm"
                aria-label="Model to test"
                value={testModelId}
                disabled={test.isPending || !models?.items.length}
                onChange={(event) => setTestModelId(event.currentTarget.value)}
                className="w-auto max-w-44"
              >
                <option value="">Default model</option>
                {models?.items.map((m) => (
                  <option key={m.id} value={m.modelId}>
                    {m.displayName}
                  </option>
                ))}
              </Select>
              <IconButton
                label={test.isPending ? 'Testing…' : 'Test'}
                busy={test.isPending}
                onClick={() => test.mutate()}
              >
                <RefreshIcon />
              </IconButton>
            </div>
          )}
          <ErrorText error={test.error} />
        </div>
        <details open={defaultOpen} className="group px-4 py-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden">
            <ChevronDownIcon className="size-4 -rotate-90 text-muted-foreground transition-transform group-open:rotate-0" />
            Models
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            <ModelEditor provider={provider} canEdit={canEdit} />
            <SmallModel provider={provider} canEdit={canEdit} />
          </div>
        </details>
      </div>
    </article>
  );
}
