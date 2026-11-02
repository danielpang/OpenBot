import { botModelNeeds, type ModelConfig } from '@openbots/shared';
import { useQuery } from '@tanstack/react-query';
import { capabilitiesQuery } from '../../app/api.js';
import { pickerModelsQuery } from '../models/api.js';
import { ModelPicker, pickerNeeds } from '../models/ModelPicker.js';
import type { Bot } from './queries.js';

// The model section of Bot Settings (L4, plan 3): the picker, filtered by
// what the Bot needs (vision once it uses its computer), a hint when the
// current model cannot see the screen, and Thinking for models that reason.

export const NO_VISION_HINT = "This model can't see images, so the Bot can't see its screen.";

export const THINKING_HELP = 'More effort is slower and uses more tokens.';

export type Thinking = 'off' | 'on' | 'low' | 'medium' | 'high';

export const THINKING_OPTIONS: readonly { value: Thinking; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On (the model decides how much)' },
  { value: 'low', label: 'On, low effort' },
  { value: 'medium', label: 'On, medium effort' },
  { value: 'high', label: 'On, high effort' },
];

/** `model_config.reasoning` as the Thinking select shows it; unset is off. */
export function thinkingOf(reasoning: ModelConfig['reasoning']): Thinking {
  if (reasoning === true) return 'on';
  return reasoning || 'off';
}

export function withThinking(config: ModelConfig, thinking: Thinking): ModelConfig {
  const reasoning = thinking === 'off' ? false : thinking === 'on' ? true : thinking;
  return { ...config, reasoning };
}

export function BotModelFields({
  bot,
  value,
  onChange,
}: {
  bot: Bot;
  value: ModelConfig | null;
  onChange: (value: ModelConfig) => void;
}) {
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const needs = botModelNeeds(bot.toolPolicy, capabilities?.computer ?? false);
  // Every model with tools, so the current model's flags are known even when the picker hides it.
  const { data } = useQuery(pickerModelsQuery(pickerNeeds()));
  const current = value
    ? data?.groups
        .find((g) => g.provider.id === value.provider_id)
        ?.models.find((m) => m.modelId === value.model_id)
    : undefined;

  return (
    <div className="flex flex-col gap-3">
      <ModelPicker value={value} onChange={onChange} needs={needs} botId={bot.id} />
      {current && needs.includes('vision') && !current.capabilities.vision && (
        <p className="text-xs text-muted-foreground">{NO_VISION_HINT}</p>
      )}
      {value && current?.capabilities.reasoning && (
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Thinking</span>
          <select
            value={thinkingOf(value.reasoning)}
            onChange={(event) =>
              onChange(withThinking(value, event.currentTarget.value as Thinking))
            }
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {THINKING_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">{THINKING_HELP}</span>
        </label>
      )}
    </div>
  );
}
