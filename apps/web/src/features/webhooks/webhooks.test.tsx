// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesQuery } from '../../app/api.js';
import { RightPanelProvider, useRightPanel } from '../../app/right-panel.js';
import type { Routine } from '../routines/api.js';
import { readPanel } from '../transcript/panel.js';
import type { Delivery, Endpoint } from './api.js';
import { parseHeaders, prettyBody } from './delivery-log.js';
import {
  BotInbox,
  describeEndpoint,
  endpointPatch,
  formFromEndpoint,
  overrideFromForm,
  RoutineEndpoint,
} from './endpoints.js';
import { EventSubscriptions } from './event-subscriptions.js';

// The Bot's webhook endpoints, their delivery log (H1 to H5) and Settings >
// Events (H6) against a fake REST server: tokens and secrets shown once,
// signing secrets that are write-only, Replay and the test-event form, and
// subscriptions with their events.

const BOT = '00000000-0000-4000-8000-0000000000b1';
const INBOX = '00000000-0000-4000-8000-0000000000a1';
const ROUTINE = '00000000-0000-4000-8000-0000000000c1';
const DELIVERY = '00000000-0000-4000-8000-0000000000d1';
const RUN = '00000000-0000-4000-8000-0000000000e1';
const SUBSCRIPTION = '00000000-0000-4000-8000-0000000000f1';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    requests: [] as { method: string; path: string; body: unknown }[],
    endpoints: [] as unknown[],
    deliveries: [] as unknown[],
    subscriptions: [] as unknown[],
    /** What the next create, rotate or PATCH hands back besides the endpoint. */
    issued: {} as Record<string, string>,
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const { pathname } = new URL(request.url, 'http://localhost');
    const text = request.method === 'GET' ? undefined : await request.text();
    const body = text ? JSON.parse(text) : undefined;
    state.requests.push({ method: request.method, path: pathname, body });
    const endpoint = state.endpoints[0];
    if (pathname.endsWith('/endpoints') && request.method === 'GET') {
      return Response.json({ items: state.endpoints });
    }
    if (pathname.endsWith('/endpoints') || pathname.endsWith('/rotate')) {
      return Response.json({ endpoint, ...state.issued }, { status: 201 });
    }
    if (pathname.endsWith('/deliveries') && pathname.includes('/endpoints/')) {
      return Response.json({ items: state.deliveries });
    }
    if (pathname.endsWith('/replay') || pathname.endsWith('/test')) {
      const delivery = {
        ...(state.deliveries[0] as object),
        id: '00000000-0000-4000-8000-0000000000d2',
        origin: pathname.endsWith('/test') ? 'test' : 'replay',
      };
      return Response.json({ delivery, runId: RUN }, { status: 201 });
    }
    if (pathname.startsWith('/api/v1/endpoints/') && request.method === 'PATCH') {
      return Response.json({ endpoint, ...state.issued });
    }
    if (pathname === '/api/v1/event-subscriptions' && request.method === 'GET') {
      return Response.json({ items: state.subscriptions });
    }
    if (pathname.startsWith('/api/v1/event-subscriptions')) {
      if (pathname.endsWith('/deliveries')) return Response.json({ items: [] });
      return Response.json(
        { subscription: state.subscriptions[0], ...state.issued },
        { status: request.method === 'POST' ? 201 : 200 },
      );
    }
    return Response.json({ title: 'Not found' }, { status: 404 });
  };
  return state;
});

function endpoint(patch: Partial<Endpoint> = {}): Endpoint {
  return {
    id: INBOX,
    botId: BOT,
    routineId: null,
    slug: 'inbox',
    url: 'https://openbots.example/hooks/grace',
    hasToken: true,
    signature: null,
    match: null,
    template: null,
    responseMode: 'async',
    syncTimeoutS: null,
    syncWaitS: 60,
    toolPolicyOverride: null,
    allowedIps: [],
    rateLimitPerMin: null,
    enabled: true,
    createdAt: '2026-10-18T10:00:00.000Z',
    ...patch,
  };
}

const delivery = (patch: Partial<Delivery> = {}): Delivery => ({
  id: DELIVERY,
  endpointId: INBOX,
  receivedAt: '2026-10-18T11:00:00.000Z',
  remoteIp: '192.30.252.1',
  headers: { 'content-type': 'application/json', 'x-github-event': 'issues' },
  body: '{"action":"opened"}',
  bodyFileId: null,
  verified: true,
  matched: true,
  status: 'queued',
  runId: RUN,
  error: null,
  origin: 'ingress',
  replayOf: null,
  ...patch,
});

