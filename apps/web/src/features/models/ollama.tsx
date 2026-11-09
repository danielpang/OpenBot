import { Button, cn, IconButton, Input, PencilIcon } from '@openbots/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useLocalAuth } from '../../app/deployment.js';
import {
  createProvider,
  discoverModels,
  providersQuery,
  updateProvider,
  type Provider,
  type ProviderPreset,
} from './api.js';
import { ErrorText } from './error-text.js';

// Ollama, the built-in for models on the owner's own machine. It has no key
// and no SDK: it is an address, and its models come from Discover. The Mac
// app runs the server in Docker, where `localhost` is the container, so there
// the address starts at the host instead.

const DOCKER_HOST_URL = 'http://host.docker.internal:11434/v1';

type Scope = 'organization' | 'account';

/** Ollama before it is set up: its address and Connect, which also discovers its models. */
export function OllamaSetup({
  preset,
  canEdit,
  allowLocal,
  scope,
}: {
  preset: ProviderPreset;
  canEdit: boolean;
  allowLocal: boolean;
  scope?: Scope;
}) {
  const queryClient = useQueryClient();
  const localAuth = useLocalAuth();
  const [baseUrl, setBaseUrl] = useState(
    localAuth ? DOCKER_HOST_URL : (preset.baseUrl ?? DOCKER_HOST_URL),
  );
  const connect = useMutation({
    mutationFn: async () => {
      const created = await createProvider({
        presetId: preset.id,
        baseUrl: baseUrl.trim(),
        local: allowLocal,
        ...(scope ? { scope } : {}),
      });
      // A first list of models, so the card is useful at once. Ollama being
      // down is not a reason to undo the setup: the card offers Discover again.
      await discoverModels(created.id).catch(() => undefined);
      return created;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: providersQuery.queryKey }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (baseUrl.trim()) connect.mutate();
  }

  return (
    <article className="flex flex-col gap-3 rounded-lg border bg-card p-4" aria-label={preset.name}>
      <div className="flex flex-col gap-0.5">
        <h3 className="font-medium">{preset.name}</h3>
        <p className="text-xs text-muted-foreground">
          Models running on your own machine. No API key needed.
        </p>
      </div>
      {canEdit && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
          <Input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.currentTarget.value)}
            aria-label="Ollama address"
            className="h-8 max-w-sm flex-1 font-mono text-xs"
            required
          />
          <Button type="submit" size="sm" disabled={connect.isPending}>
            {connect.isPending ? 'Connecting…' : 'Connect'}
          </Button>
        </form>
      )}
      {canEdit && localAuth && (
        <p className="text-xs text-muted-foreground">
          OpenBots runs in Docker on this Mac, so host.docker.internal reaches Ollama on the Mac.
        </p>
      )}
      <ErrorText error={connect.error} />
    </article>
  );
}

/** The address row of an endpoint card: shown always, editable by admins. */
export function BaseUrlField({ provider, canEdit }: { provider: Provider; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(provider.baseUrl ?? '');
  const save = useMutation({
    mutationFn: () => updateProvider(provider.id, { baseUrl: value.trim() }),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: providersQuery.queryKey });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim()) save.mutate();
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">Address</span>
          <span className="truncate font-mono text-xs text-muted-foreground" data-base-url>
            {provider.baseUrl}
          </span>
        </div>
        {canEdit && (
          <IconButton
            label="Change address"
            onClick={() => {
              setValue(provider.baseUrl ?? '');
              setEditing(true);
            }}
          >
            <PencilIcon />
          </IconButton>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-foreground">Address</span>
      <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
        <Input
          type="url"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.currentTarget.value)}
          aria-label="Address"
          className={cn('h-8 max-w-sm flex-1 font-mono text-xs')}
          required
        />
        <Button type="submit" size="sm" disabled={save.isPending}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </form>
      <ErrorText error={save.error} />
    </div>
  );
}
