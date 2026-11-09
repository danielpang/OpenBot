import { Button, Input, Textarea } from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useManaged } from '../../app/deployment.js';
import { catalogQuery, createConnector, discoverQuery, importConnectors } from './api.js';
import { ConnectStatus, OAuthAdvanced, defaultCallbackUrl } from './catalog.js';
import { ErrorText, Labelled } from './fields.js';
import {
  IMPORT_STDIO_NOTE,
  STDIO_NOTES,
  STDIO_OFF_SELF_HOSTED,
  customConnectorBody,
  oauthClientBody,
  parseImport,
  type CustomServerInput,
  type StdioAvailability,
} from './forms.js';
import { useConnectorsAdded } from './hooks.js';
import { needsClient, useOAuthConnect } from './oauth.js';

// Any MCP server (T2): a Streamable HTTP URL, a stdio command (admins, once
// it is on, S-1), and pasted `mcpServers` JSON. For a URL the owner pastes it
// and clicks Connect: the server checks how it signs in. One that needs
// nothing is added; one with OAuth whose authorization server registers
// OpenBots itself signs in at once; one that cannot register asks for the
// owner's own OAuth app under Advanced, with the callback URL to register;
// one that refuses without OAuth asks for a token. A paste imports what the
// owner may add and lists each refused server with the reason.

const EMPTY: CustomServerInput = {
  name: '',
  transport: 'http',
  command: '',
  env: '',
  url: '',
  auth: 'none',
  token: '',
};

/** A URL worth asking the server about. */
const checkable = (url: string) => /^https?:\/\/[^/\s]+/i.test(url.trim());

export function CustomServerForm({ stdio }: { stdio: StdioAvailability }) {
  const [transport, setTransport] = useState<'http' | 'stdio'>('http');
  const managed = useManaged();
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div role="radiogroup" aria-label="Transport" className="flex gap-4">
        {(
          [
            ['stdio', 'Command (stdio)'],
            ['http', 'URL (Streamable HTTP)'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-1.5">
            <input
              type="radio"
              name="transport"
              checked={transport === value}
              disabled={value === 'stdio' && stdio !== 'on'}
              onChange={() => setTransport(value)}
            />
            {label}
          </label>
        ))}
      </div>
      {stdio !== 'on' && (
        <p className="text-xs text-muted-foreground">
          {stdio === 'off' && !managed ? STDIO_OFF_SELF_HOSTED : STDIO_NOTES[stdio]}
        </p>
      )}
      {transport === 'http' ? <UrlServerForm /> : <StdioServerForm />}
    </div>
  );
}

function UrlServerForm() {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [checked, setChecked] = useState('');
  const [token, setToken] = useState('');
  const [client, setClient] = useState({ clientId: '', clientSecret: '' });
  const [error, setError] = useState<string | null>(null);
  const { state, connect } = useOAuthConnect();
  const catalog = useQuery(catalogQuery);

  // Asks the server once the owner stops typing, so Connect already knows what it needs.
  useEffect(() => {
    const next = url.trim();
    const timer = setTimeout(() => setChecked(checkable(next) ? next : ''), 400);
    return () => clearTimeout(timer);
  }, [url]);
  const discovery = useQuery({ ...discoverQuery(checked), enabled: checked !== '' });
  const found = checked === url.trim() ? discovery.data : undefined;
  const needsOwnClient =
    (found?.auth === 'oauth' && !found.dynamicRegistration) ||
    (state.phase === 'idle' && needsClient(state.error));
  const needsToken = found?.auth === 'bearer';

  function submit(event: FormEvent) {
    event.preventDefault();
    const target = url.trim();
    if (!target) {
      setError('Enter the server URL');
      return;
    }
    setError(null);
    const oauthClient = oauthClientBody(client);
    if (needsToken) {
      if (!token.trim()) {
        setError('Enter the access token');
        return;
      }
      connect(
        () =>
          createConnector(customConnectorBody({ ...EMPTY, url: target, auth: 'bearer', token })),
        { prefetch: false },
      );
      return;
    }
    if (needsOwnClient && !oauthClient) {
      setError('Add your OAuth client under Advanced.');
      return;
    }
    // A sign-in window opens now unless the server is known to need none.
    const signsIn = !found || found.auth === 'oauth';
    connect(
      async () => {
        const how = found ?? (await queryClient.fetchQuery(discoverQuery(target)));
        if (how.auth === 'bearer') throw new Error('This server needs an access token.');
        if (how.auth === 'oauth' && !how.dynamicRegistration && !oauthClient) {
          throw new Error('Add your OAuth client under Advanced.');
        }
        return createConnector({
          transport: 'http',
          url: target,
          auth: how.auth === 'oauth' ? 'oauth' : 'none',
          ...(how.auth === 'oauth' && oauthClient ? { oauthClient } : {}),
        });
      },
      { prefetch: signsIn },
    );
  }

  // A new URL starts the form over once its connector is in the list.
  useEffect(() => {
    if (state.phase === 'waiting' || (state.phase === 'idle' && state.connectedId)) {
      setUrl('');
      setToken('');
      setClient({ clientId: '', clientSecret: '' });
    }
  }, [state]);

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} aria-label="Custom MCP server">
      <Labelled label="URL">
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/mcp"
          required
        />
      </Labelled>
      {needsToken && (
        <Labelled label="Access token" help="This server needs a token to sign in.">
          <Input
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
        </Labelled>
      )}
      {needsOwnClient && (
        <OAuthAdvanced
          name="This server"
          callbackUrl={
            found?.oauthCallbackUrl ?? catalog.data?.oauthCallbackUrl ?? defaultCallbackUrl()
          }
          value={client}
          onChange={setClient}
          open
          why="This server cannot register OpenBots by itself. Create an OAuth app with this callback URL, then add its client here."
        />
      )}
      <ConnectStatus state={state} />
      <ErrorText
        error={error ?? (state.phase === 'idle' && !needsClient(state.error) ? state.error : null)}
      />
      <div>
        <Button type="submit" size="sm" disabled={state.phase === 'working'}>
          Connect
        </Button>
      </div>
    </form>
  );
}

