import type { Run, RunStep } from './api.js';

// Formatting for the activity log (I4): compact entries with durations, then
// the run's usage and cost at the end (plan 5.8), never in the transcript.

export interface ActivityEntry {
  id: string;
  label: string;
  /** "387ms", "2.4s", "1m 5s"; null when the step has no duration or its label carries it. */
  duration: string | null;
  error: boolean;
}

/** Model steps label themselves with their time ("Thought briefly", "Thought for 12s"). */
const LABEL_CARRIES_TIME = new Set<RunStep['type']>(['llm']);

export function activityEntries(steps: readonly RunStep[]): ActivityEntry[] {
  return [...steps]
    .sort((a, b) => a.idx - b.idx)
    .map((step) => ({
      id: step.id,
      label: step.label,
      duration:
        step.durationMs === null || LABEL_CARRIES_TIME.has(step.type)
          ? null
          : formatDuration(step.durationMs),
      error: step.type === 'error',
    }));
}

/** Adds a `run.step` to the list once, in idx order. */
export function addStep(steps: readonly RunStep[] | undefined, step: RunStep): RunStep[] {
  const list = steps ?? [];
  if (list.some((s) => s.id === step.id || s.idx === step.idx)) return [...list];
  return [...list, step].sort((a, b) => a.idx - b.idx);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const rest = seconds % 60;
  return `${Math.floor(seconds / 60)}m${rest ? ` ${rest}s` : ''}`;
}

/**
 * The run's cost estimate (L4), "$0.0042"; null when the model has no
 * pricing. Token counts stay out of the UI (principle 10).
 */
export function formatUsage(usage: NonNullable<Run['usage']>): string | null {
  return usage.costUsd === null ? null : formatCost(usage.costUsd);
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** The run's wall time, once it has started. */
export function runDuration(run: Pick<Run, 'startedAt' | 'finishedAt'>): string | null {
  if (!run.startedAt || !run.finishedAt) return null;
  return formatDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt));
}