const eventRoutine = {
  id: ROUTINE,
  name: 'Triage issues',
  trigger: { type: 'event', source: 'github' },
} as Routine;

beforeEach(() => {
  server.requests = [];
  server.endpoints = [endpoint()];
  server.deliveries = [delivery()];
  server.subscriptions = [];
  server.issued = {};
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  localStorage.clear();
});

function Slot() {
  const { content } = useRightPanel();
  return content ? <aside>{content}</aside> : null;
}

function render(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The managed service's wording; deployment.test.tsx covers self-hosted.
  queryClient.setQueryData(capabilitiesQuery.queryKey, {
    oauth: { github: false, google: false },
    deployment: 'managed',
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <RightPanelProvider>
          {ui}
          <Slot />
        </RightPanelProvider>
      </QueryClientProvider>,
    ),
  );
  return host;
}

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
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());
const input = <T extends Element = HTMLInputElement>(label: string) =>
  host.querySelector<T & Element>(`[aria-label="${label}"]`)!;
const sent = (method: string, suffix: string) =>
  server.requests.find((r) => r.method === method && r.path.endsWith(suffix));

function type(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  act(() => {
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

function openDetails(el: HTMLDetailsElement) {
  act(() => {
    el.open = true;
    el.dispatchEvent(new Event('toggle'));
  });
}

describe('endpoint settings', () => {
  it('leaves the signature alone unless it changed or a new secret was typed', () => {
    const github = endpoint({ signature: { preset: 'github', hasSecret: true } });
    const form = formFromEndpoint(github);
    expect(form.secret).toBe('');
    const unchanged = endpointPatch(github, { ...form, rateLimitPerMin: '30' });
    expect(unchanged).toEqual({
      ok: true,
      body: {
        responseMode: 'async',
        allowedIps: [],
        rateLimitPerMin: 30,
        template: null,
        enabled: true,
      },
    });
    expect(endpointPatch(github, { ...form, secret: 'a-new-secret' })).toMatchObject({
      ok: true,
      body: { signature: { preset: 'github', secret: 'a-new-secret' } },
    });
    expect(endpointPatch(github, { ...form, preset: '' })).toMatchObject({
      ok: true,
      body: { signature: null },
    });
    expect(endpointPatch(github, { ...form, preset: 'generic', header: 'X-Sig' })).toMatchObject({
      ok: true,
      body: { signature: { preset: 'generic', header: 'X-Sig' } },
    });
  });

  it('describes the wait the server uses for a sync endpoint (H4)', () => {
    expect(describeEndpoint(endpoint({ responseMode: 'sync' }))).toContain(
      'Waits up to 60 s for the reply',
    );
    // The admin's cap, as the server reports it, not the endpoint's own number.
    expect(
      describeEndpoint(endpoint({ responseMode: 'sync', syncTimeoutS: 45, syncWaitS: 20 })),
    ).toContain('Waits up to 20 s for the reply');
    expect(formFromEndpoint(endpoint()).syncTimeoutS).toBe('60');
  });

  it('needs the sender’s secret for Slack and Stripe, and checks the limits', () => {
    const form = formFromEndpoint(endpoint());
    expect(endpointPatch(endpoint(), { ...form, preset: 'slack' })).toEqual({
      ok: false,
      error: expect.stringContaining('Paste the signing secret'),
    });
    expect(
      endpointPatch(endpoint(), { ...form, responseMode: 'sync', syncTimeoutS: '90' }),
    ).toMatchObject({ ok: false });
    expect(
      endpointPatch(endpoint(), {
        ...form,
        responseMode: 'sync',
        syncTimeoutS: '20',
        allowedIps: '192.30.252.0/22\n 10.0.0.1, ',
      }),
    ).toMatchObject({
      ok: true,
      body: { syncTimeoutS: 20, allowedIps: ['192.30.252.0/22', '10.0.0.1'] },
    });
  });

  it('sets the tool policy override per group, keeping what the API set (plan 4.7)', () => {
    const stored = endpoint({
      toolPolicyOverride: { groups: { computer: 'deny' }, tools: { send_email: 'deny' } },
    });
    const form = formFromEndpoint(stored);
    expect(form.overrideDefault).toBe('');
    // Unchanged, it is not sent.
    const unchanged = endpointPatch(stored, form);
    expect(unchanged.ok && unchanged.body).not.toHaveProperty('toolPolicyOverride');
    expect(
      endpointPatch(stored, {
        ...form,
        overrideDefault: 'deny',
        overrideGroups: { ...form.overrideGroups, connector: 'ask' },
      }),
    ).toMatchObject({
      ok: true,
      body: {
        toolPolicyOverride: {
          default: 'deny',
          groups: { computer: 'deny', connector: 'ask' },
          tools: { send_email: 'deny' },
        },
      },
    });
    // Every group the form edits cleared, and nothing else stored: no override.
    const cleared = Object.fromEntries(
      Object.keys(form.overrideGroups).map((g) => [g, '']),
    ) as typeof form.overrideGroups;
    expect(
      overrideFromForm(
        { default: 'ask' },
        { ...form, overrideDefault: '', overrideGroups: cleared },
      ),
    ).toBeNull();
  });

  it('saves the override chosen in the settings form', async () => {
    render(<BotInbox botId={BOT} />);
    await until(() => !!host.querySelector('[data-endpoint]'), 'the inbox');
    click(button('Settings'));
    // Only the stricter choices: an override cannot loosen the Bot's settings.
    const select = input<HTMLSelectElement>('Connector tools');
    expect([...select.options].map((o) => o.value)).toEqual(['', 'ask', 'deny']);
    type(select, 'deny');
    act(() =>
      host.querySelector<HTMLFormElement>('form[aria-label="Endpoint settings"]')!.requestSubmit(),
    );
    await until(() => !!sent('PATCH', `/endpoints/${INBOX}`), 'save');
    expect(sent('PATCH', `/endpoints/${INBOX}`)!.body).toMatchObject({
      toolPolicyOverride: { groups: { connector: 'deny' } },
    });
  });

  it('keeps the signing secret write-only in the form', async () => {
    server.endpoints = [endpoint({ signature: { preset: 'stripe', hasSecret: true } })];
    render(<BotInbox botId={BOT} />);
    await until(() => !!host.querySelector('[data-endpoint]'), 'the inbox');
    expect(host.textContent).toContain('Stripe signature');
    click(button('Settings'));
    const secret = input('Signing secret');
    expect(secret.type).toBe('password');
    expect(secret.value).toBe('');
    expect(secret.placeholder).toBe('Enter a new secret to replace it');
    expect(host.textContent).toContain('(set)');

    // Saving without typing one sends no signature at all.
    type(input('Rate limit per minute'), '60');
    act(() =>
      host.querySelector<HTMLFormElement>('form[aria-label="Endpoint settings"]')!.requestSubmit(),
    );
    await until(() => !!sent('PATCH', `/endpoints/${INBOX}`), 'save');
    expect(sent('PATCH', `/endpoints/${INBOX}`)!.body).not.toHaveProperty('signature');
    expect(sent('PATCH', `/endpoints/${INBOX}`)!.body).toMatchObject({ rateLimitPerMin: 60 });

    // A typed secret is sent once and does not stay in the form.
    server.requests = [];
    click(button('Settings'));
    type(input('Signing secret'), 'whsec_replacement');
    act(() =>
      host.querySelector<HTMLFormElement>('form[aria-label="Endpoint settings"]')!.requestSubmit(),
    );
    await until(() => !!sent('PATCH', `/endpoints/${INBOX}`), 'save');
    expect(sent('PATCH', `/endpoints/${INBOX}`)!.body).toMatchObject({
      signature: { preset: 'stripe', secret: 'whsec_replacement' },
    });
    expect(host.innerHTML).not.toContain('whsec_replacement');
  });
});

describe('the Bot’s webhook endpoints', () => {
  it('shows the inbox every Bot has, generates its first token and shows it once', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    server.endpoints = [endpoint({ hasToken: false })];
    render(<BotInbox botId={BOT} />);
    await until(() => !!button('Generate token'), 'the inbox without a token');
    expect(host.textContent).toContain('POST https://openbots.example/hooks/grace');
    expect(host.textContent).toContain('Generate a token to accept deliveries.');
    // The inbox can be turned off in its settings, not deleted.
    expect(button('Delete')).toBeUndefined();
    expect(button('Rotate token')).toBeUndefined();
    server.endpoints = [endpoint()];
    server.issued = { token: 'obt_first' };
    click(button('Generate token'));
    await until(() => !!host.querySelector('[data-shown-once]'), 'the token');
    // Nothing to replace yet, so no confirmation.
    expect(confirm).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    expect(sent('POST', `/endpoints/${INBOX}/rotate`)).toBeTruthy();
    expect(sent('POST', `/bots/${BOT}/endpoints`)).toBeUndefined();
    expect(input('Token').value).toBe('obt_first');
    await until(() => !!button('Rotate token'), 'the inbox with a token');
    expect(host.textContent).toContain('POST https://openbots.example/hooks/grace');
    click(button('Done'));
    expect(host.querySelector('[data-shown-once]')).toBeNull();
    expect(host.innerHTML).not.toContain('obt_first');
  });

  it('rotates the token after asking', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    render(<BotInbox botId={BOT} />);
    await until(() => !!button('Rotate token'), 'the inbox');
    server.issued = { token: 'obt_rotated' };
    click(button('Rotate token'));
    await until(() => !!host.querySelector('[data-shown-once]'), 'the new token');
    expect(confirm).toHaveBeenCalled();
    expect(sent('POST', `/endpoints/${INBOX}/rotate`)).toBeTruthy();
    expect(input('Token').value).toBe('obt_rotated');
    vi.unstubAllGlobals();
  });

  it('shows the endpoint a Routine was made with, waiting for its first token (R2, H2)', async () => {
    server.endpoints = [
      endpoint(),
      endpoint({
        id: '00000000-0000-4000-8000-0000000000a2',
        routineId: ROUTINE,
        slug: 'triage-issues',
        url: 'https://openbots.example/hooks/grace/triage-issues',
        hasToken: false,
      }),
    ];
    render(<RoutineEndpoint botId={BOT} routine={eventRoutine} />);
    await until(() => !!button('Generate token'), 'the Routine endpoint');
    expect(host.textContent).toContain('POST https://openbots.example/hooks/grace/triage-issues');
    // Only the Routine's own endpoint, not the inbox.
    expect(host.querySelectorAll('[data-endpoint]')).toHaveLength(1);
    expect(button('Add endpoint')).toBeUndefined();
  });

  it('adds a GitHub Routine’s endpoint with the GitHub preset and shows the secret once', async () => {
    render(<RoutineEndpoint botId={BOT} routine={eventRoutine} />);
    await until(() => !!button('Add endpoint'), 'the Routine without an endpoint');
    expect(host.textContent).toContain('No endpoint yet');
    server.endpoints = [
      endpoint(),
      endpoint({
        id: '00000000-0000-4000-8000-0000000000a2',
        routineId: ROUTINE,
        slug: 'triage-issues',
        signature: { preset: 'github', hasSecret: true },
      }),
    ];
    server.issued = { token: 'obt_routine', signingSecret: 'gh_secret' };
    click(button('Add endpoint'));
    await until(() => !!host.querySelector('[data-shown-once]'), 'the secrets');
    expect(sent('POST', `/bots/${BOT}/endpoints`)!.body).toEqual({
      routineId: ROUTINE,
      signature: { preset: 'github' },
    });
    expect(input('Signing secret').value).toBe('gh_secret');
  });
});

describe('the delivery log', () => {
  async function openLog() {
    render(<BotInbox botId={BOT} />);
    await until(() => !!host.querySelector('[data-endpoint] details'), 'the inbox');
    openDetails(host.querySelector('[data-endpoint] details')!);
    await until(() => !!host.querySelector('[data-delivery]'), 'the deliveries');
  }

  it('shows headers, body, verification and the linked run', async () => {
    await openLog();
    const row = host.querySelector('[data-delivery]')!;
    expect(row.textContent).toContain('Started a run');
    expect(row.textContent).toContain('Verified');
    expect(row.textContent).toContain('x-github-event');
    expect(row.querySelector('pre')!.textContent).toBe(prettyBody('{"action":"opened"}'));
    click(button('Activity log'));
    expect(readPanel(BOT)).toEqual({ kind: 'activity', runId: RUN });
  });

  it('shows a refused delivery with its reason and no Replay (H5)', async () => {
    server.deliveries = [
      delivery({
        status: 'refused',
        verified: false,
        matched: false,
        runId: null,
        error: 'Signature does not match',
        body: '{"id":"evt_1"}',
      }),
    ];
    await openLog();
    const row = host.querySelector('[data-delivery]')!;
    expect(row.getAttribute('data-status')).toBe('refused');
    expect(row.textContent).toContain('Refused');
    expect(row.textContent).toContain('Not verified');
    expect(row.textContent).toContain('Signature does not match');
    expect(row.textContent).not.toContain('Rule did not match');
    expect(row.querySelector('pre')!.textContent).toBe(prettyBody('{"id":"evt_1"}'));
    expect(button('Replay')).toBeUndefined();
  });

  it('replays a delivery and refreshes the log', async () => {
    await openLog();
    const before = server.requests.filter((r) => r.path.endsWith('/deliveries')).length;
    click(button('Replay'));
    await until(() => !!sent('POST', `/deliveries/${DELIVERY}/replay`), 'replay');
    expect(sent('POST', `/deliveries/${DELIVERY}/replay`)!.path).toBe(
      `/api/v1/endpoints/${INBOX}/deliveries/${DELIVERY}/replay`,
    );
    await until(
      () => server.requests.filter((r) => r.path.endsWith('/deliveries')).length > before,
      'the refreshed log',
    );
  });

  it('sends a test event with headers', async () => {
    await openLog();
    type(input<HTMLTextAreaElement>('Test payload'), '{"type": "paid"}');
    type(input<HTMLTextAreaElement>('Test headers'), 'X-GitHub-Event: issues');
    act(() =>
      host.querySelector<HTMLFormElement>('form[aria-label="Test event"]')!.requestSubmit(),
    );
    await until(() => !!host.querySelector('[data-test-result]'), 'the result');
    expect(sent('POST', `/endpoints/${INBOX}/test`)!.body).toEqual({
      payload: { type: 'paid' },
      headers: { 'X-GitHub-Event': 'issues' },
    });
    expect(host.querySelector('[data-test-result]')!.textContent).toContain('Started a run');
  });

  it('refuses a payload that is not JSON', async () => {
    await openLog();
    type(input<HTMLTextAreaElement>('Test payload'), '{nope');
    act(() =>
      host.querySelector<HTMLFormElement>('form[aria-label="Test event"]')!.requestSubmit(),
    );
    expect(host.textContent).toContain('The payload is not valid JSON.');
    expect(sent('POST', '/test')).toBeUndefined();
  });

  it('reads Name: value header lines', () => {
    expect(parseHeaders('A: 1\n\nB-C: x: y')).toEqual({
      ok: true,
      headers: { A: '1', 'B-C': 'x: y' },
    });
    expect(parseHeaders('no colon')).toMatchObject({ ok: false });
  });
});

describe('Settings > Events', () => {
  const subscription = {
    id: SUBSCRIPTION,
    url: 'https://example.com/events',
    events: ['run.failed', 'routine.ran'],
    enabled: true,
    local: false,
    createdAt: '2026-10-18T10:00:00.000Z',
  };

  it('adds a subscription and shows its secret once', async () => {
    render(<EventSubscriptions />);
    await until(() => host.textContent!.includes('No subscriptions.'), 'the empty list');
    click(button('Add subscription'));
    type(input('URL'), 'https://example.com/events');
    act(() => host.querySelector('form')!.requestSubmit());
    expect(host.textContent).toContain('Pick at least one event.');
    click(input('routine.ran'));
    click(input('run.failed'));
    server.subscriptions = [subscription];
    server.issued = { secret: 'obs_secret' };
    act(() => host.querySelector('form')!.requestSubmit());
    await until(() => !!host.querySelector('[data-shown-once]'), 'the secret');
    expect(sent('POST', '/event-subscriptions')!.body).toEqual({
      url: 'https://example.com/events',
      events: ['run.failed', 'routine.ran'],
    });
    expect(input('Signing secret').value).toBe('obs_secret');
    expect(host.textContent).toContain('A Routine ran');
    // Only an admin is offered a receiver on their own network (S-8).
    expect(host.textContent).not.toContain('Runs on my network');
  });

  it('lets an admin mark a receiver as on their own network', async () => {
    render(<EventSubscriptions admin />);
    await until(() => !!button('Add subscription'), 'the empty list');
    click(button('Add subscription'));
    type(input('URL'), 'http://n8n:5678/webhook/openbots');
    click(input('run.failed'));
    click(host.querySelector('input[name="local"]'));
    server.subscriptions = [
      { ...subscription, url: 'http://n8n:5678/webhook/openbots', local: true },
    ];
    act(() => host.querySelector('form')!.requestSubmit());
    await until(() => !!sent('POST', '/event-subscriptions'), 'create');
    expect(sent('POST', '/event-subscriptions')!.body).toEqual({
      url: 'http://n8n:5678/webhook/openbots',
      events: ['run.failed'],
      local: true,
    });
    await until(() => !!host.querySelector('[data-subscription]'), 'the list');
    expect(host.querySelector('[data-subscription]')!.textContent).toContain('Runs on my network');
  });

  it('pauses a subscription', async () => {
    server.subscriptions = [subscription];
    render(<EventSubscriptions />);
    await until(() => !!host.querySelector('[data-subscription]'), 'the list');
    click(button('Pause'));
    await until(() => !!sent('PATCH', `/event-subscriptions/${SUBSCRIPTION}`), 'pause');
    expect(sent('PATCH', `/event-subscriptions/${SUBSCRIPTION}`)!.body).toEqual({
      enabled: false,
    });
  });
});
