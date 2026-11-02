import { Button, Input } from '@openbots/ui';
import { useMutation } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { createOrganization, reloadInto } from './api.js';

/** One field, the organization's name; the creator becomes its owner (plan 21.6). */
export function CreateOrganizationForm({ submitLabel = 'Create' }: { submitLabel?: string }) {
  const create = useMutation({
    mutationFn: createOrganization,
    onSuccess: () => reloadInto('/'),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    if (name) create.mutate(name);
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Name
        <Input name="name" required maxLength={80} placeholder="Acme" autoComplete="organization" />
      </label>
      {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
      <Button type="submit" disabled={create.isPending}>
        {submitLabel}
      </Button>
    </form>
  );
}
