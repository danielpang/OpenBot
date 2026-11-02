// @vitest-environment happy-dom
import { ToolPolicySchema } from '@openbots/shared';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesQuery } from '../../app/api.js';
import type { Bot } from '../bots/queries.js';
import {
  connectorsQuery,
  type BotConnector,
  type BotTool,
  type CatalogEntry,
  type Connector,
} from './api.js';
import { BlockList } from './block-list.js';
import { BotToolsForm } from './bot-tools.js';
import { CatalogCard } from './catalog.js';
import { ConnectorCard, ConnectorSettings } from './connector-card.js';
import { CustomServerForm, ImportForm } from './custom-server.js';
import {
  IMPORT_STDIO_NOTE,
  STDIO_NOTES,
  customConnectorBody,
  parseEnv,
  parseImport,
  secretsPatch,
  splitArgs,
  statusText,
  stdioAvailability,
} from './forms.js';
import {
  computerEnabled,
  defaultText,
  parseHosts,
  permissionItems,
  readPolicy,
  serializePolicy,
  setAllowlist,
  setComputerEnabled,
  setDecision,
  setToolEnabled,
  toolEnabled,
  defaultPermission,
} from './policy.js';
import { oauthNotice } from './tools-page.js';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    requests: [] as { method: string; path: string; body: unknown }[],
    tools: [] as unknown[],
    policy: {
      catalogIds: [] as string[],
      urlPatterns: [] as string[],
      allowedCatalogIds: [] as string[],
    },
    catalog: [] as unknown[],
    connectors: [] as Record<string, unknown>[],
    imported: { items: [] as unknown[], errors: [] as { name: string; message: string }[] },
    /** While set, changes wait for it before the server answers. */
    hold: null as Promise<void> | null,
    /** While set, changes fail with this problem title. */
    fail: null as string | null,
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    const text = request.method === 'GET' ? '' : await request.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    state.requests.push({ method: request.method, path, body });
    if (request.method !== 'GET') {
      await state.hold;
      if (state.fail) return Response.json({ title: state.fail }, { status: 400 });
    }
    if (path.endsWith('/local') && body) {
      state.connectors = state.connectors.map((c) => ({ ...c, local: body.local }));
      return Response.json(state.connectors[0] ?? {});
    }
    if (path.endsWith('/tools')) return Response.json({ items: state.tools });
    if (path.endsWith('/connector-policy')) return Response.json(state.policy);
    if (path.endsWith('/connectors/import')) return Response.json(state.imported);
    if (path.endsWith('/connectors/catalog')) return Response.json({ items: state.catalog });
    if (path.endsWith('/connectors') && request.method === 'PUT')
      return Response.json({ items: [] });
    if (path === '/api/v1/connectors') return Response.json({ items: state.connectors });
    return Response.json({});
  };
  return state;
});

afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  server.requests.length = 0;
  server.tools = [];
  server.connectors = [];
  server.hold = null;
  server.fail = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The managed service's wording; deployment.test.tsx covers self-hosted.
  client.setQueryData(capabilitiesQuery.queryKey, {
    oauth: { github: false, google: false },
    deployment: 'managed',
  });
  act(() => root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>));
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 20)));

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  if (check()) return;
  throw new Error(`timed out waiting for ${what}: ${host.textContent}`);
}
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);

function setValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const proto = Object.getPrototypeOf(el) as object;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: 'postgres',
  name: 'Postgres',
  description: 'SQL',
  kind: 'mcp_stdio',
  icon: 'database',
  homepage: null,
  version: '0.6.2',
  runtime: 'node',
  command: 'npx',
  args: [],
  url: null,
  auth: [],
  builtin: null,
  params: [],
  secrets: [{ name: 'POSTGRES_URL', label: 'Connection URL', description: null, required: true }],
  oauth: null,
  disabledByAdmin: false,
  ...over,
});

const connector = (over: Partial<Connector> = {}): Connector => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  name: 'GitHub',
  slug: 'github',
  kind: 'mcp_http',
  catalogId: null,
  transport: 'http',
  command: null,
  args: null,
  env: null,
  url: 'https://example.com/mcp',
  auth: 'bearer',
  headers: null,
  builtin: null,
  params: {},
  secrets: [{ name: 'BEARER_TOKEN', label: 'Access token', required: true, set: true }],
  oauth: null,
  status: 'ok',
  lastError: null,
  lastCheckedAt: null,
  disabledByAdmin: false,
  trusted: false,
  local: false,
  toolCount: 2,
  createdAt: '2026-10-18T00:00:00.000Z',
  updatedAt: '2026-10-18T00:00:00.000Z',
  ...over,
});

