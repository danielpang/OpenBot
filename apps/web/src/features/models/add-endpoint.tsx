import { Button, Input, Select, Switch, Textarea } from '@openbots/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  createProvider,
  discoverModels,
  providersQuery,
  type CreateProvider,
  type Provider,
  type ProviderPreset,
} from './api.js';
import { ErrorText } from './error-text.js';
import { GENERIC_PRESETS, parseHeaders, parseModelIds } from './format.js';

// "Add custom model provider" (L2, L3). A preset fills in name, base URL, protocol
// and known models; "None" leaves them to the admin. Discover needs the
// endpoint to exist, so "Add and discover" creates it first. A base URL on a
// private or local address needs "Runs on my network" ticked (S-12); presets
// for local servers tick it.

type Protocol = 'openai_compatible' | 'anthropic_compatible';

const field = 'flex flex-col gap-1.5 text-sm font-medium';

/** The POST body for the form; throws when the headers do not parse. */
export function endpointBody(
  preset: ProviderPreset | undefined,
  form: {
    name: string;
    baseUrl: string;
    protocol: Protocol;
    apiKey: string;
    headers: string;
    models: string;
    local: boolean;
  },
): CreateProvider {
  const headers = parseHeaders(form.headers);
  const body: CreateProvider = {
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    models: parseModelIds(form.models).map((modelId) => ({ modelId })),
  };
  if (preset) body.presetId = preset.id;
  else {
    body.kind = 'custom';
    body.protocol = form.protocol;
    body.discovery = form.protocol === 'openai_compatible' ? 'list_models' : 'manual';
  }
  if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
  if (Object.keys(headers).length) body.headers = headers;
  if (form.local) body.local = true;
  return body;
}

/** Whether a preset's base URL points at this machine, as local-server presets do. */
export function isLoopbackUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function AddEndpoint({
  presets,
  onAdded,
  scope,
  allowLocal = true,
}: {
  presets: ProviderPreset[];
  onAdded: (provider: Provider, discoverError?: Error) => void;
  /** On the managed service: the organization's provider, or the caller's own (L6). */
  scope?: CreateProvider['scope'];
  /** Whether "Runs on my network" is offered; never where the install keeps it off (S-8). */
  allowLocal?: boolean;
}) {
  const queryClient = useQueryClient();
  const choices = presets.filter((p) => p.kind === 'custom' && !GENERIC_PRESETS.includes(p.id));
  const [presetId, setPresetId] = useState('');
  const preset = choices.find((p) => p.id === presetId);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('openai_compatible');
  const [local, setLocal] = useState(false);
  const discovers = preset ? preset.discovery === 'list_models' : protocol === 'openai_compatible';

  const add = useMutation({
    mutationFn: async ({ body, discover }: { body: CreateProvider; discover: boolean }) => {
      const provider = await createProvider(body);
      // A failed discovery still leaves the endpoint added; its card can retry.
      const discoverError = discover
        ? await discoverModels(provider.id).then(
            () => undefined,
            (error: Error) => error,
          )
        : undefined;
      return { provider, discoverError };
    },
    onSuccess: async ({ provider, discoverError }) => {
      await queryClient.invalidateQueries({ queryKey: providersQuery.queryKey });
      onAdded(provider, discoverError);
    },
  });
  const [formError, setFormError] = useState<Error | null>(null);

  function choose(id: string) {
    setPresetId(id);
    const next = choices.find((p) => p.id === id);
    setName(next?.name ?? '');
    setBaseUrl(next?.baseUrl ?? '');
    setLocal(allowLocal && isLoopbackUrl(next?.baseUrl));
    if (next && next.protocol !== 'native') setProtocol(next.protocol);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    try {
      const body = endpointBody(preset, {
        name,
        baseUrl,
        protocol,
        apiKey: String(data.get('apiKey') ?? ''),
        headers: String(data.get('headers') ?? ''),
        models: String(data.get('models') ?? ''),
        local,
      });
      if (scope) body.scope = scope;
      setFormError(null);
      add.mutate({ body, discover: submitter?.getAttribute('value') === 'discover' });
    } catch (error) {
      setFormError(error as Error);
    }
  }

  return (
    <form className="flex flex-col gap-4 rounded-md border p-4" onSubmit={submit}>
      <h3 className="font-medium">Add custom model provider</h3>
      <label className={field}>
        Preset
        <Select value={presetId} onChange={(e) => choose(e.currentTarget.value)}>
          <option value="">None</option>
          {choices.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </label>
      {preset?.notes && <p className="text-sm text-muted-foreground">{preset.notes}</p>}
      <label className={field}>
        Name
        <Input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          required
          maxLength={80}
        />
      </label>
      <label className={field}>
        Base URL
        <Input
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.currentTarget.value)}
          placeholder="https://example.com/v1"
          required
        />
      </label>
      {allowLocal && (
        <label className="flex items-center justify-between gap-4 text-sm">
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">Runs on my network</span>
            <span className="text-muted-foreground">
              For a server on this machine or your LAN, such as Ollama.
            </span>
          </span>
          <Switch
            name="local"
            checked={local}
            onChange={(e) => setLocal(e.currentTarget.checked)}
          />
        </label>
      )}
      <label className={field}>
        Protocol
        <Select
          value={protocol}
          disabled={!!preset}
          onChange={(e) => setProtocol(e.currentTarget.value as Protocol)}
        >
          <option value="openai_compatible">OpenAI chat completions</option>
          <option value="anthropic_compatible">Anthropic Messages</option>
        </Select>
      </label>
      <label className={field}>
        API key {preset?.keyRequired ? '' : '(optional)'}
        <Input name="apiKey" type="password" autoComplete="off" required={preset?.keyRequired} />
      </label>
      <label className={field}>
        Extra headers (optional, one &quot;Name: value&quot; per line)
        <Textarea name="headers" rows={2} className="font-mono" />
      </label>
      <label className={field}>
        Models (one id per line)
        <Textarea
          name="models"
          rows={3}
          placeholder={discovers ? 'Leave empty to discover them' : 'model-id'}
          className="font-mono"
        />
        {preset && preset.models.length > 0 && (
          <span className="font-normal text-muted-foreground">
            Includes {preset.models.map((m) => m.displayName).join(', ')}.
          </span>
        )}
      </label>
      <ErrorText error={formError ?? add.error} />
      <div className="flex gap-2">
        <Button type="submit" value="add" disabled={add.isPending}>
          Add provider
        </Button>
        {discovers && (
          <Button type="submit" value="discover" variant="outline" disabled={add.isPending}>
            Add and discover models
          </Button>
        )}
      </div>
    </form>
  );
}
