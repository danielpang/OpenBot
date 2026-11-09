import { DEFAULT_CAPABILITIES, type ModelCapabilities, type ModelPricing } from '@openbots/shared';
import { Button, IconButton, Input, PlusIcon, SearchIcon, XIcon } from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  discoverModels,
  providerModelsQuery,
  putModels,
  type ModelInput,
  type Provider,
  type ProviderModel,
} from './api.js';
import { ErrorText } from './error-text.js';
import { mergeDiscovered } from './format.js';

// Per-model capability flags, pricing and enablement (L4). Edits collect in a
// draft and go out in one PUT; Discover merges new models into the draft.

export type ModelDraft = Pick<
  ProviderModel,
  'modelId' | 'displayName' | 'capabilities' | 'pricing' | 'enabled' | 'source'
>;

const toDraft = ({ modelId, displayName, capabilities, pricing, enabled, source }: ModelDraft) => ({
  modelId,
  displayName,
  capabilities,
  pricing,
  enabled,
  source,
});

const FLAGS = ['tools', 'vision', 'reasoning'] as const;

export const canDiscover = (provider: Pick<Provider, 'discovery' | 'protocol'>) =>
  provider.discovery === 'list_models' && provider.protocol === 'openai_compatible';

/** The capability fields `next` changes from `previous`; all of them for a new model. */
function changedCapabilities(
  previous: ModelCapabilities | undefined,
  next: ModelCapabilities,
): Partial<ModelCapabilities> | undefined {
  if (!previous) return next;
  const changed = Object.fromEntries(
    Object.entries(next).filter(
      ([key, value]) => previous[key as keyof ModelCapabilities] !== value,
    ),
  );
  return Object.keys(changed).length ? changed : undefined;
}

/**
 * The PUT body that turns `saved` into `draft`: changed or new models, and
 * removals. Only the capability flags the user changed go out, because the
 * server takes a flag it is sent as set by hand, and a passing Test then
 * leaves alone a tools flag that a failed Test turned off (L3).
 */
export function modelsPatch(saved: ModelDraft[], draft: ModelDraft[]) {
  const savedById = new Map(saved.map((m) => [m.modelId, m]));
  const models: ModelInput[] = draft
    .filter((m) => {
      const before = savedById.get(m.modelId);
      return !before || JSON.stringify(toDraft(before)) !== JSON.stringify(toDraft(m));
    })
    .map(({ modelId, displayName, capabilities, pricing, enabled }) => {
      const changed = changedCapabilities(savedById.get(modelId)?.capabilities, capabilities);
      return {
        modelId,
        displayName,
        ...(changed ? { capabilities: changed } : {}),
        pricing,
        enabled,
      };
    });
  const kept = new Set(draft.map((m) => m.modelId));
  const remove = saved.filter((m) => !kept.has(m.modelId)).map((m) => m.modelId);
  return { models, remove };
}

const optionalNumber = (value: string) => (value.trim() === '' ? null : Number(value));

function NumberCell({
  value,
  disabled,
  label,
  step,
  onChange,
}: {
  value: number | null | undefined;
  disabled: boolean;
  label: string;
  step?: number;
  onChange: (value: number | null) => void;
}) {
  return (
    <Input
      type="number"
      min={0}
      step={step ?? 1}
      aria-label={label}
      disabled={disabled}
      value={value ?? ''}
      onChange={(event) => onChange(optionalNumber(event.currentTarget.value))}
      className="h-8 w-24 px-2"
    />
  );
}

