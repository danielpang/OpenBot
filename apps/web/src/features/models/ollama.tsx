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

// Ollama, the built-in for open models. It runs two ways: on the owner's own
// machine (an address, no key) or as Ollama Cloud (a fixed address and an API
// key). Both speak the OpenAI chat API under `/v1`, and both find their
// models with Discover. The Mac app runs the server in Docker, where
// `localhost` is the container, so there a local address starts at the host.

const DOCKER_HOST_URL = 'http://host.docker.internal:11434/v1';
export const OLLAMA_CLOUD_URL = 'https://ollama.com/v1';
const CLOUD_KEYS_URL = 'https://ollama.com/settings/keys';

type Scope = 'organization' | 'account';
export type OllamaMode = 'local' | 'cloud';

/** Whether an Ollama provider is Ollama Cloud rather than a server of the owner's. */
export function isOllamaCloud(provider: Pick<Provider, 'baseUrl'>): boolean {
  try {
    return new URL(provider.baseUrl ?? '').hostname === 'ollama.com';
  } catch {
    return false;
  }
}

const MODES: { mode: OllamaMode; label: string; add: string }[] = [
  { mode: 'local', label: 'On my machine', add: 'Add Ollama on your machine' },
  { mode: 'cloud', label: 'Ollama Cloud', add: 'Add Ollama Cloud' },
];

/**
 * Sets up Ollama: on the owner's machine by address, or Ollama Cloud by key.
 * Connect also discovers the models. `available` leaves out a way already set
 * up, so a second card only offers the other.
 */
export function OllamaSetup({
  preset,
  canEdit,
  allowLocal,
  scope,
  available = ['local', 'cloud'],
}: {
  preset: ProviderPreset;
  canEdit: boolean;
  allowLocal: boolean;
  scope?: Scope;
  available?: OllamaMode[];
}) {
  const queryClient = useQueryClient();
  const localAuth = useLocalAuth();
  const modes = MODES.filter((m) => available.includes(m.mode));
  const [mode, setMode] = useState<OllamaMode>(modes[0]?.mode ?? 'local');
  const [baseUrl, setBaseUrl] = useState(
    localAuth ? DOCKER_HOST_URL : (preset.baseUrl ?? DOCKER_HOST_URL),
  );
  const [apiKey, setApiKey] = useState('');
  const connect = useMutation({
    mutationFn: async () => {
      const created = await createProvider(
        mode === 'cloud'
          ? {
              presetId: preset.id,
              name: 'Ollama Cloud',
              baseUrl: OLLAMA_CLOUD_URL,
              apiKey: apiKey.trim(),
              ...(scope ? { scope } : {}),
            }
          : {
              presetId: preset.id,
              baseUrl: baseUrl.trim(),
              local: allowLocal,
              ...(scope ? { scope } : {}),
            },
      );
      // A first list of models, so the card is useful at once. Ollama being
      // unreachable is not a reason to undo the setup: the card offers Discover again.
      await discoverModels(created.id).catch(() => undefined);
      return created;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: providersQuery.queryKey }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === 'cloud' ? apiKey.trim() : baseUrl.trim()) connect.mutate();
  }

  if (!modes.length) return null;
  const adding = available.length < MODES.length;
  return (
    <article
      className="flex flex-col gap-3 rounded-lg border bg-card p-4"
      aria-label={adding ? modes[0]!.add : preset.name}
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="font-medium">{adding ? modes[0]!.add : preset.name}</h3>
        <p className="text-xs text-muted-foreground">
          {mode === 'cloud'
            ? 'Larger open models hosted by Ollama, with an Ollama API key.'
            : 'Models running on your own machine. No API key needed.'}
        </p>
      </div>
      {canEdit && modes.length > 1 && (
        <div
          role="radiogroup"
          aria-label="Where Ollama runs"
          className="flex gap-1 self-start rounded-md bg-muted p-0.5"
        >
          {modes.map((m) => (
            <button
              key={m.mode}
              type="button"
              role="radio"
              aria-checked={mode === m.mode}
              onClick={() => setMode(m.mode)}
              className={cn(
                'rounded px-3 py-1 text-xs font-medium text-muted-foreground transition-colors',
                mode === m.mode && 'bg-background text-foreground shadow-sm',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
      {canEdit && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
          {mode === 'cloud' ? (
            <Input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.currentTarget.value)}
              placeholder="Paste an Ollama API key"
              aria-label="Ollama API key"
              className="h-8 max-w-sm flex-1"
              required
            />
          ) : (
            <Input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.currentTarget.value)}
              aria-label="Ollama address"
              className="h-8 max-w-sm flex-1 font-mono text-xs"
              required
            />
          )}
          <Button type="submit" size="sm" disabled={connect.isPending}>
            {connect.isPending ? 'Connecting…' : 'Connect'}
          </Button>
        </form>
      )}
      {canEdit && mode === 'cloud' && (
        <p className="text-xs text-muted-foreground">
          Create a key at{' '}
          <a
            href={CLOUD_KEYS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground underline underline-offset-4"
          >
            ollama.com/settings/keys
          </a>
          .
        </p>
      )}
      {canEdit && mode === 'local' && localAuth && (
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