function StdioServerForm() {
  const empty: CustomServerInput = { ...EMPTY, transport: 'stdio' };
  const [input, setInput] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const onAdded = useConnectorsAdded();
  const create = useMutation({
    mutationFn: createConnector,
    onSuccess: async (connector) => {
      setInput(empty);
      await onAdded([connector]);
    },
  });
  const set = (change: Partial<CustomServerInput>) => setInput({ ...input, ...change });

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const body = customConnectorBody(input);
      setError(null);
      create.mutate(body);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} aria-label="Custom stdio server">
      <Labelled label="Name" note="optional">
        <Input value={input.name} onChange={(e) => set({ name: e.target.value })} maxLength={64} />
      </Labelled>
      <Labelled label="Command" help="The command and its arguments, e.g. npx -y my-mcp-server">
        <Input
          value={input.command}
          onChange={(e) => set({ command: e.target.value })}
          className="font-mono"
          required
        />
      </Labelled>
      <Labelled
        label="Environment"
        note="optional"
        help="KEY=value, one per line. Stored as secrets."
      >
        <Textarea
          value={input.env}
          onChange={(e) => set({ env: e.target.value })}
          rows={3}
          className="font-mono"
        />
      </Labelled>
      <ErrorText error={error ?? create.error} />
      <div>
        <Button type="submit" size="sm" disabled={create.isPending}>
          Add server
        </Button>
      </div>
    </form>
  );
}

export function ImportForm({ stdio = 'on' }: { stdio?: StdioAvailability }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const onAdded = useConnectorsAdded();
  const run = useMutation({
    mutationFn: importConnectors,
    onSuccess: async (result) => {
      if (!result.errors.length) setText('');
      await onAdded(result.items);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const servers = parseImport(text);
      setError(null);
      run.mutate(servers);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <form className="flex flex-col gap-3 text-sm" onSubmit={submit} aria-label="Import JSON">
      <Labelled
        label="mcpServers JSON"
        help='Paste a config like {"mcpServers": {"name": {"command": "npx", "args": [...]}}}.'
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          className="font-mono text-xs"
          required
        />
      </Labelled>
      {stdio !== 'on' && <p className="text-xs text-muted-foreground">{IMPORT_STDIO_NOTE}</p>}
      <ErrorText error={error ?? run.error} />
      {run.data && (
        <div role="status" className="flex flex-col gap-0.5 text-xs">
          <span>
            {run.data.items.length === 1
              ? 'Imported 1 server.'
              : `Imported ${run.data.items.length} servers.`}
          </span>
          {run.data.errors.length > 0 && <span>Not imported:</span>}
          {run.data.errors.map((e) => (
            <span key={e.name} className="text-destructive">
              {e.name}: {e.message}
            </span>
          ))}
        </div>
      )}
      <div>
        <Button type="submit" size="sm" disabled={run.isPending}>
          Import
        </Button>
      </div>
    </form>
  );
}
