import { DEFAULT_CAPABILITIES, type ModelCapabilities, type ModelPricing } from '@openbots/shared';
import {
  Button,
  ChevronDownIcon,
  EyeIcon,
  IconButton,
  Input,
  LightbulbIcon,
  PlusIcon,
  SearchIcon,
  Switch,
  WrenchIcon,
  XIcon,
} from '@openbots/ui';
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

/** 1000000 as "1M", 200000 as "200K". */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** The one line a collapsed row shows for its limits and prices. */
export function modelSummary(model: Pick<ModelDraft, 'capabilities' | 'pricing'>): string {
  const parts: string[] = [];
  const { context_window: context, max_output: output } = model.capabilities;
  if (context) parts.push(`${compactTokens(context)} context`);
  if (output) parts.push(`${compactTokens(output)} out`);
  if (model.pricing) parts.push(`$${model.pricing.input} / $${model.pricing.output}`);
  return parts.join(' · ');
}

const FLAG_GLYPHS = {
  tools: { name: 'Tools', Icon: WrenchIcon },
  vision: { name: 'Vision', Icon: EyeIcon },
  reasoning: { name: 'Reasoning', Icon: LightbulbIcon },
} as const;

function NumberField({
  value,
  disabled,
  label,
  ariaLabel,
  step,
  onChange,
}: {
  value: number | null | undefined;
  disabled: boolean;
  label: string;
  ariaLabel: string;
  step?: number;
  onChange: (value: number | null) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Input
        type="number"
        min={0}
        step={step ?? 1}
        aria-label={ariaLabel}
        disabled={disabled}
        value={value ?? ''}
        onChange={(event) => onChange(optionalNumber(event.currentTarget.value))}
        className="h-8 px-2 tabular-nums"
      />
    </label>
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
  const [open, setOpen] = useState<string | null>(null);
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
    <ul className="divide-y rounded-lg border bg-card text-sm" aria-label="Models">
      {models.map((model, index) => {
        const expanded = open === model.modelId;
        const summary = modelSummary(model);
        return (
          <li key={model.modelId} className="flex flex-col gap-3 px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Switch
                aria-label={`Enable ${model.modelId}`}
                checked={model.enabled}
                disabled={disabled}
                onChange={(event) => update(index, { enabled: event.currentTarget.checked })}
              />
              <div className="flex min-w-40 flex-1 flex-col">
                <span className="truncate font-medium text-foreground">{model.displayName}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {model.displayName !== model.modelId && (
                    <span className="font-mono">{model.modelId} · </span>
                  )}
                  {model.source}
                  {summary && <span className="tabular-nums"> · {summary}</span>}
                </span>
              </div>
              <div className="flex items-center gap-0.5">
                {FLAGS.map((flag) => {
                  const { name, Icon } = FLAG_GLYPHS[flag];
                  const on = model.capabilities[flag];
                  return (
                    <IconButton
                      key={flag}
                      label={`${model.modelId} ${flag}`}
                      tooltip={`${name} ${on ? 'on' : 'off'}`}
                      aria-pressed={on}
                      disabled={disabled}
                      className={
                        on
                          ? 'bg-accent text-foreground hover:text-foreground'
                          : 'text-muted-foreground/40'
                      }
                      onClick={() => setCapability(index, { [flag]: !on })}
                    >
                      <Icon />
                    </IconButton>
                  );
                })}
                <IconButton
                  label={`${model.modelId} limits and pricing`}
                  tooltip="Limits and pricing"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : model.modelId)}
                >
                  <ChevronDownIcon
                    className={
                      expanded ? 'rotate-180 transition-transform' : 'transition-transform'
                    }
                  />
                </IconButton>
                {!disabled && (
                  <IconButton
                    label={`Remove ${model.modelId}`}
                    tooltip="Remove"
                    onClick={() => onChange?.(models.filter((_, i) => i !== index))}
                  >
                    <XIcon />
                  </IconButton>
                )}
              </div>
            </div>
            {expanded && (
              <div className="grid grid-cols-2 gap-3 pb-1 sm:grid-cols-4">
                <NumberField
                  label="Context window"
                  ariaLabel={`${model.modelId} context window`}
                  value={model.capabilities.context_window}
                  disabled={disabled}
                  onChange={(context_window) =>
                    setCapability(index, { context_window: context_window || null })
                  }
                />
                <NumberField
                  label="Max output"
                  ariaLabel={`${model.modelId} max output`}
                  value={model.capabilities.max_output}
                  disabled={disabled}
                  onChange={(max_output) =>
                    setCapability(index, { max_output: max_output || null })
                  }
                />
                <NumberField
                  label="$ in per 1M tokens"
                  ariaLabel={`${model.modelId} input price`}
                  value={model.pricing?.input}
                  step={0.01}
                  disabled={disabled}
                  onChange={(value) => setPrice(index, 'input', value)}
                />
                <NumberField
                  label="$ out per 1M tokens"
                  ariaLabel={`${model.modelId} output price`}
                  value={model.pricing?.output}
                  step={0.01}
                  disabled={disabled}
                  onChange={(value) => setPrice(index, 'output', value)}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
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
              placeholder="Add a model by id"
              aria-label="Model id"
              className="h-8 w-56 font-mono text-xs"
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
