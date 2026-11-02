import { describe, expect, it } from 'vitest';
import {
  checkCron,
  describePreset,
  describeTrigger,
  InvalidScheduleError,
  isValidTimezone,
  nextRunAt,
  nextRuns,
  normalizeTrigger,
  nextIntervalRun,
  PACKAGE_NAME,
  presetNextRuns,
  presetToCron,
  triggerNextRunAt,
} from './index.js';
import { SchedulePresetSchema } from '@openbots/shared';

describe('@openbots/routines', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@openbots/routines');
  });
});

describe('presetToCron', () => {
  it('maps every preset', () => {
    expect(presetToCron({ kind: 'daily', time: '07:30' })).toBe('30 7 * * *');
    expect(presetToCron({ kind: 'weekdays', time: '08:00' })).toBe('0 8 * * 1-5');
    expect(presetToCron({ kind: 'weekly', day: 0, time: '18:05' })).toBe('5 18 * * 0');
    expect(presetToCron({ kind: 'monthly', date: 15, time: '09:00' })).toBe('0 9 15 * *');
    expect(presetToCron({ kind: 'monthly', date: 'last', time: '23:59' })).toBe('59 23 L * *');
    expect(presetToCron({ kind: 'custom', cron: ' 0  9 * *  1 ' })).toBe('0 9 * * 1');
  });

  it('refuses a custom cron that is not five valid fields', () => {
    expect(() => checkCron('0 9 * *')).toThrow(InvalidScheduleError);
    expect(() => checkCron('0 0 9 * * 1')).toThrow(/five cron fields/);
    expect(() => checkCron('61 9 * * *')).toThrow(InvalidScheduleError);
    expect(() => checkCron('0 9 31 2 *')).toThrow(InvalidScheduleError);
  });

  it('normalizes a schedule input to the stored trigger', () => {
    expect(
      normalizeTrigger({ type: 'schedule', preset: { kind: 'weekdays', time: '08:00' } }),
    ).toEqual({
      type: 'schedule',
      cron: '0 8 * * 1-5',
      preset: { kind: 'weekdays', time: '08:00' },
    });
    // A cron sent by the client is ignored; the preset decides.
    expect(
      normalizeTrigger({
        type: 'schedule',
        cron: '* * * * *',
        preset: { kind: 'daily', time: '06:00' },
      }).type,
    ).toBe('schedule');
    // An interval has no cron.
    expect(
      normalizeTrigger({ type: 'schedule', preset: { kind: 'every_minutes', minutes: 7 } }),
    ).toEqual({ type: 'schedule', preset: { kind: 'every_minutes', minutes: 7 } });
    expect(normalizeTrigger({ type: 'event', source: 'github' })).toEqual({
      type: 'event',
      source: 'github',
    });
  });
});

