import { unwrap } from '@openbots/api-client';
import { IconButton, Input, PlusIcon, TrashIcon } from '@openbots/ui';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { api } from '../../app/api.js';

// API keys (U4) for programmatic access to the same API the apps use.

const apiKeysQuery = queryOptions({
  queryKey: ['api-keys'],
  queryFn: () => unwrap(api.GET('/api/v1/api-keys')),
});

export function ApiKeys() {
  const queryClient = useQueryClient();
  const { data } = useQuery(apiKeysQuery);
  const refresh = () => queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
  const create = useMutation({
    mutationFn: (name: string) => unwrap(api.POST('/api/v1/api-keys', { body: { name } })),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/api/v1/api-keys/{id}', { params: { path: { id } } })),
    onSuccess: refresh,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    create.mutate(String(new FormData(form).get('name')), { onSuccess: () => form.reset() });
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">API keys</h2>
      <form className="flex gap-2" onSubmit={submit}>
        <Input
          name="name"
          placeholder="Name a new key"
          maxLength={32}
          required
          aria-label="Key name"
        />
        <IconButton label="Create" type="submit" variant="default" busy={create.isPending}>
          <PlusIcon />
        </IconButton>
      </form>
      {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
      {create.data && (
        <div className="flex flex-col gap-1.5 rounded-md border p-3 text-sm">
          <p>Copy this key now. It is shown only once.</p>
          <Input readOnly value={create.data.key} onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
      <ul className="divide-y rounded-md border">
        {data?.items.map((key) => (
          <li key={key.id} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
            <span>
              {key.name} <span className="font-mono text-muted-foreground">{key.start}…</span>
            </span>
            <IconButton
              label={`Revoke ${key.name}`}
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(key.id)}
            >
              <TrashIcon />
            </IconButton>
          </li>
        ))}
        {data && !data.items.length && (
          <li className="px-3 py-2 text-sm text-muted-foreground">No API keys.</li>
        )}
      </ul>
    </section>
  );
}
