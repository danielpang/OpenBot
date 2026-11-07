// @vitest-environment happy-dom
import { CODING_ROUTINE_TEMPLATES } from '@openbots/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RightPanelProvider } from '../../app/right-panel.js';
import { RoutinesTab } from './routines-tab.js';
import { routineFromTemplate } from './templates.js';

// The coding Routine templates (CA11, F6) against a fake REST server: New
// Routine lists them above the manual form; picking one asks for the
// repository and, for a label trigger, the label, then sends only
// `template` (the server fills name, prompt and trigger) and shows the name
// the server chose.

const BOT = '00000000-0000-4000-8000-0000000000b1';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    requests: [] as { method: string; path: string; body: unknown }[],
    templates: true,
    list: [] as unknown[],
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const { pathname } = new URL(request.url, 'http://localhost');
    const body = request.method === 'GET' ? undefined : await request.text();
    state.requests.push({
      method: request.method,
      path: pathname,
      body: body ? JSON.parse(body) : undefined,
    });
    if (pathname === '/api/v1/routines/templates') {
      return state.templates
        ? Response.json({ templates: state.list })
        : Response.json({ title: 'Not found' }, { status: 404 });
    }
    if (pathname === '/api/v1/repos') {
      return Response.json({
        repos: ['danielpang/OpenBots', 'danielpang/relay'].map((fullName, i) => ({
          id: `r${i}`,
          fullName,
          remoteUrl: `https://github.com/${fullName}.git`,
          defaultBranch: 'main',
          keepCloned: true,
          pinned: false,
          description: null,
          lastUsedAt: null,
          checkout: null,
        })),
      });
    }
    if (pathname.endsWith('/routines') && request.method === 'GET') {
      return Response.json({ items: [] });
    }
    if (pathname.endsWith('/routines') && request.method === 'POST') {
      return Response.json(
        { id: 'rt1', name: 'Fix issues labeled agent in danielpang/relay' },
        {
          status: 201,
        },
      );
    }
    return Response.json({ items: [] });
  };
  return state;
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
beforeEach(() => {
  server.requests = [];
  server.templates = true;
  server.list = [...CODING_ROUTINE_TEMPLATES];
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <RightPanelProvider>
          <RoutinesTab botId={BOT} />
        </RightPanelProvider>
      </QueryClientProvider>,
    ),
  );
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
function type(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  act(() => {
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}
const template = (id: string) => host.querySelector(`[data-template="${id}"]`);
const posted = () =>
  server.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/routines'));

describe('coding Routine templates (CA11)', () => {
  it('lists the templates above the manual form', async () => {
    render();
    click(button('New Routine'));
    await until(() => !!template('weekly-dependency-update'), 'the templates');
    expect(host.textContent).toContain('Start from a template');
    expect(template('fix-labeled-issues')!.textContent).toContain('Fix issues labeled bot');
    expect(template('review-pull-requests')!.textContent).toContain(
      'When a pull request is opened',
    );
    // The manual flow stays.
    expect(host.querySelector('form[aria-label="New Routine"]')).not.toBeNull();
    expect(host.textContent).not.toMatch(/[–—]| - /);
  });

  it('asks for the repository and label, then creates the Routine with the template', async () => {
    render();
    click(button('New Routine'));
    await until(() => !!template('fix-labeled-issues'), 'the templates');
    click(template('fix-labeled-issues'));
    const form = () =>
      host.querySelector<HTMLFormElement>('form[aria-label="New Routine from a template"]')!;
    await until(() => !!form()?.querySelector('select[aria-label="Repository"]'), 'the repos');
    expect(host.querySelector('form[aria-label="New Routine"]')).toBeNull();
    type(form().querySelector('select[aria-label="Repository"]')!, 'danielpang/relay');
    const label = form().querySelector<HTMLInputElement>('input[aria-label="Label"]')!;
    expect(label.value).toBe('bot');
    expect(label.maxLength).toBe(100);
    type(label, 'agent');
    click(button('Create Routine'));
    await until(() => posted().length === 1, 'the create');
    const body = posted()[0]!.body as Record<string, unknown>;
    expect(posted()[0]!.path).toBe(`/api/v1/bots/${BOT}/routines`);
    expect(body.template).toEqual({
      id: 'fix-labeled-issues',
      params: { repo: 'danielpang/relay', label: 'agent' },
    });
    // The server is the authority on the template: nothing it fills is sent.
    expect(Object.keys(body)).toEqual(['template']);
    await until(() => !!host.querySelector('[data-routine-created]'), 'the created name');
    expect(host.querySelector('[data-routine-created]')!.textContent).toBe(
      'Created the Routine Fix issues labeled agent in danielpang/relay.',
    );
    expect(host.querySelector('form[aria-label="New Routine from a template"]')).toBeNull();
  });

  it('asks no label for a template without one, and goes back to the manual form', async () => {
    render();
    click(button('New Routine'));
    await until(() => !!template('review-pull-requests'), 'the templates');
    click(template('review-pull-requests'));
    await until(() => !!host.querySelector('select[aria-label="Repository"]'), 'the repos');
    expect(host.querySelector('input[aria-label="Label"]')).toBeNull();
    click(button('Choose another'));
    expect(host.querySelector('form[aria-label="New Routine"]')).not.toBeNull();
  });

  it('falls back to the built-in templates when the server has no list', async () => {
    server.templates = false;
    render();
    click(button('New Routine'));
    await until(() => !!template('fix-labeled-issues'), 'the built-in templates');
  });

  it('sends only the template id and repository for the weekly template', () => {
    const weekly = CODING_ROUTINE_TEMPLATES.find((t) => t.id === 'weekly-dependency-update')!;
    expect(routineFromTemplate(weekly, { repo: 'o/r', label: 'ignored' })).toEqual({
      template: { id: 'weekly-dependency-update', params: { repo: 'o/r' } },
    });
  });
});
