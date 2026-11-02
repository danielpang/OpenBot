import { Button, Input } from '@openbots/ui';
import type { ReactNode } from 'react';
import {
  CONDITION_OPS,
  EVENT_SOURCES,
  eventFields,
  GITHUB_EVENTS,
  SLACK_EVENTS,
  type ConditionOp,
  type EventDraft,
  type EventSource,
} from './trigger.js';

// The event trigger as form fields (R2): the source, the one event it waits
// for, and only the narrowing fields that event reads. A webhook Routine
// narrows by conditions on the payload instead.

const selectClass = 'h-9 rounded-md border bg-transparent px-2 text-sm';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

const SOURCE_HELP: Record<EventSource, string> = {
  webhook: 'Starts when a POST to its endpoint matches every condition.',
  github: 'Add its endpoint as a JSON webhook on the repository.',
  slack: 'Point your Slack app’s Event Subscriptions at its endpoint.',
};

export function EventFields({
  value,
  onChange,
}: {
  value: EventDraft;
  onChange(next: EventDraft): void;
}) {
  const set = (patch: Partial<EventDraft>) => onChange({ ...value, ...patch });
  const fields = eventFields(value) as Record<string, boolean | undefined>;
  const text = (
    key: 'repo' | 'label' | 'text' | 'channel' | 'emoji' | 'pattern',
    label: string,
    placeholder: string,
  ) =>
    fields[key] && (
      <Field label={label}>
        <Input
          aria-label={label}
          value={value[key]}
          onChange={(e) => set({ [key]: e.target.value })}
          placeholder={placeholder}
          className="w-48"
        />
      </Field>
    );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Source">
          <select
            aria-label="Source"
            value={value.source}
            onChange={(e) => set({ source: e.target.value as EventSource })}
            className={selectClass}
          >
            {EVENT_SOURCES.map((s) => (
              <option key={s.source} value={s.source}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        {value.source === 'github' && (
          <Field label="Event">
            <select
              aria-label="Event"
              value={value.github}
              onChange={(e) => set({ github: e.target.value as EventDraft['github'] })}
              className={selectClass}
            >
              {GITHUB_EVENTS.map((g) => (
                <option key={g.event} value={g.event}>
                  {g.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {value.source === 'slack' && (
          <Field label="Event">
            <select
              aria-label="Event"
              value={value.slack}
              onChange={(e) => set({ slack: e.target.value as EventDraft['slack'] })}
              className={selectClass}
            >
              {SLACK_EVENTS.map((s) => (
                <option key={s.event} value={s.event}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {text('repo', 'Repository', 'owner/name or owner/*')}
        {text('label', 'Label', 'bug')}
        {text('channel', 'Channel ID', 'C0123456789')}
        {text('emoji', 'Emoji', 'eyes')}
        {text('pattern', 'Channel name', 'proj-*')}
        {text('text', 'Text contains', 'deploy')}
      </div>
      {value.source === 'webhook' && (
        <Conditions value={value.conditions} onChange={(conditions) => set({ conditions })} />
      )}
      <p className="text-xs text-muted-foreground">{SOURCE_HELP[value.source]}</p>
    </div>
  );
}

function Conditions({
  value,
  onChange,
}: {
  value: EventDraft['conditions'];
  onChange(next: EventDraft['conditions']): void;
}) {
  const update = (i: number, patch: Partial<EventDraft['conditions'][number]>) =>
    onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="flex flex-col gap-1.5">
      {value.map((condition, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2" data-condition={i}>
          <Input
            aria-label="Field path"
            value={condition.path}
            onChange={(e) => update(i, { path: e.target.value })}
            placeholder="data.object.status"
            className="w-48 font-mono"
          />
          <select
            aria-label="Operator"
            value={condition.op}
            onChange={(e) => update(i, { op: e.target.value as ConditionOp })}
            className={selectClass}
          >
            {CONDITION_OPS.map((o) => (
              <option key={o.op} value={o.op}>
                {o.label}
              </option>
            ))}
          </select>
          <Input
            aria-label="Value"
            value={condition.value}
            onChange={(e) => update(i, { value: e.target.value })}
            className="w-40"
          />
          <button
            type="button"
            className="text-xs text-muted-foreground hover:underline"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      {value.length < 10 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => onChange([...value, { path: '', op: 'equals', value: '' }])}
        >
          Add condition
        </Button>
      )}
    </div>
  );
}
