import type { CodingRoutineTemplate, RoutineTriggerInput } from '@openbots/shared';
import { Button, cn, Input } from '@openbots/ui';
import { browserTimezone } from '@openbots/widgets/react';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { skillsQuery, usableSkills } from '../skills/api.js';
import { useShowBotPanel } from '../transcript/panel.js';
import { RoutineEndpoint } from '../webhooks/endpoints.js';
import {
  routineRunsQuery,
  routinesQuery,
  useRoutineActions,
  type Routine,
  type RoutineRun,
} from './api.js';
import { EventFields } from './event-fields.js';
import { DEFAULT_DRAFT, draftFromPreset, presetFromDraft, type ScheduleDraft } from './schedule.js';
import { ScheduleFields } from './schedule-fields.js';
import { TemplateChooser, TemplateRoutineForm } from './templates.js';
import {
  DEFAULT_EVENT_DRAFT,
  draftFromTrigger,
  matchFromDraft,
  type EventDraft,
} from './trigger.js';

// The Bot's Routines tab (R1 to R4): each Routine with its trigger, last run
// and next run; Run now, Pause or Resume, Edit and Delete; and its run
// records (the 20 most recent), each opening the run's activity log. Every
// run also posts into the Bot's transcript, where exceptions are handled.
// An event Routine shows the endpoint it waits on (R2, H2), made with it; the
// Bot's inbox (H1) is in Bot Settings. A new Routine can start from a coding
// template (CA11).

type TriggerType = RoutineTriggerInput['type'];

const selectClass = 'h-9 rounded-md border bg-transparent px-2 text-sm';

const STATUS_WORDS: Record<RoutineRun['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting for you',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Stopped',
};

const REASON_WORDS: Record<RoutineRun['reason'], string> = {
  schedule: 'On schedule',
  run_now: 'Run now',
  event: 'Event',
  retry: 'Run again',
};

export const formatWhen = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'None';

/** "Next run" in words: paused, event-triggered, or when. */
export function nextRunText(routine: Pick<Routine, 'enabled' | 'nextRunAt' | 'trigger'>) {
  if (!routine.enabled) return 'Paused';
  if (routine.trigger.type === 'event') return 'On the next event';
  return formatWhen(routine.nextRunAt);
}

export function lastRunText(routine: Pick<Routine, 'lastRun'>) {
  const run = routine.lastRun;
  return run ? `${STATUS_WORDS[run.status]} · ${formatWhen(run.startedAt)}` : 'Never';
}