describe('connector icons on the page and in Bot Settings', () => {
  const iconOf = (selector: string) =>
    host.querySelector(`${selector} [data-icon]`)?.getAttribute('data-icon');

  it("shows the catalog's mark on its card and on a connector added from it", () => {
    render(<CatalogCard entry={entry({ id: 'neon', name: 'Neon', icon: 'neon' })} added={false} />);
    expect(iconOf('[data-catalog="neon"]')).toBe('neon');
    expect(host.querySelector('[data-catalog="neon"] svg')).not.toBeNull();

    render(
      <ConnectorCard
        connector={connector({ catalogId: 'github' })}
        entry={entry({ icon: 'github' })}
      />,
    );
    expect(iconOf('[data-connector]')).toBe('github');
  });

  it('gives a custom connector a lettermark from its name', () => {
    render(<ConnectorCard connector={connector({ name: 'Acme tracker' })} entry={undefined} />);
    expect(iconOf('[data-connector]')).toBe('lettermark');
    expect(host.querySelector('[data-connector] [data-icon]')!.textContent).toBe('AT');
  });

  it("looks a Bot's connector up in the catalog for its row", async () => {
    server.catalog = [entry({ id: 'github', name: 'GitHub', icon: 'github' })];
    const github = connector({ catalogId: 'github' });
    const bot = { id: '00000000-0000-4000-8000-0000000000b2', toolPolicy: {} } as unknown as Bot;
    render(
      <BotToolsForm
        bot={bot}
        entries={[
          { connector: github, permission: defaultPermission(github.id), customized: false },
        ]}
        tools={[]}
        computer={false}
      />,
    );
    await until(() => iconOf('[data-connector]') === 'github', 'the GitHub icon');
    server.catalog = [];
  });
});

describe('catalog cards', () => {
  it('offers Add, or says "Disabled by admin" and offers nothing', () => {
    render(<CatalogCard entry={entry()} added={false} />);
    expect(button('Add')).toBeDefined();
    expect(host.textContent).not.toContain('Disabled by admin');

    render(<CatalogCard entry={entry({ disabledByAdmin: true })} added={false} />);
    expect(host.textContent).toContain('Disabled by admin');
    expect(button('Add')).toBeUndefined();
    expect(host.querySelector('[data-disabled]')).not.toBeNull();
  });

  it('opens the declared secrets as empty password fields', () => {
    render(<CatalogCard entry={entry()} added={false} />);
    act(() => button('Add')!.click());
    const input = host.querySelector<HTMLInputElement>('input[name="secret:POSTGRES_URL"]')!;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    expect(host.textContent).toContain('Connection URL');
  });
});

describe('connector secrets', () => {
  it('are write-only: shown as set, never filled, and only typed values are sent', async () => {
    render(<ConnectorSettings connector={connector()} entry={undefined} onDone={() => {}} />);
    const input = host.querySelector<HTMLInputElement>('input[name="secret:BEARER_TOKEN"]')!;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    expect(host.textContent).toContain('set');

    act(() => button('Save')!.closest('form')!.requestSubmit());
    await flush();
    expect(server.requests.filter((r) => r.method !== 'GET').at(-1)).toMatchObject({
      method: 'PATCH',
      body: {},
    });

    setValue(input, ' new-token ');
    act(() => button('Save')!.closest('form')!.requestSubmit());
    await flush();
    expect(server.requests.filter((r) => r.method !== 'GET').at(-1)).toMatchObject({
      method: 'PATCH',
      body: { secrets: { BEARER_TOKEN: 'new-token' } },
    });
  });

  it('builds a PATCH from typed fields and removals only', () => {
    expect(secretsPatch({ A: '', B: ' x ' }, ['C'])).toEqual({ B: 'x', C: null });
    expect(secretsPatch({ A: '  ' })).toBeUndefined();
  });
});

