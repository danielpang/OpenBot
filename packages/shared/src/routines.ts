import { z } from 'zod';

// Routines (plan 4.6, 10.2, R1 to R5): the trigger stored in `routines.trigger`
// and the value set of `routine_runs.status`. The schedule arithmetic (presets
// to cron, intervals, next runs in the Routine's timezone) lives in
// `@openbots/routines`.

/** `HH:MM`, 24-hour, in the Routine's timezone. */
export const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 24-hour');

/**
 * Every N minutes, any whole N up to a day (R1). An interval, not a cron: the
 * slots are N minutes apart from the Routine's creation (or its last edit of
 * the schedule) onwards, whatever the clock or the timezone says.
 */
export const INTERVAL_MINUTES_MIN = 1;
export const INTERVAL_MINUTES_MAX = 1440;

/** Sunday is 0, as in cron. */
export const WeekdaySchema = z.number().int().min(0).max(6);

const intervalMessage = `Use a whole number of minutes from ${INTERVAL_MINUTES_MIN} to ${INTERVAL_MINUTES_MAX}`;

/**
 * The schedule presets (plan 10.2, R1). `monthly` takes a date 1 to 31, or
 * `last` for the last day of each month; a month without the date is skipped.
 */
export const SchedulePresetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('daily'), time: TimeOfDaySchema }),
  z.strictObject({ kind: z.literal('weekdays'), time: TimeOfDaySchema }),
  z.strictObject({ kind: z.literal('weekly'), day: WeekdaySchema, time: TimeOfDaySchema }),
  z.strictObject({
    kind: z.literal('monthly'),
    date: z.union([z.number().int().min(1).max(31), z.literal('last')]),
    time: TimeOfDaySchema,
  }),
  z.strictObject({
    kind: z.literal('every_minutes'),
    minutes: z
      .number()
      .int(intervalMessage)
      .min(INTERVAL_MINUTES_MIN, intervalMessage)
      .max(INTERVAL_MINUTES_MAX, intervalMessage),
  }),
  z.strictObject({ kind: z.literal('custom'), cron: z.string().trim().min(9).max(120) }),
]);
export type SchedulePreset = z.infer<typeof SchedulePresetSchema>;

export const ScheduleTriggerSchema = z.strictObject({
  type: z.literal('schedule'),
  /**
   * Five-field cron, derived from `preset` on every write. Absent for
   * `every_minutes`, an interval; a Routine stored before intervals may still
   * carry one there, which is ignored.
   */
  cron: z.string().optional(),
  preset: SchedulePresetSchema,
});
export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;

export const EventSourceSchema = z.enum(['webhook', 'github', 'slack']);

/** An event trigger (R2); its webhook endpoint and matching rule belong to leaf 6.3. */
export const EventTriggerSchema = z.strictObject({
  type: z.literal('event'),
  source: EventSourceSchema,
  endpoint_id: z.uuid().nullable().optional(),
  match: z.record(z.string(), z.unknown()).optional(),
});
export type EventTrigger = z.infer<typeof EventTriggerSchema>;

export const RoutineTriggerSchema = z.discriminatedUnion('type', [
  ScheduleTriggerSchema,
  EventTriggerSchema,
]);
export type RoutineTrigger = z.infer<typeof RoutineTriggerSchema>;

/** What a client sends: a schedule needs only its preset; the server derives the cron. */
export const RoutineTriggerInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('schedule'),
    preset: SchedulePresetSchema,
    cron: z.string().optional(),
  }),
  EventTriggerSchema,
]);
export type RoutineTriggerInput = z.infer<typeof RoutineTriggerInputSchema>;

/**
 * `routine_runs.status`: queued and running follow the run; waiting means it
 * paused for the owner (an approval or a question); the last three are final.
 */
export const RoutineRunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]);
export type RoutineRunStatus = z.infer<typeof RoutineRunStatusSchema>;