describe('nextRunAt', () => {
  it('runs weekdays at 08:00 in the Routine’s timezone', () => {
    // Friday 2026-10-16 09:00 in New York (EDT, UTC-4): next is Monday 08:00 EDT.
    const after = new Date('2026-10-16T13:00:00Z');
    expect(nextRunAt('0 8 * * 1-5', 'America/New_York', after)?.toISOString()).toBe(
      '2026-10-19T12:00:00.000Z',
    );
    expect(nextRunAt('0 8 * * 1-5', 'UTC', after)?.toISOString()).toBe('2026-10-19T08:00:00.000Z');
    expect(nextRunAt('0 8 * * 1-5', 'Asia/Tokyo', after)?.toISOString()).toBe(
      '2026-10-18T23:00:00.000Z',
    );
  });

  it('is strictly after the given instant', () => {
    const slot = new Date('2026-10-19T08:00:00Z');
    expect(nextRunAt('0 8 * * 1-5', 'UTC', slot)?.toISOString()).toBe('2026-10-20T08:00:00.000Z');
  });

  it('keeps the wall-clock time across the spring DST change', () => {
    // Europe/London moves to BST on Sunday 2026-03-29.
    const runs = nextRuns('0 8 * * 1-5', 'Europe/London', 3, new Date('2026-03-26T12:00:00Z'));
    expect(runs.map((d) => d.toISOString())).toEqual([
      '2026-03-27T08:00:00.000Z', // Friday, GMT
      '2026-03-30T07:00:00.000Z', // Monday, BST
      '2026-03-31T07:00:00.000Z',
    ]);
  });

  it('keeps the wall-clock time across the autumn DST change', () => {
    // America/New_York leaves EDT on Sunday 2026-11-01.
    const runs = nextRuns('0 8 * * *', 'America/New_York', 3, new Date('2026-10-31T00:00:00Z'));
    expect(runs.map((d) => d.toISOString())).toEqual([
      '2026-10-31T12:00:00.000Z', // EDT
      '2026-11-01T13:00:00.000Z', // EST
      '2026-11-02T13:00:00.000Z',
    ]);
  });

  it('runs a time skipped by the spring change once, not never', () => {
    // 02:30 does not exist in New York on 2026-03-08.
    const runs = nextRuns('30 2 * * *', 'America/New_York', 3, new Date('2026-03-07T00:00:00Z'));
    expect(runs).toHaveLength(3);
    expect(runs[0]!.toISOString()).toBe('2026-03-07T07:30:00.000Z');
    // One run on the 8th, between the 7th's and the 9th's.
    expect(runs[1]!.getTime()).toBeGreaterThan(new Date('2026-03-08T05:00:00Z').getTime());
    expect(runs[1]!.getTime()).toBeLessThan(new Date('2026-03-09T00:00:00Z').getTime());
    expect(runs[2]!.toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('takes any whole number of minutes from 1 to 1440', () => {
    for (const minutes of [1, 7, 45, 90, 1440]) {
      expect(SchedulePresetSchema.safeParse({ kind: 'every_minutes', minutes }).success).toBe(true);
    }
    for (const minutes of [0, -5, 1441, 2.5]) {
      const parsed = SchedulePresetSchema.safeParse({ kind: 'every_minutes', minutes });
      expect(parsed.error?.issues[0]?.message).toBe('Use a whole number of minutes from 1 to 1440');
    }
  });

  it('runs an interval N minutes apart from its anchor, collapsing missed slots', () => {
    const anchor = new Date('2026-10-18T10:07:00Z');
    // The next slot after the anchor, and after a late tick.
    expect(nextIntervalRun(7, anchor, anchor).toISOString()).toBe('2026-10-18T10:14:00.000Z');
    expect(nextIntervalRun(7, new Date('2026-10-18T10:14:30Z'), anchor).toISOString()).toBe(
      '2026-10-18T10:21:00.000Z',
    );
    // Down for an hour: one slot on the same rhythm, not the missed ones.
    expect(nextIntervalRun(7, new Date('2026-10-18T11:10:00Z'), anchor).toISOString()).toBe(
      '2026-10-18T11:17:00.000Z',
    );
    // Without an anchor, one interval from the current minute.
    expect(nextIntervalRun(90, new Date('2026-10-18T10:07:42Z')).toISOString()).toBe(
      '2026-10-18T11:37:00.000Z',
    );
  });

  it('schedules an interval trigger from its slot, ignoring the timezone and an old cron', () => {
    const trigger = {
      type: 'schedule' as const,
      // Stored before intervals; the preset decides.
      cron: '*/15 * * * *',
      preset: { kind: 'every_minutes' as const, minutes: 25 },
    };
    const slot = new Date('2026-10-18T10:05:00Z');
    const now = new Date('2026-10-18T10:05:20Z');
    for (const tz of ['UTC', 'Asia/Tokyo']) {
      expect(triggerNextRunAt(trigger, tz, now, slot)?.toISOString()).toBe(
        '2026-10-18T10:30:00.000Z',
      );
    }
    // Across a DST change the interval stays 25 real minutes.
    const dst = new Date('2026-03-29T00:50:00Z');
    expect(triggerNextRunAt(trigger, 'Europe/London', dst, dst)?.toISOString()).toBe(
      '2026-03-29T01:15:00.000Z',
    );
    expect(() => triggerNextRunAt(trigger, 'Mars/Olympus', now)).toThrow(InvalidScheduleError);
    expect(
      triggerNextRunAt(
        { type: 'schedule', preset: { kind: 'daily', time: '08:00' } },
        'UTC',
        now,
        slot,
      )?.toISOString(),
    ).toBe('2026-10-19T08:00:00.000Z');
  });

  it('previews the next runs of any preset', () => {
    const after = new Date('2026-10-18T10:07:00Z');
    expect(
      presetNextRuns({ kind: 'every_minutes', minutes: 45 }, 'UTC', 2, after).map((d) =>
        d.toISOString(),
      ),
    ).toEqual(['2026-10-18T10:52:00.000Z', '2026-10-18T11:37:00.000Z']);
    expect(
      presetNextRuns({ kind: 'daily', time: '09:00' }, 'UTC', 1, after).map((d) => d.toISOString()),
    ).toEqual(['2026-10-19T09:00:00.000Z']);
  });

  it('runs a cron every N minutes on the clock', () => {
    const runs = nextRuns('*/15 * * * *', 'UTC', 2, new Date('2026-10-18T10:07:00Z'));
    expect(runs.map((d) => d.toISOString())).toEqual([
      '2026-10-18T10:15:00.000Z',
      '2026-10-18T10:30:00.000Z',
    ]);
  });

  it('runs on the last day of each month', () => {
    const runs = nextRuns('0 9 L * *', 'UTC', 2, new Date('2026-02-01T00:00:00Z'));
    expect(runs.map((d) => d.toISOString())).toEqual([
      '2026-02-28T09:00:00.000Z',
      '2026-03-31T09:00:00.000Z',
    ]);
  });

  it('refuses an unknown timezone', () => {
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(() => nextRunAt('0 8 * * *', 'Mars/Olympus')).toThrow(InvalidScheduleError);
  });
});

describe('describe', () => {
  it('puts presets in words', () => {
    expect(describePreset({ kind: 'weekdays', time: '08:00' })).toBe('Weekdays at 08:00');
    expect(describePreset({ kind: 'weekly', day: 1, time: '09:00' })).toBe('Every Monday at 09:00');
    expect(describePreset({ kind: 'monthly', date: 2, time: '09:00' })).toBe(
      'On the 2nd of every month at 09:00',
    );
    expect(describePreset({ kind: 'monthly', date: 11, time: '09:00' })).toBe(
      'On the 11th of every month at 09:00',
    );
    expect(describePreset({ kind: 'every_minutes', minutes: 120 })).toBe('Every 2 hours');
    expect(describePreset({ kind: 'every_minutes', minutes: 1 })).toBe('Every minute');
    expect(describePreset({ kind: 'every_minutes', minutes: 60 })).toBe('Every hour');
    expect(describePreset({ kind: 'every_minutes', minutes: 90 })).toBe('Every 90 minutes');
    expect(describePreset({ kind: 'every_minutes', minutes: 7 })).toBe('Every 7 minutes');
    expect(
      describeTrigger(
        { type: 'schedule', cron: '0 8 * * 1-5', preset: { kind: 'weekdays', time: '08:00' } },
        'Europe/London',
      ),
    ).toBe('Weekdays at 08:00 (Europe/London)');
    expect(describeTrigger({ type: 'event', source: 'github' })).toBe(
      'When a GitHub event arrives',
    );
  });
});