describe('Connectors page forms', () => {
  it('splits a command line and reads KEY=value lines', () => {
    expect(splitArgs(`npx -y "my server" 'a b' c`)).toEqual(['npx', '-y', 'my server', 'a b', 'c']);
    expect(() => splitArgs('npx "open')).toThrow(/quote/);
    expect(parseEnv('A=1\n\nB_2=x=y')).toEqual({ A: '1', B_2: 'x=y' });
    expect(() => parseEnv('nope')).toThrow(/KEY=value/);
  });

  it('turns the custom form into a connector with its secrets', () => {
    const base = {
      name: '',
      command: '',
      env: '',
      url: '',
      auth: 'none' as const,
      token: '',
    };
    expect(
      customConnectorBody({ ...base, transport: 'stdio', command: 'npx -y srv', env: 'K=v' }),
    ).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', 'srv'], secrets: { K: 'v' } });
    expect(
      customConnectorBody({
        ...base,
        name: 'Mine',
        transport: 'http',
        url: 'https://x.dev/mcp',
        auth: 'bearer',
        token: 't',
      }),
    ).toEqual({
      name: 'Mine',
      transport: 'http',
      url: 'https://x.dev/mcp',
      auth: 'bearer',
      secrets: { BEARER_TOKEN: 't' },
    });
    expect(() =>
      customConnectorBody({ ...base, transport: 'http', auth: 'bearer', url: 'https://x' }),
    ).toThrow(/token/);
  });

  it('reads pasted mcpServers JSON, bare or wrapped', () => {
    expect(parseImport('{"mcpServers": {"a": {"command": "x"}}}')).toEqual({ a: { command: 'x' } });
    expect(parseImport('{"a": {"url": "https://x"}}')).toEqual({ a: { url: 'https://x' } });
    expect(() => parseImport('{')).toThrow(/JSON/);
    expect(() => parseImport('{"mcpServers": {}}')).toThrow(/No servers/);
  });

  it('puts admin blocks and logins before the test status', () => {
    expect(statusText(connector({ disabledByAdmin: true }))).toBe('Disabled by admin');
    const oauth = { clientConfigured: true, connected: false, expiresAt: null };
    expect(statusText(connector({ oauth }))).toBe('Not connected');
    expect(statusText(connector({ oauth: { ...oauth, clientConfigured: false } }))).toBe(
      'Not connected',
    );
    const signedIn = { ...oauth, connected: true };
    expect(statusText(connector({ oauth: signedIn }))).toBe('Connected');
    expect(statusText(connector({ oauth: signedIn, status: 'untested' }))).toBe('Connected');
    expect(statusText(connector({ oauth: signedIn, status: 'needs_auth' }))).toBe(
      'Sign-in expired',
    );
    expect(statusText(connector({ status: 'needs_auth' }))).toBe('Needs login');
    const builtin = { kind: 'builtin' as const, status: 'untested' as const };
    expect(statusText(connector(builtin))).toBe('Ready');
    const unset = [{ name: 'BRAVE_API_KEY', label: null, required: false, set: false }];
    expect(statusText(connector({ ...builtin, secrets: unset }))).toBe('No key set');
  });

  it('reads the OAuth return', () => {
    expect(oauthNotice({ connector: 'c', oauth: 'connected' })?.ok).toBe(true);
    expect(oauthNotice({ oauth: 'error', message: 'denied' })).toEqual({
      ok: false,
      text: 'Could not connect: denied',
    });
    expect(oauthNotice({ connector: 'c' })).toBeNull();
  });
});

describe('custom stdio (S-1)', () => {
  it('is for admins, once it is turned on', () => {
    expect(stdioAvailability('member', true)).toBe('admin_only');
    expect(stdioAvailability(undefined, undefined)).toBe('admin_only');
    expect(stdioAvailability('admin', false)).toBe('off');
    expect(stdioAvailability('admin', true)).toBe('on');
  });

  it('greys out the command option and says why', () => {
    render(<CustomServerForm stdio="admin_only" />);
    const radios = [...host.querySelectorAll<HTMLInputElement>('input[name="transport"]')];
    expect(radios.map((r) => [r.checked, r.disabled])).toEqual([
      [false, true],
      [true, false],
    ]);
    expect(host.textContent).toContain(STDIO_NOTES.admin_only);

    // The page remounts the form when this changes.
    // A URL comes first; admins can pick a command.
    render(<CustomServerForm key="on" stdio="on" />);
    const on = [...host.querySelectorAll<HTMLInputElement>('input[name="transport"]')];
    expect(on.map((r) => [r.checked, r.disabled])).toEqual([
      [false, false],
      [true, false],
    ]);
    act(() => on[0]!.click());
    expect(host.querySelector('form[aria-label="Custom stdio server"]')).not.toBeNull();
  });
});

