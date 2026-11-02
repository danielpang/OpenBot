// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimitsSettings } from '../features/settings/admin-settings.js';
import type { CatalogEntry, Connector } from '../features/tools/api.js';
import { CatalogCard } from '../features/tools/catalog.js';
import { ConnectorCard } from '../features/tools/connector-card.js';
import { CustomServerForm } from '../features/tools/custom-server.js';
import { STDIO_NOTES, STDIO_OFF_SELF_HOSTED } from '../features/tools/forms.js';
import { capabilitiesQuery } from './api.js';
import { adminLabel, blockedText, type Deployment } from './deployment.js';

// A self-hosted install has one owner and no "admin" wording; the managed
// service keeps it. Components read the deployment from the capabilities the
// app routes load (routes.test.tsx covers the tabs and redirects).

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    requests: [] as { method: string; path: string; body: unknown }[],
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    const text = request.method === 'GET' ? '' : await request.text();
    state.requests.push({ method: request.method, path, body: text ? JSON.parse(text) : null });
    if (path === '/api/v1/settings') {
      return Response.json({
        signupMode: 'first_user_admin',
        auditRetentionDays: 180,
        customStdioEnabled: false,
        limits: {
          botsPerAccount: 50,
          botsPerGroup: 6,
          routinesPerBot: 20,
          skillsPerAccount: 100,
          runRecordsPerRoutine: 50,
          webhookPayloadBytes: 1000,
          syncWebhookWaitSeconds: 30,
          webhookIpRatePerMin: 600,
          webhookFailedAuthPerMin: 10,
          webhookEndpointRatePerMin: 60,
          uploadBytes: 1000,
        },
      });
    }
    return Response.json({ items: [] });
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
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(ui: ReactNode, deployment?: Deployment) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (deployment) {
    client.setQueryData(capabilitiesQuery.queryKey, {
      oauth: { github: false, google: false },
      deployment,
    });
  }
  act(() => root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>));
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 20)));

const blockedEntry = {
  id: 'postgres',
  name: 'Postgres',
  description: 'SQL',
  kind: 'mcp_stdio',
  icon: 'database',
  params: [],
  secrets: [],
  oauth: null,
  disabledByAdmin: true,
} as unknown as CatalogEntry;

const httpConnector = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: 'Remote',
  slug: 'remote',
  kind: 'mcp_http',
  catalogId: null,
  transport: 'http',
  url: 'https://example.com/mcp',
  auth: 'none',
  params: {},
  secrets: [],
  oauth: null,
  status: 'ok',
  disabledByAdmin: false,
  trusted: false,
  local: false,
  toolCount: 0,
} as unknown as Connector;

describe('admin wording', () => {
  it('drops "Admin:" and names a block plainly when self-hosted', () => {
    expect(adminLabel(true, 'connector policy')).toBe('Admin: connector policy');
    expect(adminLabel(false, 'connector policy')).toBe('Connector policy');
    expect(blockedText(true)).toBe('Disabled by admin');
    expect(blockedText(false)).toBe('Blocked by policy');
  });

  it('says a blocked catalog entry is blocked, not disabled by an admin, when self-hosted', () => {
    render(<CatalogCard entry={blockedEntry} added={false} />, 'self_hosted');
    expect(host.textContent).toContain('Blocked by policy');
    expect(host.textContent).not.toMatch(/admin/i);
  });

  it('reads as self-hosted before the capabilities are known', () => {
    render(<CatalogCard entry={blockedEntry} added={false} />);
    expect(host.textContent).toContain('Blocked by policy');
  });

  it('keeps "Disabled by admin" on the managed service', () => {
    render(<CatalogCard entry={blockedEntry} added={false} />, 'managed');
    expect(host.textContent).toContain('Disabled by admin');
  });

  it("labels the owner's network setting without Admin: when self-hosted", () => {
    render(<ConnectorCard connector={httpConnector} entry={undefined} admin />, 'self_hosted');
    expect(host.textContent).toContain('Runs on my network');
    expect(host.textContent).not.toMatch(/admin/i);

    act(() => root.unmount());
    root = createRoot(host);
    render(<ConnectorCard connector={httpConnector} entry={undefined} admin />, 'managed');
    expect(host.textContent).toContain('Admin: runs on my network');
  });

  it('points a self-hosted owner at "Connector policy" while stdio is off', () => {
    render(<CustomServerForm stdio="off" />, 'self_hosted');
    expect(host.textContent).toContain(STDIO_OFF_SELF_HOSTED);
    expect(host.textContent).not.toMatch(/admin/i);

    act(() => root.unmount());
    root = createRoot(host);
    render(<CustomServerForm stdio="off" />, 'managed');
    expect(host.textContent).toContain(STDIO_NOTES.off);
  });
});

describe('Settings > Limits (self-hosted)', () => {
  it('saves only the limits that changed, nothing managed only', async () => {
    render(<LimitsSettings />, 'self_hosted');
    await flush();
    const input = host.querySelector<HTMLInputElement>('input[name="botsPerGroup"]')!;
    expect(input.value).toBe('6');
    expect(host.querySelector('select[name="signupMode"]')).toBeNull();
    expect(host.querySelector('input[name="auditRetentionDays"]')).toBeNull();
    expect(host.textContent).not.toMatch(/admin|audit|invite/i);

    act(() => {
      input.value = '4';
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    await flush();
    const patch = server.requests.find((r) => r.method === 'PATCH');
    expect(patch).toEqual({
      method: 'PATCH',
      path: '/api/v1/settings',
      body: { limits: { botsPerGroup: 4 } },
    });
  });
});
