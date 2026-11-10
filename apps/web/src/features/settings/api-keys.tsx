import { unwrap } from '@openbots/api-client';
import { Button, IconButton, Input, PlusIcon, TrashIcon } from '@openbots/ui';
import { SettingsSection } from '../../app/settings-layout.js';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../app/api.js';

// API keys (U4) for programmatic access to the same API the apps use.

const apiKeysQuery = queryOptions({
  queryKey: ['api-keys'],
  queryFn: () => unwrap(api.GET('/api/v1/api-keys')),
});

export function ApiKeys() {
  const queryClient = useQueryClient();
  const { data } = useQuery(apiKeysQuery);
  const [adding, setAdding] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
  const create = useMutation({
    mutationFn: (name: string) => unwrap(api.POST('/api/v1/api-keys', { body: { name } })),
    onSuccess: () => {
      setAdding(false);
      return refresh();
    },
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
    <SettingsSection
      title="API keys"
      description="For scripts that call the same API the apps use."
      action={
        <IconButton
          label="New API key"
          aria-pressed={adding}
          onClick={() => setAdding((on) => !on)}
        >
          <PlusIcon />
        </IconButton>
      }
    >
      {adding && (
        <form className="flex gap-2" onSubmit={submit}>
          <Input
            name="name"
            placeholder="Name the key"
            maxLength={32}
            required
            autoFocus
            aria-label="Key name"
          />
          <Button type="submit" disabled={create.isPending}>
            Create
          </Button>
        </form>
      )}
      {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
      {create.data && (
        <div className="flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-sm text-foreground">
          <p>Copy this key now. It is shown only once.</p>
          <Input readOnly value={create.data.key} onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
      <ul className="divide-y rounded-lg border bg-card">
        {data?.items.map((key) => (
          <li
            key={key.id}
            className="flex items-center justify-between gap-4 py-1.5 pr-2 pl-4 text-sm"
          >
            <span className="min-w-0 truncate text-foreground">
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
          <li className="px-4 py-3 text-sm text-muted-foreground">No API keys.</li>
        )}
      </ul>
    </SettingsSection>
  );
}