describe('pasted mcpServers JSON (T2, S-1)', () => {
  it('imports what a member may add and lists each refused server with why', async () => {
    const refusal =
      'Only an admin can add a command (stdio) server. Add it from the catalog or by its HTTP URL instead.';
    server.imported = {
      items: [connector({ id: '00000000-0000-4000-8000-0000000000c9', name: 'remote' })],
      errors: [{ name: 'local', message: refusal }],
    };
    render(<ImportForm stdio="admin_only" />);
    expect(host.textContent).toContain(IMPORT_STDIO_NOTE);
    expect(STDIO_NOTES.admin_only).toContain('an HTTP URL');
    setValue(
      host.querySelector('textarea')!,
      JSON.stringify({
        mcpServers: {
          local: { command: 'npx', args: ['-y', 'my-server'] },
          remote: { url: 'https://mcp.example.com/mcp' },
        },
      }),
    );
    act(() => button('Import')!.closest('form')!.requestSubmit());
    await until(() => Boolean(host.querySelector('[role="status"]')), 'the import result');
    const status = host.querySelector('[role="status"]')!.textContent;
    expect(status).toContain('Imported 1 server.');
    expect(status).toContain('Not imported:');
    expect(status).toContain(`local: ${refusal}`);
    const sent = server.requests.find((r) => r.path === '/api/v1/connectors/import');
    expect(Object.keys((sent!.body as { mcpServers: object }).mcpServers)).toEqual([
      'local',
      'remote',
    ]);
  });
});

describe('admin allow list (U3)', () => {
  it('saves ticked catalog entries as the allow list, never also blocked', async () => {
    server.catalog = [entry({ id: 'github', name: 'GitHub' }), entry()];
    server.policy = { catalogIds: ['postgres'], urlPatterns: [], allowedCatalogIds: [] };
    render(<BlockList />);
    // The form mounts once the policy loads, and only then asks for the
    // catalog, so wait for the catalog's rows rather than a fixed delay.
    const allowBoxes = () => {
      const allowList = [...host.querySelectorAll('fieldset')].find((f) =>
        f.textContent?.includes('Allowed catalog connectors'),
      );
      return [...(allowList?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])];
    };
    await until(() => allowBoxes().length === 2, 'the catalog in the allow list');
    const boxes = allowBoxes();
    expect(boxes.map((b) => b.checked)).toEqual([false, false]);
    act(() => boxes[0]!.click());
    act(() => boxes[1]!.click());
    act(() => button('Save connector policy')!.closest('form')!.requestSubmit());
    await until(() => server.requests.some((r) => r.method === 'PUT'), 'the policy PUT');
    expect(server.requests.find((r) => r.method === 'PUT')).toMatchObject({
      path: '/api/v1/connector-policy',
      body: { catalogIds: [], urlPatterns: [], allowedCatalogIds: ['github', 'postgres'] },
    });
  });
});

describe('trusted hints (S-16)', () => {
  const trustBox = () =>
    [...host.querySelectorAll('label')]
      .find((l) => l.textContent?.includes('trust its read-only hints'))
      ?.querySelector('input');

  it("lets an admin trust a custom connector's hints from its tool list", async () => {
    render(<ConnectorCard connector={connector()} entry={undefined} admin />);
    act(() => button('Tools')!.click());
    await flush();
    expect(trustBox()!.checked).toBe(false);
    act(() => trustBox()!.click());
    await flush();
    expect(server.requests.find((r) => r.method === 'PUT')).toMatchObject({
      path: `/api/v1/connectors/${connector().id}/trusted`,
      body: { trusted: true },
    });
  });

  it('is not offered to members, or for catalog connectors', async () => {
    render(<ConnectorCard connector={connector()} entry={undefined} />);
    act(() => button('Tools')!.click());
    await flush();
    expect(trustBox()).toBeUndefined();
    render(
      <ConnectorCard connector={connector({ catalogId: 'github' })} entry={undefined} admin />,
    );
    await flush();
    expect(trustBox()).toBeUndefined();
  });
});

