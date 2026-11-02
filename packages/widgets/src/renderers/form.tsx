import { Button, Input } from '@openbots/ui';
import { useId, useState, type FormEvent } from 'react';
import type { FormField, FormProps, FormState, FormValues } from '../kinds/form.js';
import type { WidgetRendererProps } from './types.js';

// A form from the Bot (W1, W2): its fields and a Submit. Submit posts
// `{type: 'submit', values}`; once submitted (from the post, `widget.updated`
// or the stored state on a reload) the fields show the submitted values,
// disabled.

type Draft = Record<string, string | boolean>;

function draftOf(fields: FormField[], values?: FormValues): Draft {
  return Object.fromEntries(
    fields.map((f) => {
      const value = values ? values[f.name] : f.default;
      if (f.type === 'checkbox') return [f.name, value === true];
      return [f.name, value === undefined || typeof value === 'boolean' ? '' : String(value)];
    }),
  );
}

/** The draft as action values: numbers as numbers, empty fields left out. */
export function formValues(fields: FormField[], draft: Draft): FormValues {
  const values: FormValues = {};
  for (const f of fields) {
    const value = draft[f.name];
    if (f.type === 'checkbox') values[f.name] = value === true;
    else if (typeof value === 'string' && value.trim()) {
      values[f.name] = f.type === 'number' ? Number(value) : value;
    }
  }
  return values;
}

export function FormWidget({ props, state, onAction }: WidgetRendererProps<FormProps, FormState>) {
  const id = useId();
  const [local, setLocal] = useState<FormState | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => draftOf(props.fields));

  const current = state?.status === 'submitted' ? state : (local ?? state);
  const submitted = current?.status === 'submitted';
  const shown = submitted ? draftOf(props.fields, current.values ?? {}) : draft;
  const disabled = submitted || busy || !onAction;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!onAction) return;
    const values = formValues(props.fields, draft);
    setBusy(true);
    setError(null);
    try {
      const next = (await onAction({ type: 'submit', values })) as FormState | undefined;
      setLocal(next?.status === 'submitted' ? next : { status: 'submitted', values });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not submit the form');
    } finally {
      setBusy(false);
    }
  }

  const set = (name: string, value: string | boolean) => setDraft((d) => ({ ...d, [name]: value }));
  const control = 'w-full rounded-md border bg-transparent px-3 py-1.5 text-sm disabled:opacity-70';

  return (
    <form
      className="flex max-w-lg flex-col gap-3 rounded-lg border bg-card p-3 text-sm"
      data-widget="form"
      data-status={current?.status ?? 'open'}
      onSubmit={(e) => void submit(e)}
    >
      {(props.title || props.description) && (
        <div className="flex flex-col gap-0.5">
          {props.title && <h3 className="font-medium">{props.title}</h3>}
          {props.description && (
            <p className="whitespace-pre-wrap text-muted-foreground">{props.description}</p>
          )}
        </div>
      )}
      {props.fields.map((f) => {
        const fieldId = `${id}-${f.name}`;
        const value = shown[f.name];
        if (f.type === 'checkbox') {
          return (
            <label key={f.name} htmlFor={fieldId} className="flex items-center gap-2">
              <input
                id={fieldId}
                name={f.name}
                type="checkbox"
                checked={value === true}
                onChange={(e) => set(f.name, e.target.checked)}
                disabled={disabled}
                required={f.required}
                className="size-4"
              />
              {f.label}
            </label>
          );
        }
        const text = typeof value === 'string' ? value : '';
        return (
          <div key={f.name} className="flex flex-col gap-1">
            <label htmlFor={fieldId} className="text-xs text-muted-foreground">
              {f.label}
              {f.required && <span aria-hidden> *</span>}
            </label>
            {f.type === 'textarea' ? (
              <textarea
                id={fieldId}
                name={f.name}
                value={text}
                onChange={(e) => set(f.name, e.target.value)}
                placeholder={f.placeholder}
                rows={4}
                disabled={disabled}
                required={f.required}
                className={control}
              />
            ) : f.type === 'select' ? (
              <select
                id={fieldId}
                name={f.name}
                value={text}
                onChange={(e) => set(f.name, e.target.value)}
                disabled={disabled}
                required={f.required}
                className={control}
              >
                <option value="">{f.placeholder ?? 'Choose…'}</option>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={fieldId}
                name={f.name}
                type={f.type}
                value={text}
                onChange={(e) => set(f.name, e.target.value)}
                placeholder={f.placeholder}
                disabled={disabled}
                required={f.required}
                className="h-8 text-sm"
              />
            )}
          </div>
        );
      })}
      <div className="flex items-center gap-3">
        {!submitted && (
          <Button type="submit" size="sm" disabled={disabled}>
            {props.submit_label ?? 'Submit'}
          </Button>
        )}
        {submitted && (
          <p role="status" className="text-xs text-muted-foreground">
            Submitted
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
