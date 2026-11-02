import {
  defaultReasoning,
  modelSupports,
  type ModelConfig,
  type ModelNeed,
} from '@openbots/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { pickerModelsQuery, type PickerGroup, type ProviderModel } from './api.js';
import { formatTokens } from './format.js';

// The Bot model picker (L4): enabled models grouped by provider, hiding those
// that lack what the Bot needs. Tools are always needed; Bot Settings adds
// vision once the Bot uses its computer, and names the Bot so the server
// filters the same way. Options name the model and its context window, not
// its price: pricing lives in the model editor, and cost estimates in the
// activity log and Bot Settings usage.

export interface ModelPickerProps {
  value: ModelConfig | null;
  /**
   * Called with the new choice. Other fields of `value` (temperature, ...)
   * are kept; thinking is reset to the new model's default (plan 3).
   */
  onChange: (value: ModelConfig) => void;
  needs?: readonly ModelNeed[];
  /** The Bot the model is for; the server adds what it needs. */
  botId?: string;
  id?: string;
  disabled?: boolean;
}

export function pickerNeeds(needs: readonly ModelNeed[] = []): ModelNeed[] {
  return [...new Set<ModelNeed>(['tools', ...needs])];
}

const optionValue = (providerId: string, modelId: string) => `${providerId}/${modelId}`;

export function modelLabel(model: ProviderModel): string {
  return `${model.displayName} · ${formatTokens(model.capabilities.context_window)} context`;
}

/**
 * The config for a picked option (`<provider id>/<model id>`): the other
 * fields of `value` stay, and thinking becomes the new model's default,
 * adaptive on an Anthropic model that reasons (plan 3).
 */
export function chooseModel(
  groups: readonly PickerGroup[],
  value: ModelConfig | null,
  option: string,
): ModelConfig {
  const slash = option.indexOf('/');
  const providerId = option.slice(0, slash);
  const modelId = option.slice(slash + 1);
  const group = groups.find((g) => g.provider.id === providerId);
  const model = group?.models.find((m) => m.modelId === modelId);
  const next: ModelConfig = { ...value, provider_id: providerId, model_id: modelId };
  delete next.reasoning;
  const reasoning =
    group && model ? defaultReasoning(group.provider, model.capabilities) : undefined;
  return reasoning === undefined ? next : { ...next, reasoning };
}

export function ModelPicker({ value, onChange, needs, botId, id, disabled }: ModelPickerProps) {
  const required = pickerNeeds(needs);
  const { data, error } = useQuery(pickerModelsQuery(required, botId));
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!data) return null;

  // The server filters too; this keeps the picker right whatever it is handed.
  const groups = data.groups
    .map((group) => ({
      ...group,
      models: group.models.filter((m) => m.enabled && modelSupports(m, required)),
    }))
    .filter((group) => group.models.length > 0);
  const selected = value
    ? groups
        .find((g) => g.provider.id === value.provider_id)
        ?.models.find((m) => m.modelId === value.model_id)
    : undefined;

  if (!groups.length) {
    return (
      <p className="text-sm text-muted-foreground">
        {`No model supports what this Bot needs (${required.join(', ')}). `}
        <Link to="/settings/models" className="underline">
          Add a provider
        </Link>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <select
        id={id}
        aria-label={id ? undefined : 'Model'}
        disabled={disabled}
        value={value ? optionValue(value.provider_id, value.model_id) : ''}
        onChange={(event) => onChange(chooseModel(groups, value, event.currentTarget.value))}
        className="h-9 rounded-md border border-input bg-background px-3 text-sm"
      >
        {!value && (
          <option value="" disabled>
            Pick a model
          </option>
        )}
        {value && !selected && (
          <option value={optionValue(value.provider_id, value.model_id)} disabled>
            {value.model_id} (unavailable)
          </option>
        )}
        {groups.map((group) => (
          <optgroup key={group.provider.id} label={group.provider.name}>
            {group.models.map((model) => (
              <option key={model.id} value={optionValue(group.provider.id, model.modelId)}>
                {modelLabel(model)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {value && !selected && (
        <p className="text-sm text-destructive">
          The current model is disabled, removed, or lacks {required.join(' or ')}. Pick another.
        </p>
      )}
    </div>
  );
}