describe('runs on my network (S-8)', () => {
  const localBox = () =>
    [...host.querySelectorAll('label')]
      .find((l) => l.textContent?.includes('runs on my network'))
      ?.querySelector('input');

  it('lets an admin mark an HTTP connector local, and shows the mark to everyone', async () => {
    render(<ConnectorCard connector={connector()} entry={undefined} admin />);
    expect(host.textContent).not.toContain('· on my network');
    expect(localBox()!.checked).toBe(false);
    act(() => localBox()!.click());
    await flush();
    expect(server.requests.find((r) => r.method === 'PUT')).toMatchObject({
      path: `/api/v1/connectors/${connector().id}/local`,
      body: { local: true },
    });
    render(<ConnectorCard connector={connector({ local: true })} entry={undefined} />);
    expect(host.textContent).toContain('· on my network');
    expect(localBox()).toBeUndefined();
  });

  // The card as the Connectors page shows it: from the connector list, which a save refetches.
  function ListedCard() {
    const { data } = useQuery(connectorsQuery);
    const listed = data?.items[0];
    return listed ? <ConnectorCard connector={listed} entry={undefined} admin /> : null;
  }

  it('shows the tick at once, while the server saves it', async () => {
    server.connectors = [connector()];
    render(<ListedCard />);
    await until(() => !!localBox(), 'the card');
    let answer!: () => void;
    server.hold = new Promise((resolve) => (answer = resolve));
    act(() => localBox()!.click());
    expect(localBox()!.checked).toBe(true);
    await until(() => localBox()!.disabled, 'the save to start');
    expect(localBox()!.checked).toBe(true);
    act(() => answer());
    await until(() => !localBox()!.disabled, 'the save to finish');
    // The tick holds while the list is read back, and the card then agrees.
    expect(localBox()!.checked).toBe(true);
    await until(() => !!host.textContent?.includes('· on my network'), 'the saved value');
    expect(localBox()!.checked).toBe(true);
  });

  it('shows the saved state again, and why, when saving fails', async () => {
    server.connectors = [connector()];
    server.fail = 'Not an HTTP connector';
    render(<ListedCard />);
    await until(() => !!localBox(), 'the card');
    act(() => localBox()!.click());
    expect(localBox()!.checked).toBe(true);
    await until(() => !!host.querySelector('[role="alert"]'), 'the error');
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Not an HTTP connector');
    expect(localBox()!.checked).toBe(false);
    expect(localBox()!.disabled).toBe(false);
  });

  it('is not offered for stdio connectors', () => {
    render(
      <ConnectorCard
        connector={connector({ kind: 'mcp_stdio', transport: 'stdio', url: null })}
        entry={undefined}
        admin
      />,
    );
    expect(localBox()).toBeUndefined();
  });
});

