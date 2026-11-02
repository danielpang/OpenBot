import { WEEKDAY_NAMES } from '@openbots/routines';
import { Input } from '@openbots/ui';
import type { ReactNode } from 'react';
import {
  INTERVAL_MINUTES_MAX,
  INTERVAL_MINUTES_MIN,
  previewDraft,
  SCHEDULE_KINDS,
  type ScheduleDraft,
  type ScheduleKind,
} from './schedule.js';

// The schedule presets as form fields (R1): a preset picker, then only the
// fields that preset needs, and a line saying when it next runs.

const selectClass = 'h-9 rounded-md border bg-transparent px-2 text-sm';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

export function ScheduleFields({
  value,
  onChange,
  timezone,
}: {
  value: ScheduleDraft;
  onChange(next: ScheduleDraft): void;
  timezone: string;
}) {
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...value, ...patch });
  const timed = ['daily', 'weekdays', 'weekly', 'monthly'].includes(value.kind);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Repeats">
          <select
            aria-label="Repeats"
            value={value.kind}
            onChange={(e) => set({ kind: e.target.value as ScheduleKind })}
            className={selectClass}
          >
            {SCHEDULE_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        {value.kind === 'weekly' && (
          <Field label="On">
            <select
              aria-label="Day"
              value={value.day}
              onChange={(e) => set({ day: Number(e.target.value) })}
              className={selectClass}
            >
              {WEEKDAY_NAMES.map((name, day) => (
                <option key={name} value={day}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {value.kind === 'monthly' && (
          <Field label="On day">
            <select
              aria-label="Date"
              value={value.date}
              onChange={(e) => set({ date: e.target.value })}
              className={selectClass}
            >
              {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
              <option value="last">Last day</option>
            </select>
          </Field>
        )}
        {timed && (
          <Field label="At">
            <Input
              type="time"
              aria-label="Time"
              value={value.time}
              onChange={(e) => set({ time: e.target.value })}
              className="w-32"
              required
            />
          </Field>
        )}
        {value.kind === 'every_minutes' && (
          <Field label={`Every (minutes, ${INTERVAL_MINUTES_MIN} to ${INTERVAL_MINUTES_MAX})`}>
            <Input
              type="number"
              aria-label="Interval in minutes"
              min={INTERVAL_MINUTES_MIN}
              max={INTERVAL_MINUTES_MAX}
              step={1}
              value={Number.isNaN(value.minutes) ? '' : value.minutes}
              onChange={(e) =>
                set({ minutes: e.target.value === '' ? Number.NaN : Number(e.target.value) })
              }
              className="w-28"
              required
            />
          </Field>
        )}
        {value.kind === 'custom' && (
          <Field label="Cron (minute hour day month weekday)">
            <Input
              aria-label="Cron"
              value={value.cron}
              onChange={(e) => set({ cron: e.target.value })}
              placeholder="0 8 * * 1-5"
              className="w-48 font-mono"
            />
          </Field>
        )}
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {previewDraft(value, timezone)}
      </p>
    </div>
  );
}