export function ModelRows({
  models,
  canEdit,
  onChange,
}: {
  models: ModelDraft[];
  canEdit: boolean;
  onChange?: (models: ModelDraft[]) => void;
}) {
  const disabled = !canEdit || !onChange;
  const update = (index: number, patch: Partial<ModelDraft>) =>
    onChange?.(models.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  const setCapability = (index: number, patch: Partial<ModelCapabilities>) =>
    update(index, { capabilities: { ...models[index]!.capabilities, ...patch } });
  const setPrice = (index: number, key: 'input' | 'output', value: number | null) => {
    const current = models[index]!.pricing;
    const next = { input: current?.input ?? null, output: current?.output ?? null, [key]: value };
    // Pricing is both rates or nothing; one blank rate means "no estimate".
    const pricing: ModelPricing | null =
      next.input === null || next.output === null
        ? null
        : { ...current, input: next.input, output: next.output };
    update(index, { pricing });
  };

  if (!models.length) return <p className="text-sm text-muted-foreground">No models yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1 pr-2 font-normal">On</th>
            <th className="py-1 pr-2 font-normal">Model</th>
            {FLAGS.map((flag) => (
              <th key={flag} className="py-1 pr-2 font-normal capitalize">
                {flag}
              </th>
            ))}
            <th className="py-1 pr-2 font-normal">Context</th>
            <th className="py-1 pr-2 font-normal">Max output</th>
            <th className="py-1 pr-2 font-normal">$ in / 1M</th>
            <th className="py-1 pr-2 font-normal">$ out / 1M</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {models.map((model, index) => (
            <tr key={model.modelId} className="border-t">
              <td className="py-1 pr-2">
                <input
                  type="checkbox"
                  aria-label={`Enable ${model.modelId}`}
                  checked={model.enabled}
                  disabled={disabled}
                  onChange={(event) => update(index, { enabled: event.currentTarget.checked })}
                />
              </td>
              <td className="py-1 pr-2">
                <span className="block">{model.displayName}</span>
                {model.displayName !== model.modelId && (
                  <span className="block font-mono text-xs text-muted-foreground">
                    {model.modelId}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">{model.source}</span>
              </td>
              {FLAGS.map((flag) => (
                <td key={flag} className="py-1 pr-2">
                  <input
                    type="checkbox"
                    aria-label={`${model.modelId} ${flag}`}
                    checked={model.capabilities[flag]}
                    disabled={disabled}
                    onChange={(event) =>
                      setCapability(index, { [flag]: event.currentTarget.checked })
                    }
                  />
                </td>
              ))}
              <td className="py-1 pr-2">
                <NumberCell
                  label={`${model.modelId} context window`}
                  value={model.capabilities.context_window}
                  disabled={disabled}
                  onChange={(context_window) =>
                    setCapability(index, { context_window: context_window || null })
                  }
                />
              </td>
              <td className="py-1 pr-2">
                <NumberCell
                  label={`${model.modelId} max output`}
                  value={model.capabilities.max_output}
                  disabled={disabled}
                  onChange={(max_output) =>
                    setCapability(index, { max_output: max_output || null })
                  }
                />
              </td>
              <td className="py-1 pr-2">
                <NumberCell
                  label={`${model.modelId} input price`}
                  value={model.pricing?.input}
                  step={0.01}
                  disabled={disabled}
                  onChange={(value) => setPrice(index, 'input', value)}
                />
              </td>
              <td className="py-1 pr-2">
                <NumberCell
                  label={`${model.modelId} output price`}
                  value={model.pricing?.output}
                  step={0.01}
                  disabled={disabled}
                  onChange={(value) => setPrice(index, 'output', value)}
                />
              </td>
              <td className="py-1">
                {!disabled && (
                  <IconButton
                    label={`Remove ${model.modelId}`}
                    onClick={() => onChange?.(models.filter((_, i) => i !== index))}
                  >
                    <XIcon />
                  </IconButton>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ModelEditor({ provider, canEdit }: { provider: Provider; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const query = providerModelsQuery(provider.id);
  const { data, error } = useQuery(query);
  const [draft, setDraft] = useState<ModelDraft[] | null>(null);
  const saved = data?.items ?? [];
  const rows = draft ?? saved;

  const save = useMutation({
    mutationFn: () => {
      const { models, remove } = modelsPatch(saved, rows);
      return putModels(provider.id, models, remove);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(query.queryKey, result);
      setDraft(null);
      return queryClient.invalidateQueries({ queryKey: ['models'] });
    },
  });
  const discover = useMutation({
    mutationFn: () => discoverModels(provider.id),
    onSuccess: (result) => {
      queryClient.setQueryData(query.queryKey, { items: result.items });
      if (draft) setDraft(mergeDiscovered(draft, result.items));
      return queryClient.invalidateQueries({ queryKey: ['models'] });
    },
  });

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const modelId = String(new FormData(form).get('modelId')).trim();
    if (!modelId || rows.some((m) => m.modelId === modelId)) return;
    setDraft([
      ...rows,
      {
        modelId,
        displayName: modelId,
        // Tools start on; Test turns the flag off if tool calls fail.
        capabilities: DEFAULT_CAPABILITIES,
        pricing: null,
        enabled: true,
        source: 'manual',
      },
    ]);
    form.reset();
  }

  if (error) return <ErrorText error={error} />;
  if (!data) return null;
  const patch = draft && modelsPatch(saved, draft);
  const dirty = !!patch && patch.models.length + patch.remove.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <ModelRows models={rows} canEdit={canEdit} onChange={canEdit ? setDraft : undefined} />
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <form className="flex gap-2" onSubmit={add}>
            <Input
              name="modelId"
              placeholder="Model id"
              aria-label="Model id"
              className="h-8 w-56"
            />
            <IconButton label="Add model" type="submit" variant="outline">
              <PlusIcon />
            </IconButton>
          </form>
          {canDiscover(provider) && (
            <IconButton
              label={discover.isPending ? 'Discovering…' : 'Discover models'}
              busy={discover.isPending}
              onClick={() => discover.mutate()}
            >
              <SearchIcon />
            </IconButton>
          )}
          {dirty && (
            <>
              <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
                Save models
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                Discard
              </Button>
            </>
          )}
        </div>
      )}
      {discover.data && (
        <p className="text-sm text-muted-foreground">
          Discovered {discover.data.added} new {discover.data.added === 1 ? 'model' : 'models'}.
        </p>
      )}
      <ErrorText error={discover.error ?? save.error} />
    </div>
  );
}