describe('policy editor', () => {
  it('round-trips edits through the stored schema', () => {
    let policy = readPolicy({ tools: { bash: 'ask' }, triggers: { webhook: { default: 'deny' } } });
    policy = setDecision(policy, 'tools', 'github__create_issue', 'auto');
    policy = setDecision(policy, 'groups', 'connector', 'ask');
    policy = setDecision(policy, 'tools', 'bash', undefined);
    policy = setAllowlist(policy, 'list', parseHosts('API.example.com\n*.example.org\n').hosts);
    const sent = serializePolicy(policy);
    expect(ToolPolicySchema.parse(JSON.parse(JSON.stringify(sent)))).toEqual({
      tools: { github__create_issue: 'auto' },
      groups: { connector: 'ask' },
      triggers: { webhook: { default: 'deny' } },
      httpAllowlist: ['api.example.com', '*.example.org'],
    });
    expect(
      serializePolicy(setDecision(sent, 'tools', 'github__create_issue', undefined)),
    ).not.toHaveProperty('tools');
    // Absent allows every public host; an empty list allows none.
    expect(setAllowlist(sent, 'any', [])).not.toHaveProperty('httpAllowlist');
    expect(setAllowlist(sent, 'list', []).httpAllowlist).toEqual([]);
    expect(readPolicy({ bash: 'ask' })).toEqual({});
  });

  it('lists what is not a host', () => {
    expect(parseHosts('ok.dev, https://bad.dev/x\n*.fine.io')).toEqual({
      hosts: ['ok.dev', '*.fine.io'],
      errors: ['https://bad.dev/x'],
    });
  });

  it('edits allow and deny lists and sends only changed connectors', () => {
    const p = defaultPermission('c1');
    const off = setToolEnabled(p, 'delete', false);
    expect(toolEnabled(off, 'delete')).toBe(false);
    expect(toolEnabled(setToolEnabled(off, 'delete', true), 'delete')).toBe(true);
    expect(permissionItems([p, off])).toEqual([off]);
  });

  it('saves the Bot tab and reads the stored shape back', async () => {
    const bot = {
      id: '00000000-0000-4000-8000-0000000000b1',
      toolPolicy: { tools: { web_fetch: 'deny' } },
    } as unknown as Bot;
    const entries: BotConnector[] = [
      { connector: connector(), permission: defaultPermission(connector().id), customized: false },
    ];
    render(<BotToolsForm bot={bot} entries={entries} tools={TOOLS} computer />);
    await flush();

    expect(select('web_fetch approval').value).toBe('deny');
    expect(select('create_issue approval').options[0]!.textContent).toBe('Default: Ask first');
    setValue(select('web_fetch approval'), '');
    setValue(select('create_issue approval'), 'auto');
    setValue(select('GitHub approvals'), 'ask');
    const onlyThese = [...host.querySelectorAll('label')].find((l) =>
      l.textContent?.includes('Only these hosts'),
    );
    act(() => onlyThese!.querySelector('input')!.click());
    setValue(
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Allowed hosts"]')!,
      'api.github.com',
    );
    act(() => button('Save')!.closest('form')!.requestSubmit());
    await flush();

    const patch = server.requests.find((r) => r.method === 'PATCH');
    expect(patch?.path).toBe(`/api/v1/bots/${bot.id}`);
    const stored = ToolPolicySchema.parse((patch!.body as { toolPolicy: unknown }).toolPolicy);
    expect(stored).toEqual({
      tools: { github__create_issue: 'auto' },
      httpAllowlist: ['api.github.com'],
    });
    const put = server.requests.find((r) => r.method === 'PUT');
    expect(put?.body).toEqual({
      items: [
        {
          connectorId: connector().id,
          toolAllowlist: null,
          toolDenylist: [],
          approvalOverride: 'ask',
        },
      ],
    });
  });
});

const tool = (over: Partial<BotTool> & Pick<BotTool, 'name' | 'group'>): BotTool => ({
  connectorId: null,
  needsConnector: false,
  disabledByAdmin: false,
  decision: 'auto',
  why: `${over.name} only reads`,
  byArguments: false,
  ...over,
});

/** As `GET /bots/{id}/tools` answers: the engine's defaults, one per tool. */
const TOOLS: BotTool[] = [
  tool({ name: 'ask_user', group: 'conversation' }),
  tool({ name: 'message_bot', group: 'conversation' }),
  tool({ name: 'create_artifact', group: 'artifacts' }),
  tool({ name: 'web_fetch', group: 'builtin' }),
  tool({
    name: 'http_request',
    group: 'builtin',
    decision: 'ask',
    byArguments: true,
    why: 'GET, HEAD and OPTIONS requests run without asking; other methods ask first',
  }),
  tool({ name: 'send_email', group: 'builtin', needsConnector: true, decision: 'ask' }),
  tool({ name: 'bash', group: 'computer', decision: 'ask' }),
  tool({ name: 'browser_click', group: 'computer' }),
  // A read-only hint from a connector that is neither from the catalog nor trusted (S-16).
  tool({
    name: 'github__list_issues',
    group: 'connector',
    connectorId: connector().id,
    needsConnector: true,
    decision: 'ask',
    why: 'github__list_issues says it is read-only, but its connector is not from the catalog or trusted',
  }),
  tool({
    name: 'github__create_issue',
    group: 'connector',
    connectorId: connector().id,
    needsConnector: true,
    decision: 'ask',
  }),
];

const select = (label: string) =>
  host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
const defaultOf = (label: string) => select(label).options[0]!.textContent;