export function RoutinesTab({ botId }: { botId: string }) {
  const { data, error } = useQuery(routinesQuery(botId));
  const [adding, setAdding] = useState(false);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Run this Bot on a schedule or when an event arrives.
        </p>
        {!adding && (
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => {
              setAdding(true);
            }}
          >
            New Routine
          </Button>
        )}
      </div>
      {adding && <NewRoutine botId={botId} onDone={() => setAdding(false)} />}
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {data && !data.length && !adding && (
        <p className="text-sm text-muted-foreground">No Routines yet.</p>
      )}
      {!!data?.length && (
        <ul className="divide-y rounded-md border">
          {data.map((routine) => (
            <RoutineRow key={routine.id} botId={botId} routine={routine} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** New Routine: a coding template (CA11), or the manual form below it. */
function NewRoutine({ botId, onDone }: { botId: string; onDone(name?: string): void }) {
  const [template, setTemplate] = useState<CodingRoutineTemplate | null>(null);
  if (template) {
    return (
      <TemplateRoutineForm
        botId={botId}
        template={template}
        onBack={() => setTemplate(null)}
        onDone={onDone}
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <TemplateChooser onPick={setTemplate} />
      <RoutineForm botId={botId} onDone={() => onDone()} />
    </div>
  );
}

export function RoutineRow({ botId, routine }: { botId: string; routine: Routine }) {
  const actions = useRoutineActions(botId);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const failure = [actions.update, actions.runNow, actions.remove].find((m) => m.error)?.error;

  if (editing) {
    return (
      <li className="p-3">
        <RoutineForm botId={botId} routine={routine} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-2 px-3 py-2.5 text-sm" data-routine={routine.id}>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn('font-medium', !routine.enabled && 'text-muted-foreground')}>
            {routine.name}
          </span>
          <span className="text-xs text-muted-foreground">{routine.schedule}</span>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs">
            <dt className="text-muted-foreground">Last run</dt>
            <dd>{lastRunText(routine)}</dd>
            <dt className="text-muted-foreground">Next run</dt>
            <dd>{nextRunText(routine)}</dd>
          </dl>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={actions.runNow.isPending}
            onClick={() => actions.runNow.mutate(routine.id)}
          >
            Run now
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={actions.update.isPending}
            onClick={() =>
              actions.update.mutate({ id: routine.id, body: { enabled: !routine.enabled } })
            }
          >
            {routine.enabled ? 'Pause' : 'Resume'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={actions.remove.isPending}
            onClick={() => {
              if (
                globalThis.confirm?.(`Delete the Routine “${routine.name}” and its run records?`)
              ) {
                actions.remove.mutate(routine.id);
              }
            }}
          >
            Delete
          </Button>
        </div>
      </div>
      {failure && <p className="text-xs text-destructive">{failure.message}</p>}
      {routine.trigger.type === 'event' && <RoutineEndpoint botId={botId} routine={routine} />}
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer select-none text-xs text-muted-foreground">Runs</summary>
        {open && <RoutineRuns botId={botId} routineId={routine.id} />}
      </details>
    </li>
  );
}

function RoutineRuns({ botId, routineId }: { botId: string; routineId: string }) {
  const { data } = useQuery(routineRunsQuery(routineId));
  const showPanel = useShowBotPanel(botId);
  if (!data) return null;
  if (!data.length) return <p className="mt-1 text-xs text-muted-foreground">No runs yet.</p>;
  return (
    <RunRecords runs={data} onOpenActivity={(runId) => showPanel({ kind: 'activity', runId })} />
  );
}

export function RunRecords({
  runs,
  onOpenActivity,
}: {
  runs: readonly RoutineRun[];
  onOpenActivity?(runId: string): void;
}) {
  return (
    <ol className="mt-1 flex flex-col gap-1 border-l pl-3 text-xs">
      {runs.map((run) => (
        <li key={run.id} className="flex flex-col" data-status={run.status}>
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span
              className={cn(
                (run.status === 'failed' || run.status === 'cancelled') && 'text-destructive',
              )}
            >
              {STATUS_WORDS[run.status]}
            </span>
            <span className="text-muted-foreground">
              {REASON_WORDS[run.reason]} · {formatWhen(run.startedAt)}
            </span>
            {run.runId && onOpenActivity && (
              <button
                type="button"
                className="font-medium hover:underline"
                onClick={() => onOpenActivity(run.runId!)}
              >
                Activity log
              </button>
            )}
          </span>
          {run.exception && <span className="text-muted-foreground">{run.exception}</span>}
        </li>
      ))}
    </ol>
  );
}

/**
 * Create or edit a Routine: name, what to do (a prompt, a Skill or both), its
 * trigger. A new Routine starts enabled; Pause and Resume live on its row.
 */
export function RoutineForm({
  botId,
  routine,
  onDone,
}: {
  botId: string;
  routine?: Routine;
  onDone(): void;
}) {
  const actions = useRoutineActions(botId);
  const skills = useQuery(skillsQuery);
  const [name, setName] = useState(routine?.name ?? '');
  const [prompt, setPrompt] = useState(routine?.prompt ?? '');
  const [skillId, setSkillId] = useState(routine?.skillId ?? '');
  const [timezone, setTimezone] = useState(routine?.timezone ?? browserTimezone());
  const [triggerType, setTriggerType] = useState<TriggerType>(routine?.trigger.type ?? 'schedule');
  const [draft, setDraft] = useState<ScheduleDraft>(
    routine?.trigger.type === 'schedule' ? draftFromPreset(routine.trigger.preset) : DEFAULT_DRAFT,
  );
  const [eventDraft, setEventDraft] = useState<EventDraft>(
    routine?.trigger.type === 'event' ? draftFromTrigger(routine.trigger) : DEFAULT_EVENT_DRAFT,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const mutation = routine ? actions.update : actions.create;
  // A Routine runs only a Skill its Bot has enabled (S2); the one it already
  // has stays listed, unselectable, so the form says why it will not run.
  const usable = usableSkills(skills.data?.items ?? [], [botId]);
  const skillChoices = (skills.data?.items ?? []).filter(
    (skill) => usable.includes(skill) || skill.id === routine?.skillId,
  );

  function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    if (!prompt.trim() && !skillId) return setProblem('Write a prompt or pick a Skill.');
    let trigger: RoutineTriggerInput;
    if (triggerType === 'schedule') {
      const checked = presetFromDraft(draft);
      if (!checked.ok) return setProblem(checked.error);
      trigger = { type: 'schedule', preset: checked.preset };
    } else {
      const checked = matchFromDraft(eventDraft);
      if (!checked.ok) return setProblem(checked.error);
      // The trigger is stored as sent, so keep the endpoint it already records.
      const endpointId = routine?.trigger.type === 'event' ? routine.trigger.endpoint_id : null;
      trigger = {
        type: 'event',
        source: eventDraft.source,
        ...(endpointId ? { endpoint_id: endpointId } : {}),
        ...(checked.match ? { match: checked.match } : {}),
      };
    }
    const body = {
      name: name.trim(),
      prompt: prompt.trim(),
      skillId: skillId || null,
      timezone: timezone.trim() || 'UTC',
      trigger,
    };
    const done = { onSuccess: onDone };
    if (routine) actions.update.mutate({ id: routine.id, body }, done);
    else actions.create.mutate(body, done);
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-md border p-3"
      onSubmit={submit}
      aria-label={routine ? 'Edit Routine' : 'New Routine'}
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name, e.g. Morning briefing"
        aria-label="Routine name"
        maxLength={120}
        required
      />
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="What should the Bot do each time?"
        aria-label="Prompt"
        rows={3}
        className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
      />
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Skill
        <select
          aria-label="Skill"
          value={skillId}
          onChange={(e) => setSkillId(e.target.value)}
          className={cn(selectClass, 'w-64')}
        >
          <option value="">No Skill</option>
          {skillChoices.map((skill) => (
            <option key={skill.id} value={skill.id} disabled={!usable.includes(skill)}>
              {usable.includes(skill) ? skill.name : `${skill.name} (not enabled for this Bot)`}
            </option>
          ))}
        </select>
        <span>Skills enabled for this Bot in its Settings.</span>
      </label>
      {/* An endpoint belongs to an event Routine, so the kind of trigger is chosen once. */}
      {!routine && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Starts
          <select
            aria-label="Starts"
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value as TriggerType)}
            className={cn(selectClass, 'w-56')}
          >
            <option value="schedule">On a schedule</option>
            <option value="event">When an event arrives</option>
          </select>
        </label>
      )}
      {triggerType === 'event' ? (
        <EventFields value={eventDraft} onChange={setEventDraft} />
      ) : (
        <>
          <ScheduleFields value={draft} onChange={setDraft} timezone={timezone || 'UTC'} />
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Timezone
            <Input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              aria-label="Timezone"
              placeholder="Europe/London"
              className="w-56"
            />
          </label>
        </>
      )}
      {(problem ?? mutation.error) && (
        <p className="text-sm text-destructive">{problem ?? mutation.error?.message}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={mutation.isPending}>
          {routine ? 'Save' : 'Create Routine'}
        </Button>
      </div>
    </form>
  );
}
