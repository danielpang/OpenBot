// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Provider, ProviderPreset } from '../models/api.js';
import { ProviderKey } from './setup-wizard.js';

// The setup wizard's key row (L1): "Save and test" saves the key and tests
// it; once the test passes a check mark takes the button's place until the
// key is edited again. A failed test keeps the button and says why, and a
// saved key shows its hint (P3) in the empty field.

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    /** The test's outcome: `ok`, or an error message. */
    outcome: 'ok' as string,
    /** While set, the test waits for it before the server answers. */
    hold: null as Promise<void> | null,
    saved: [] as unknown[],
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    if (request.method === 'GET') return Response.json({ items: [] });
    if (path.endsWith('/test')) {
      await state.hold;
      const ok = state.outcome === 'ok';
      return Response.json(
        provider({
          status: ok ? 'ok' : 'error',
          testResult: {
            model_id: 'claude-x',
            streaming: ok,
            tools: ok,
            latency_ms: 300,
            error: ok ? null : state.outcome,
          },
        }),
      );
    }
    state.saved.push(await request.json());
    return Response.json(provider({}), { status: request.method === 'POST' ? 201 : 200 });
  };
  function provider(overrides: Partial<Provider>): Provider {
    return {
      id: '00000000-0000-4000-8000-0000000000a1',
      name: 'Anthropic',
      slug: 'anthropic',
      kind: 'anthropic',
      protocol: 'native',
      baseUrl: null,
      local: false,
      headers: [],
      hasKey: true,
      keyHint: 'sk-ant-…a1b2',
      discovery: 'manual',
      presetId: 'anthropic',
      status: 'untested',
      lastTestedAt: null,
      testResult: null,
      scope: 'organization',
      smallModelId: null,
      botCount: 0,
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
      ...overrides,
    };
  }
  return Object.assign(state, { provider });
});

afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const preset: ProviderPreset = {
  id: 'anthropic',
  name: 'Anthropic',
  kind: 'anthropic',
  protocol: 'native',
  baseUrl: null,
  keyRequired: true,
  discovery: 'manual',
  notes: null,
  models: [],
};

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  server.outcome = 'ok';
  server.hold = null;
  server.saved = [];
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
  act(() => root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>));
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  if (check()) return;
  throw new Error(`timed out waiting for ${what}: ${host.innerHTML}`);
}

const field = () => host.querySelector<HTMLInputElement>('input[name="apiKey"]')!;
const button = () => host.querySelector<HTMLButtonElement>('button[type="submit"]');
const check = () => host.querySelector('[role="img"][aria-label="Key works"]');

/** Types into the key field as React sees it. */
function type(value: string) {
  act(() => {
    const input = field();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function saveAndTest() {
  act(() => host.querySelector('form')!.requestSubmit());
}

describe('the setup key row', () => {
  it('swaps Save and test for a check mark once the key works, and back on edit (L1)', async () => {
    render(<ProviderKey preset={preset} />);
    expect(field().placeholder).toBe('API key');
    expect(button()!.textContent).toBe('Save and test');
    expect(check()).toBeNull();

    let answer!: () => void;
    server.hold = new Promise((resolve) => (answer = resolve));
    type('sk-ant-api03-0123456789abcdef-a1b2');
    saveAndTest();
    // Pending: a spinner on the button, which cannot be pressed again.
    await until(() => button()?.disabled === true, 'the pending button');
    expect(button()!.textContent).toBe('Testing…');
    expect(button()!.querySelector('[role="status"]')).not.toBeNull();

    act(() => answer());
    await until(() => check() !== null, 'the check mark');
    expect(button()).toBeNull();
    expect(check()!.querySelector('svg')!.getAttribute('class')).toContain('size-5');
    expect(check()!.className).toContain('text-success');
    expect(host.textContent).not.toContain('The key works');
    expect(server.saved).toEqual([
      { presetId: 'anthropic', apiKey: 'sk-ant-api03-0123456789abcdef-a1b2' },
    ]);

    type('sk-ant-api03-another');
    expect(check()).toBeNull();
    expect(button()!.textContent).toBe('Save and test');
  });

  it('keeps the button and says why when the key fails its test', async () => {
    server.outcome = 'Streaming failed: 401 invalid x-api-key';
    render(<ProviderKey preset={preset} />);
    type('sk-ant-wrong-0123456789');
    saveAndTest();
    await until(() => host.textContent!.includes('401 invalid x-api-key'), 'the failure to show');
    expect(host.textContent).toContain(
      'The key did not work: Streaming failed: 401 invalid x-api-key',
    );
    expect(button()!.textContent).toBe('Save and test');
    expect(check()).toBeNull();
  });

  it('shows the saved key by its hint, and a check mark when its last test passed (P3)', () => {
    render(<ProviderKey preset={preset} provider={server.provider({ status: 'ok' })} />);
    expect(field().placeholder).toBe('sk-ant-…a1b2 saved');
    expect(field().value).toBe('');
    expect(check()).not.toBeNull();
    expect(host.innerHTML).not.toContain('The key works');
  });

  it('says a key is set when the server sends no hint', () => {
    render(
      <ProviderKey
        preset={preset}
        provider={server.provider({ keyHint: null, status: 'error' })}
      />,
    );
    expect(field().placeholder).toBe('Key set (from .env or earlier)');
    expect(button()!.textContent).toBe('Save and test');
  });
});