describe('Bot tools tab (T5)', () => {
  const bot = (toolPolicy: object = {}) =>
    ({ id: '00000000-0000-4000-8000-0000000000b2', toolPolicy }) as unknown as Bot;
  const entries = (): BotConnector[] => [
    { connector: connector(), permission: defaultPermission(connector().id), customized: false },
  ];

  it("sets every group and every tool, showing the engine's defaults", async () => {
    render(<BotToolsForm bot={bot()} entries={entries()} tools={TOOLS} computer />);
    await flush();
    for (const group of [
      'Conversation tools',
      'Artifact tools',
      'Built-in tools',
      'Computer tools',
      'Connector tools',
    ]) {
      expect(select(group), group).toBeTruthy();
    }
    expect(defaultOf('bash approval')).toBe('Default: Ask first');
    expect(defaultOf('browser_click approval')).toBe('Default: Run without asking');
    expect(defaultOf('message_bot approval')).toBe('Default: Run without asking');
    expect(defaultOf('create_artifact approval')).toBe('Default: Run without asking');
    expect(defaultOf('http_request approval')).toBe(
      'Default: GET, HEAD and OPTIONS requests run without asking; other methods ask first',
    );
    // The engine asks for an untrusted connector's read-only tool, and so does the tab (S-16).
    expect(defaultOf('list_issues approval')).toBe('Default: Ask first');
    // A tool that needs a connector the owner has not added is not listed.
    expect(select('send_email approval')).toBeNull();

    // A group setting becomes its tools' Default.
    setValue(select('Computer tools'), 'auto');
    expect(defaultOf('bash approval')).toBe('Default: Run without asking');
    setValue(select('bash approval'), 'ask');
    setValue(select('message_bot approval'), 'deny');
    setValue(select('Artifact tools'), 'ask');
    act(() => button('Save')!.closest('form')!.requestSubmit());
    await flush();
    const patch = server.requests.find((r) => r.method === 'PATCH');
    expect(ToolPolicySchema.parse((patch!.body as { toolPolicy: unknown }).toolPolicy)).toEqual({
      tools: { bash: 'ask', message_bot: 'deny' },
      groups: { computer: 'auto', artifacts: 'ask' },
    });
  });

  it('turns computer use off for the Bot, as groups.computer = deny', async () => {
    render(<BotToolsForm bot={bot()} entries={entries()} tools={TOOLS} computer />);
    await flush();
    const toggle = [...host.querySelectorAll('label')].find(
      (l) => l.textContent === 'Use its computer',
    )!;
    expect(toggle.querySelector('input')!.checked).toBe(true);
    // Never is the switch, not a choice in the group's select.
    expect([...select('Computer tools').options].map((o) => o.value)).toEqual(['', 'auto', 'ask']);
    act(() => toggle.querySelector('input')!.click());
    expect(select('bash approval')).toBeNull();
    expect(host.textContent).toContain('Off: no computer tools');
    act(() => button('Save')!.closest('form')!.requestSubmit());
    await flush();
    const patch = server.requests.find((r) => r.method === 'PATCH');
    expect((patch!.body as { toolPolicy: unknown }).toolPolicy).toEqual({
      groups: { computer: 'deny' },
    });
  });

  it('says so when the install has no computer', async () => {
    render(<BotToolsForm bot={bot()} entries={entries()} tools={TOOLS} computer={false} />);
    await flush();
    expect(host.textContent).toContain('This install has no computer for its Bots.');
    expect(select('bash approval')).toBeNull();
  });

  it('marks a built-in an admin blocked', async () => {
    const blocked = TOOLS.map((t) =>
      t.name === 'web_fetch' ? { ...t, disabledByAdmin: true } : t,
    );
    render(<BotToolsForm bot={bot()} entries={entries()} tools={blocked} computer />);
    await flush();
    const row = select('web_fetch approval').closest('li')!;
    expect(row.textContent).toContain('Disabled by admin');
  });

  it('reads Default from the connector, then the group, then the engine', () => {
    const bash = TOOLS.find((t) => t.name === 'bash')!;
    expect(defaultText({}, bash)).toBe('Ask first');
    expect(defaultText({ groups: { computer: 'auto' } }, bash)).toBe('Run without asking');
    expect(defaultText({ groups: { connector: 'deny' } }, TOOLS.at(-1)!, 'auto')).toBe(
      'Run without asking',
    );
    const http = TOOLS.find((t) => t.name === 'http_request')!;
    expect(defaultText({}, http)).toBe(http.why);
    expect(computerEnabled({})).toBe(true);
    const off = setComputerEnabled({ groups: { builtin: 'ask' } }, false);
    expect(off).toEqual({ groups: { builtin: 'ask', computer: 'deny' } });
    expect(computerEnabled(off)).toBe(false);
    expect(setComputerEnabled(off, true)).toEqual({ groups: { builtin: 'ask' } });
  });
});
