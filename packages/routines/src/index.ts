import {
  packageName,
  SchedulePresetSchema,
  type RoutineTrigger,
  type RoutineTriggerInput,
  type SchedulePreset,
  type ScheduleTrigger,
} from '@openbots/shared';
import { Cron } from 'croner';

// Schedules for Routines (plan 10.2, R1): presets to five-field cron, and the
// next run in the Routine's timezone with croner, which keeps wall-clock times
// across DST changes (a weekday 08:00 Routine runs at 08:00 local before and
// after the switch). `every_minutes` is an interval instead: slots N minutes
// apart from an anchor (the Routine's creation or schedule edit, then each
// slot it ran), so any N from 1 to 1440 keeps a fixed rhythm. The scheduler in
// the server's worker calls `triggerNextRunAt`.

export const PACKAGE_NAME = packageName('routines');

export class InvalidScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScheduleError';
  }
}

const hhmm = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return { h: h!, m: m! };
};

/** The presets croner schedules; `every_minutes` is an interval. */
export type CronPreset = Exclude<SchedulePreset, { kind: 'every_minutes' }>;

/** The five-field cron for a preset. A custom cron is checked, not rewritten. */
export function presetToCron(preset: CronPreset): string {
  switch (preset.kind) {
    case 'daily': {
      const { h, m } = hhmm(preset.time);
      return `${m} ${h} * * *`;
    }
    case 'weekdays': {
      const { h, m } = hhmm(preset.time);
      return `${m} ${h} * * 1-5`;
    }
    case 'weekly': {
      const { h, m } = hhmm(preset.time);
      return `${m} ${h} * * ${preset.day}`;
    }
    case 'monthly': {
      const { h, m } = hhmm(preset.time);
      return `${m} ${h} ${preset.date === 'last' ? 'L' : preset.date} * *`;
    }
    case 'custom':
      checkCron(preset.cron);
      return preset.cron.trim().replace(/\s+/g, ' ');
  }
}

/** Throws `InvalidScheduleError` for a preset that can never run (a bad custom cron). */
export function checkPreset(preset: SchedulePreset): void {
  if (preset.kind !== 'every_minutes') presetToCron(preset);
}

const MINUTE_MS = 60_000;

/**
 * The first interval slot strictly after `after`: `anchor` plus a whole
 * number of `minutes`. Without an anchor the interval starts at `after`'s
 * minute, so the first slot is one interval from now.
 */
export function nextIntervalRun(minutes: number, after: Date, anchor?: Date | null): Date {
  const step = minutes * MINUTE_MS;
  const start = anchor ? anchor.getTime() : Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS;
  const k = Math.floor((after.getTime() - start) / step) + 1;
  return new Date(start + k * step);
}

/** Throws `InvalidScheduleError` unless `cron` is a five-field expression croner can schedule. */
export function checkCron(cron: string): void {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new InvalidScheduleError(
      'A custom schedule needs five cron fields: minute hour day month weekday',
    );
  }
  try {
    const job = new Cron(cron, { mode: '5-part', paused: true });
    if (!job.nextRun()) throw new InvalidScheduleError('That cron expression never runs');
  } catch (error) {
    if (error instanceof InvalidScheduleError) throw error;
    throw new InvalidScheduleError(
      `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** True for an IANA timezone name the runtime knows ("Europe/London", "UTC"). */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The stored trigger for a client's input: a schedule gets its cron from the
 * preset, and an interval gets none.
 */
export function normalizeTrigger(input: RoutineTriggerInput): RoutineTrigger {
  if (input.type === 'event') return input;
  const preset = SchedulePresetSchema.parse(input.preset);
  if (preset.kind === 'every_minutes') return { type: 'schedule', preset };
  return { type: 'schedule', cron: presetToCron(preset), preset } satisfies ScheduleTrigger;
}

/** The first run strictly after `after`, in `timezone`; null when the cron never runs again. */
export function nextRunAt(cron: string, timezone: string, after: Date = new Date()): Date | null {
  if (!isValidTimezone(timezone)) throw new InvalidScheduleError(`Unknown timezone ${timezone}`);
  const job = new Cron(cron, { mode: '5-part', timezone, paused: true });
  return job.nextRun(after);
}

/** The next `n` runs after `after`, for previews. */
export function nextRuns(cron: string, timezone: string, n: number, after: Date = new Date()) {
  if (!isValidTimezone(timezone)) throw new InvalidScheduleError(`Unknown timezone ${timezone}`);
  return new Cron(cron, { mode: '5-part', timezone, paused: true }).nextRuns(n, after);
}

/** The next `n` runs of a preset after `after`, for previews; an interval starts at `after`. */
export function presetNextRuns(
  preset: SchedulePreset,
  timezone: string,
  n: number,
  after: Date = new Date(),
): Date[] {
  if (preset.kind !== 'every_minutes') return nextRuns(presetToCron(preset), timezone, n, after);
  if (!isValidTimezone(timezone)) throw new InvalidScheduleError(`Unknown timezone ${timezone}`);
  const first = nextIntervalRun(preset.minutes, after);
  return Array.from(
    { length: n },
    (_, i) => new Date(first.getTime() + i * preset.minutes * MINUTE_MS),
  );
}

/**
 * When a trigger next fires after `after`: null for event triggers, which have
 * no schedule. An interval counts from `anchor` (the slot that just ran), or
 * from `after` when there is none (a new or edited schedule).
 */
export function triggerNextRunAt(
  trigger: RoutineTrigger,
  timezone: string,
  after: Date = new Date(),
  anchor?: Date | null,
): Date | null {
  if (trigger.type !== 'schedule') return null;
  const { preset } = trigger;
  if (preset.kind === 'every_minutes') {
    if (!isValidTimezone(timezone)) throw new InvalidScheduleError(`Unknown timezone ${timezone}`);
    return nextIntervalRun(preset.minutes, after, anchor);
  }
  return nextRunAt(trigger.cron ?? presetToCron(preset), timezone, after);
}

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const ordinal = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

/** A preset in words: "Weekdays at 08:00", "Every 15 minutes", "Cron 0 9 * * 1". */
export function describePreset(preset: SchedulePreset): string {
  switch (preset.kind) {
    case 'daily':
      return `Every day at ${preset.time}`;
    case 'weekdays':
      return `Weekdays at ${preset.time}`;
    case 'weekly':
      return `Every ${WEEKDAY_NAMES[preset.day]} at ${preset.time}`;
    case 'monthly':
      return preset.date === 'last'
        ? `On the last day of every month at ${preset.time}`
        : `On the ${ordinal(preset.date)} of every month at ${preset.time}`;
    case 'every_minutes': {
      const { minutes } = preset;
      if (minutes === 1) return 'Every minute';
      if (minutes === 60) return 'Every hour';
      return minutes % 60 === 0 ? `Every ${minutes / 60} hours` : `Every ${minutes} minutes`;
    }
    case 'custom':
      return `Cron ${preset.cron}`;
  }
}

/** A trigger in words, with the timezone for schedules: "Weekdays at 08:00 (Europe/London)". */
export function describeTrigger(trigger: RoutineTrigger, timezone?: string): string {
  if (trigger.type === 'event') {
    const source = { webhook: 'a webhook', github: 'a GitHub event', slack: 'a Slack event' };
    return `When ${source[trigger.source]} arrives`;
  }
  const words = describePreset(trigger.preset);
  return timezone && trigger.preset.kind !== 'every_minutes' ? `${words} (${timezone})` : words;
}
