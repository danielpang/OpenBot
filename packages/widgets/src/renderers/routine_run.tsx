import { Button, cn } from '@openbots/ui';
import { useState } from 'react';
import type { RoutineRunProps, RoutineRunState } from '../kinds/routine_run.js';
import type { WidgetRendererProps } from './types.js';

// "Routine ran" (R3, plan 10.2): one compact card per run with the outcome,
// when, the activity log and Pause Routine. A failed or cancelled run also
// shows what went wrong and the exception action, Run again; a completed one
// has nothing else to handle (the Bot's reply above it is the result).

const OUTCOME_WORDS: Record<RoutineRunProps['outcome'], string> = {
  completed: 'ran',
  failed: 'failed',
  cancelled: 'was stopped',
};

const REASON_WORDS: Record<RoutineRunProps['reason'], string> = {
  schedule: 'on schedule',
  run_now: 'run now',
  event: 'on an event',
  retry: 'run again',
};

/** Seconds or minutes between two ISO times, for the card. */
export function runDuration(startedAt: string, finishedAt: string): string {
  const ms = Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime());
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function RoutineRunWidget({
  props,
  state,
  onAction,
  onOpenActivity,
}: WidgetRendererProps<RoutineRunProps, RoutineRunState>) {
  const [local, setLocal] = useState<RoutineRunState | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = { ...state, ...local };
  const exception = props.outcome !== 'completed';

  async function act(type: 'run_again' | 'pause') {
    if (!onAction) return;
    setBusy(true);
    setError(null);
    try {
      const next = (await onAction({ type })) as RoutineRunState | undefined;
      setLocal(next ?? (type === 'pause' ? { paused: true } : { rerun_run_id: 'started' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not do that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-widget="routine_run"
      data-outcome={props.outcome}
      className={cn(
        'flex max-w-lg flex-col gap-1.5 rounded-lg border bg-card px-3 py-2 text-sm',
        exception && 'border-destructive/50',
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={cn('font-medium', exception && 'text-destructive')}>
          {props.name} {OUTCOME_WORDS[props.outcome]}
        </span>
        <span className="text-xs text-muted-foreground">
          {REASON_WORDS[props.reason]} · {new Date(props.started_at).toLocaleString()} ·{' '}
          {runDuration(props.started_at, props.finished_at)}
        </span>
        {props.run_id && onOpenActivity && (
          <button
            type="button"
            className="ml-auto text-xs font-medium hover:underline"
            onClick={() => onOpenActivity(props.run_id!)}
          >
            Activity log
          </button>
        )}
      </div>
      {exception && props.exception && (
        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {props.exception}
        </p>
      )}
      {onAction && (
        <div className="flex flex-wrap gap-2">
          {exception && (
            <Button
              type="button"
              size="sm"
              disabled={busy || Boolean(current.rerun_run_id)}
              onClick={() => void act('run_again')}
            >
              {current.rerun_run_id ? 'Started again' : 'Run again'}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || Boolean(current.paused)}
            onClick={() => void act('pause')}
          >
            {current.paused ? 'Routine paused' : 'Pause Routine'}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
