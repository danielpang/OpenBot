import { Button, cn, Input } from '@openbots/ui';
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
  const save = useMutation({ mutationFn: onSave, onSuccess: () => setReplacing(false) });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const apiKey = String(new FormData(form).get('apiKey')).trim();
    if (apiKey) save.mutate(apiKey, { onSuccess: () => form.reset() });
  }

  const status = (
    <span className={cn('text-sm', hasKey ? 'text-foreground' : 'text-muted-foreground')}>
      {`API key: ${hasKey ? (keyHint ?? 'set') : required === false ? 'none (optional)' : 'not set'}`}
    </span>
  );
  if (!canEdit || (hasKey && !replacing)) {
    return (
      <div className="flex items-center gap-3">
        {status}
        {canEdit && (
          <Button variant="ghost" size="sm" onClick={() => setReplacing(true)}>
            Replace
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <form className="flex items-center gap-2" onSubmit={submit}>
        {status}
        <Input
          name="apiKey"
          type="password"
          autoComplete="off"
          placeholder="Paste an API key"
          aria-label="API key"
          className="max-w-xs"
          required
        />
        <Button type="submit" size="sm" disabled={save.isPending}>
          Save key
        </Button>
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
    <p className="text-sm">
      <span className={STATUS_STYLES[provider.status]}>{STATUS_LABELS[provider.status]}</span>
      {result && (
        <span className="text-muted-foreground">
          {' '}
          · {testSummary(result)}
          {provider.lastTestedAt && ` · tested ${new Date(provider.lastTestedAt).toLocaleString()}`}
        </span>
      )}
      {result?.error && <span className="block text-destructive">{result.error}</span>}
    </p>
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
      <select
        value={provider.smallModelId ?? ''}
        disabled={!canEdit || save.isPending}
        onChange={(event) => save.mutate(event.currentTarget.value || null)}
        className="h-9 max-w-xs rounded-md border border-input bg-background px-3 text-sm"
      >
        <option value="">Automatic (catalog pick, else cheapest with tools)</option>
        {candidates.map((m) => (
          <option key={m.id} value={m.modelId}>
            {m.displayName}
          </option>
        ))}
      </select>
      <ErrorText error={save.error} />
    </label>
  );
}

export function ProviderCard({
  provider,
  canEdit,
  keyRequired,
  defaultOpen = false,
}: {
  provider: Provider;
  canEdit: boolean;
  keyRequired?: boolean;
  defaultOpen?: boolean;
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

  return (
    <article className="flex flex-col gap-3 rounded-md border p-4" aria-label={provider.name}>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-medium">{provider.name}</h3>
          {provider.kind === 'custom' && (
            <p className="text-sm text-muted-foreground">
              {provider.baseUrl} ·{' '}
              {provider.protocol === 'anthropic_compatible' ? 'Anthropic Messages' : 'OpenAI chat'}
              {provider.local && ' · on my network'}
              {/* Header values can carry credentials, so only their names are shown. */}
              {headerNames.length > 0 && ` · headers: ${headerNames.join(', ')}`}
            </p>
          )}
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <select
              aria-label="Model to test"
              value={testModelId}
              disabled={test.isPending || !models?.items.length}
              onChange={(event) => setTestModelId(event.currentTarget.value)}
              className="h-8 max-w-48 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">Default model</option>
              {models?.items.map((m) => (
                <option key={m.id} value={m.modelId}>
                  {m.displayName}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              disabled={test.isPending}
              onClick={() => test.mutate()}
            >
              {test.isPending ? 'Testing…' : 'Test'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              // A provider in use cannot be deleted (L5); say so before the confirm, not after.
              disabled={remove.isPending || inUse !== null}
              aria-describedby={inUse ? `${provider.id}-in-use` : undefined}
              title={inUse ?? undefined}
              onClick={() => {
                if (window.confirm(`Delete ${provider.name} and its models?`)) remove.mutate();
              }}
            >
              Delete
            </Button>
          </div>
        )}
      </header>
      {canEdit && inUse && (
        <p id={`${provider.id}-in-use`} className="text-xs text-muted-foreground">
          {inUse}
        </p>
      )}
      <ErrorText error={remove.error} />
      <KeyField
        hasKey={provider.hasKey}
        keyHint={provider.keyHint}
        canEdit={canEdit}
        required={keyRequired}
        onSave={(apiKey) => updateProvider(provider.id, { apiKey }).then(refresh)}
      />
      {canEdit && provider.kind === 'custom' && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" {...localBox} />
          Runs on my network (allows a private or local base URL)
        </label>
      )}
      <ErrorText error={localError} />
      <TestResult provider={provider} />
      <ErrorText error={test.error} />
      <details open={defaultOpen} className="flex flex-col gap-3">
        <summary className="cursor-pointer text-sm font-medium">Models</summary>
        <div className="mt-3 flex flex-col gap-4">
          <ModelEditor provider={provider} canEdit={canEdit} />
          <SmallModel provider={provider} canEdit={canEdit} />
        </div>
      </details>
    </article>
  );
}
