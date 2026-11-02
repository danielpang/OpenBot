import { describePreset } from '@openbots/routines';
import { Button } from '@openbots/ui';
import { useState } from 'react';
import type { RoutineProposalProps, RoutineProposalState } from '../kinds/routine_proposal.js';
import type { WidgetRendererProps } from './types.js';

// "Create Routine?" (R5): the schedule in words, the prompt, and Confirm or
// Decline. Confirm sends the browser's timezone when the proposal names
// none, so "every weekday at 8" means 8 where the owner is. Once answered it
// stays, disabled, saying what happened.

/** The owner's timezone as the browser knows it. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function RoutineProposalWidget({
  props,
  state,
  onAction,
}: WidgetRendererProps<RoutineProposalProps, RoutineProposalState>) {
  const [local, setLocal] = useState<RoutineProposalState | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = state && state.status !== 'pending' ? state : (local ?? state);
  const status = current?.status ?? 'pending';
  const pending = status === 'pending';
  const timezone = props.timezone ?? current?.timezone ?? browserTimezone();

  async function answer(type: 'confirm' | 'decline') {
    if (!onAction) return;
    setBusy(true);
    setError(null);
    try {
      const action = type === 'confirm' ? { type, timezone } : { type };
      const next = (await onAction(action)) as RoutineProposalState | undefined;
      setLocal(next ?? { status: type === 'confirm' ? 'confirmed' : 'declined' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the answer');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-widget="routine_proposal"
      data-status={status}
      className="flex max-w-lg flex-col gap-2 rounded-lg border bg-card p-3 text-sm"
    >
      <p className="font-medium">Create Routine “{props.name}”?</p>
      <p className="text-muted-foreground">
        {describePreset(props.trigger.preset)}
        {props.trigger.preset.kind !== 'every_minutes' && ` · ${timezone}`}
      </p>
      <p className="whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5">{props.prompt}</p>
      {props.reason && <p className="text-xs text-muted-foreground">{props.reason}</p>}
      {pending ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy || !onAction}
            onClick={() => void answer('confirm')}
          >
            Create Routine
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !onAction}
            onClick={() => void answer('decline')}
          >
            Not now
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {status === 'confirmed' ? 'Created' : 'Declined'}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
