import {
  checkCron,
  describePreset,
  InvalidScheduleError,
  presetNextRuns,
} from '@openbots/routines';
import {
  INTERVAL_MINUTES_MAX,
  INTERVAL_MINUTES_MIN,
  SchedulePresetSchema,
  type SchedulePreset,
} from '@openbots/shared';

// The schedule editor's model (R1): a draft with a field for every preset,
// so switching presets keeps what was typed, turned into a `SchedulePreset`
// (or a sentence saying what is wrong) on save. Shared by the Routines tab
// and the schedule step of New Bot (B2).

export type ScheduleKind = SchedulePreset['kind'];

export interface ScheduleDraft {
  kind: ScheduleKind;
  time: string;
  day: number;
  /** '1' to '31' or 'last'. */
  date: string;
  minutes: number;
  cron: string;
}

export const SCHEDULE_KINDS: { kind: ScheduleKind; label: string }[] = [
  { kind: 'daily', label: 'Every day' },
  { kind: 'weekdays', label: 'Weekdays' },
  { kind: 'weekly', label: 'Weekly' },
  { kind: 'monthly', label: 'Monthly' },
  { kind: 'every_minutes', label: 'Every N minutes' },
  { kind: 'custom', label: 'Custom cron' },
];

export { INTERVAL_MINUTES_MAX, INTERVAL_MINUTES_MIN };

export const DEFAULT_DRAFT: ScheduleDraft = {
  kind: 'weekdays',
  time: '08:00',
  day: 1,
  date: '1',
  minutes: 15,
  cron: '0 8 * * 1-5',
};

export function draftFromPreset(preset: SchedulePreset): ScheduleDraft {
  const draft = { ...DEFAULT_DRAFT, kind: preset.kind };
  switch (preset.kind) {
    case 'daily':
    case 'weekdays':
      return { ...draft, time: preset.time };
    case 'weekly':
      return { ...draft, time: preset.time, day: preset.day };
    case 'monthly':
      return { ...draft, time: preset.time, date: String(preset.date) };
    case 'every_minutes':
      return { ...draft, minutes: preset.minutes };
    case 'custom':
      return { ...draft, cron: preset.cron };
  }
}

export type PresetCheck = { ok: true; preset: SchedulePreset } | { ok: false; error: string };

export function presetFromDraft(draft: ScheduleDraft): PresetCheck {
  const candidate = (() => {
    switch (draft.kind) {
      case 'daily':
      case 'weekdays':
        return { kind: draft.kind, time: draft.time };
      case 'weekly':
        return { kind: draft.kind, day: draft.day, time: draft.time };
      case 'monthly':
        return {
          kind: draft.kind,
          date: draft.date === 'last' ? 'last' : Number(draft.date),
          time: draft.time,
        };
      case 'every_minutes':
        // An emptied field is NaN; it gets the range message like any other bad number.
        return { kind: draft.kind, minutes: Number.isFinite(draft.minutes) ? draft.minutes : 0 };
      case 'custom':
        return { kind: draft.kind, cron: draft.cron.trim() };
    }
  })();
  const parsed = SchedulePresetSchema.safeParse(candidate);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid schedule' };
  if (parsed.data.kind === 'custom') {
    try {
      checkCron(parsed.data.cron);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof InvalidScheduleError ? error.message : 'Invalid cron',
      };
    }
  }
  return { ok: true, preset: parsed.data };
}

/** The draft in words with the next run, for the editor's preview line. */
export function previewDraft(draft: ScheduleDraft, timezone: string, now = new Date()): string {
  const checked = presetFromDraft(draft);
  if (!checked.ok) return checked.error;
  try {
    const [next] = presetNextRuns(checked.preset, timezone, 1, now);
    const when = next
      ? next.toLocaleString(undefined, {
          timeZone: timezone,
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'never';
    return `${describePreset(checked.preset)}. Next: ${when} (${timezone})`;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid schedule';
  }
}
