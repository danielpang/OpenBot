import { cn } from '@openbots/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { activityEntries, addStep, formatUsage, runDuration } from './activity.js';
import { runQuery, runStepsQuery, type Run, type RunStep } from './api.js';
import { useRealtime } from './realtime.js';

// The full activity log for one run (I4, principle 4: on demand, never in the
// chrome): compact entries with durations, live from `run.step`, and the
// run's usage and cost at the end (plan 5.8).

export function ActivityLog({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const { client } = useRealtime();
  const steps = useQuery(runStepsQuery(runId));
  const run = useQuery(runQuery(runId));

  useEffect(() => {
    if (!client) return;
    const offs = [
      client.on('run.step', (event) => {
        const step = event.payload.step as RunStep;
        if (step.runId !== runId) return;
        queryClient.setQueryData(runStepsQuery(runId).queryKey, (list) => addStep(list, step));
      }),
      client.on('run.status', (event) => {
        if (event.payload.runId === runId) void queryClient.invalidateQueries(runQuery(runId));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [client, queryClient, runId]);

  if (steps.isPending) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (steps.isError) return <p className="p-4 text-sm text-destructive">{steps.error.message}</p>;
  return <ActivityList steps={steps.data} run={run.data} />;
}

export function ActivityList({ steps, run }: { steps: RunStep[]; run?: Run }) {
  const entries = activityEntries(steps);
  const live = run && ['queued', 'running'].includes(run.status);
  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      {entries.length === 0 ? (
        <p className="text-muted-foreground">{live ? 'Starting…' : 'Nothing recorded.'}</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-baseline gap-2">
              <span className={cn('min-w-0 flex-1', entry.error && 'text-destructive')}>
                {entry.label}
              </span>
              {entry.duration && (
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {entry.duration}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {run && <RunFooter run={run} />}
    </div>
  );
}

function RunFooter({ run }: { run: Run }) {
  const duration = runDuration(run);
  const lines = [
    run.status === 'completed' ? null : STATUS_TEXT[run.status],
    run.error,
    // How long it took and what it cost; the model and token counts are not the owner's concern.
    [duration, run.usage ? formatUsage(run.usage) : null].filter(Boolean).join(' · ') || null,
  ].filter(Boolean);
  if (!lines.length) return null;
  return (
    <footer className="flex flex-col gap-0.5 border-t pt-3 text-xs text-muted-foreground">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </footer>
  );
}

const STATUS_TEXT: Record<Run['status'], string> = {
  queued: 'Queued',
  running: 'Working',
  waiting: 'Waiting for you',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
};
