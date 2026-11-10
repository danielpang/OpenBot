import {
  CODER_AGENT_LABELS,
  CODER_MODEL_SUGGESTIONS,
  CoderModelNameSchema,
  type CoderAgent,
} from '@openbots/shared';
import { Button, Input } from '@openbots/ui';
import { useId, useState, type FormEvent } from 'react';
import type { CoderChoiceProps, CoderChoiceState } from '../kinds/coder_choice.js';
import type { WidgetRendererProps } from './types.js';

// The owner picks the coding agent and model for a task (CA9): one button
// per agent (signed in or not), a model field with suggestions for the
// chosen agent, and "Use as my default" so later tasks do not ask. Once
// answered it stays, disabled, saying what was chosen.

/** Why a typed model name would be refused, or null when it is fine. */
export function coderChoiceModelError(value: string): string | null {
  if (!value.trim()) return 'Choose or type a model';
  const parsed = CoderModelNameSchema.safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Not a model name');
}

/** The model offered first for `agent`: the one already set, else the first suggestion. */
export function firstModel(props: CoderChoiceProps, agent: CoderAgent): string {
  return (
    props.agents.find((a) => a.agent === agent)?.model ?? CODER_MODEL_SUGGESTIONS[agent][0] ?? ''
  );
}

export function CoderChoiceWidget({
  props,
  state,
  onAction,
}: WidgetRendererProps<CoderChoiceProps, CoderChoiceState>) {
  const initialAgent =
    props.agent && props.agents.some((a) => a.agent === props.agent)
      ? props.agent
      : (props.agents.find((a) => a.signed_in)?.agent ?? props.agents[0]!.agent);
  const [agent, setAgent] = useState<CoderAgent>(initialAgent);
  const [model, setModel] = useState(() => firstModel(props, initialAgent));
  const [remember, setRemember] = useState(true);
  const [local, setLocal] = useState<CoderChoiceState | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();

  const current = state && state.status !== 'pending' ? state : (local ?? state);
  const done = !!current && current.status !== 'pending';
  const disabled = done || busy || !onAction;
  const problem = coderChoiceModelError(model);

  async function send(action: Record<string, unknown>) {
    if (!onAction) return;
    setBusy(true);
    setError(null);
    try {
      const next = (await onAction(action)) as CoderChoiceState | undefined;
      setLocal(
        next && next.status !== 'pending'
          ? next
          : action.type === 'cancel'
            ? { status: 'cancelled' }
            : { status: 'chosen', agent, model: model.trim(), remember },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the choice');
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (problem) return;
    void send({ type: 'choose', agent, model: model.trim(), remember });
  }

  function pick(next: CoderAgent) {
    setAgent(next);
    setModel(firstModel(props, next));
  }

  return (
    <div
      className="flex max-w-lg flex-col gap-3 rounded-lg border bg-card p-3 text-sm"
      data-coder-choice
    >
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">Choose a coding agent</p>
        {props.repo && <p className="text-xs text-muted-foreground">For {props.repo}</p>}
        {props.prompt_excerpt && (
          <p className="line-clamp-2 text-xs text-muted-foreground">{props.prompt_excerpt}</p>
        )}
      </div>

      {done ? (
        <p role="status" className="text-muted-foreground">
          {current.status === 'chosen' && current.agent
            ? `Chose ${CODER_AGENT_LABELS[current.agent]} with ${current.model ?? 'its model'}${
                current.remember ? ', saved as your default' : ''
              }.`
            : 'Not started.'}
        </p>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Coding agent">
            {props.agents.map((a) => (
              <Button
                key={a.agent}
                type="button"
                size="sm"
                role="radio"
                aria-checked={agent === a.agent}
                variant={agent === a.agent ? 'default' : 'outline'}
                disabled={disabled}
                onClick={() => pick(a.agent)}
              >
                {CODER_AGENT_LABELS[a.agent]}
                {!a.signed_in && (
                  <span className="ml-1 text-xs font-normal opacity-70">(sign in)</span>
                )}
              </Button>
            ))}
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Model</span>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              list={listId}
              aria-label="Model"
              aria-invalid={problem ? true : undefined}
              placeholder="A model name"
              maxLength={100}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              className="font-mono text-xs"
            />
            <datalist id={listId}>
              {CODER_MODEL_SUGGESTIONS[agent].map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {model.trim() && problem && <span className="text-xs text-destructive">{problem}</span>}
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              disabled={disabled}
            />
            Use as my default for later tasks (change it in Settings &gt; Coding agents)
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={disabled || !!problem}>
              Start
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void send({ type: 'cancel' })}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
