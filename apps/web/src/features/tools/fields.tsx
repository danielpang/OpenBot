import { IconButton, Input, RotateIcon, TrashIcon } from '@openbots/ui';
import type { ReactNode } from 'react';

// Small form pieces the Connectors page shares. Secret inputs are write-only (P3):
// they start empty, say whether a value is stored, and never hold one.

export interface SecretField {
  name: string;
  label: string | null;
  description?: string | null;
  required: boolean;
  /** Whether a value is stored; absent while adding. */
  set?: boolean;
}

export function SecretInputs({
  secrets,
  values,
  onChange,
  removed = [],
  onToggleRemove,
}: {
  secrets: readonly SecretField[];
  values: Record<string, string>;
  onChange(values: Record<string, string>): void;
  removed?: readonly string[];
  onToggleRemove?(name: string): void;
}) {
  return secrets.map((secret) => {
    const removing = removed.includes(secret.name);
    const state =
      secret.set === undefined
        ? secret.required
          ? 'required'
          : 'optional'
        : removing
          ? 'will be removed'
          : secret.set
            ? 'set'
            : 'not set';
    return (
      <Labelled
        key={secret.name}
        label={secret.label ?? secret.name}
        note={state}
        help={secret.description}
      >
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="new-password"
            name={`secret:${secret.name}`}
            aria-label={secret.label ?? secret.name}
            value={values[secret.name] ?? ''}
            onChange={(e) => onChange({ ...values, [secret.name]: e.target.value })}
            placeholder={secret.set ? 'Enter a new value to replace it' : ''}
            disabled={removing}
          />
          {secret.set && !secret.required && onToggleRemove && (
            <IconButton
              label={removing ? 'Keep' : 'Remove'}
              aria-pressed={removing}
              onClick={() => onToggleRemove(secret.name)}
            >
              {removing ? <RotateIcon /> : <TrashIcon />}
            </IconButton>
          )}
        </div>
      </Labelled>
    );
  });
}

export function Labelled({
  label,
  note,
  help,
  children,
}: {
  label: string;
  note?: string;
  help?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>
        <span className="font-medium">{label}</span>
        {note && <span className="ml-2 text-xs text-muted-foreground">{note}</span>}
      </span>
      {children}
      {help && <span className="text-xs text-muted-foreground">{help}</span>}
    </label>
  );
}

export function ErrorText({ error }: { error: Error | string | null | undefined }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {typeof error === 'string' ? error : error.message}
    </p>
  );
}
