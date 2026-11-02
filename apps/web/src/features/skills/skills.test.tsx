// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchSkills, type Skill } from './api.js';
import { BotSkillsForm } from './bot-skills.js';
import { SkillEditor, SkillList, usedByText } from './skills-page.js';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    requests: [] as { method: string; path: string; body: unknown }[],
    reply: null as null | Response,
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    const text = request.method === 'GET' ? '' : await request.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    state.requests.push({ method: request.method, path, body });
    if (state.reply) return state.reply;
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    if (path.endsWith('/skills') && request.method === 'PUT') return Response.json(body);
    return Response.json({ id: 'new-1', usedBy: [], ...body }, { status: 201 });
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
  server.reply = null;
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

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement : HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const field = (label: string) =>
  host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text);
const click = (text: string) => act(async () => button(text)!.click());
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const skill = (overrides: Partial<Skill> = {}): Skill => ({
  id: 's1',
  name: 'Weekly report',
  slug: 'weekly-report',
  summary: 'Fridays',
  content: 'Fridays.\n\n1. Collect',
  source: 'manual',
  createdFromRunId: null,
  origin: null,
  usedBy: [],
  createdAt: '2026-10-18T00:00:00.000Z',
  updatedAt: '2026-10-18T00:00:00.000Z',
  ...overrides,
});

describe('<SkillEditor>', () => {
  it('writes a new Skill from a name and content', async () => {
    const saved = vi.fn();
    render(<SkillEditor onSaved={saved} onClose={vi.fn()} />);
    expect(button('Create')!.disabled).toBe(true);
    type(field('Name'), 'Triage');
    type(field('Content'), 'A new issue arrives.\n\n1. Label it');
    expect(button('Create')!.disabled).toBe(false);
    await act(async () => host.querySelector('form')!.requestSubmit());
    await settle();

    expect(server.requests).toEqual([
      {
        method: 'POST',
        path: '/api/v1/skills',
        body: { name: 'Triage', content: 'A new issue arrives.\n\n1. Label it' },
      },
    ]);
    expect(saved).toHaveBeenCalledOnce();
  });

  it('edits the name and content of a Skill', async () => {
    render(<SkillEditor skill={skill()} onClose={vi.fn()} />);
    expect(field('Content').value).toBe('Fridays.\n\n1. Collect');
    type(field('Content'), 'Fridays.\n\n1. Collect\n2. Summarize');
    await click('Save');
    await settle();
    expect(server.requests.at(-1)).toEqual({
      method: 'PATCH',
      path: '/api/v1/skills/s1',
      body: { name: 'Weekly report', content: 'Fridays.\n\n1. Collect\n2. Summarize' },
    });
  });

  it('says where an imported Skill came from', () => {
    render(
      <SkillEditor
        skill={skill({
          source: 'imported',
          origin: {
            kind: 'github',
            url: 'https://github.com/acme/skills',
            permalink: 'https://github.com/acme/skills/blob/abc/pdf/SKILL.md',
            repo: 'acme/skills',
            ref: 'main',
            sha: 'abcdef1234567890abcdef1234567890abcdef12',
            path: 'pdf/SKILL.md',
            license: 'MIT',
            importedAt: '2026-10-18T00:00:00.000Z',
          },
        })}
        onClose={vi.fn()}
      />,
    );
    expect(host.textContent).toContain(
      'Imported from acme/skills/pdf/SKILL.md at main (abcdef1). License: MIT. Read it before you enable it.',
    );
  });

  it('shows what the server refused', async () => {
    server.reply = Response.json(
      {
        type: 'about:blank',
        status: 400,
        title: 'Name is too long',
        code: 'VALIDATION_FAILED',
      },
      { status: 400, headers: { 'content-type': 'application/problem+json' } },
    );
    render(<SkillEditor skill={skill()} onClose={vi.fn()} />);
    await click('Save');
    await settle();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Name is too long');
  });

  it('asks once more before deleting', async () => {
    const close = vi.fn();
    render(
      <SkillEditor
        skill={skill({ usedBy: [{ id: 'b1', name: 'Ada', handle: 'ada' }] })}
        onClose={close}
      />,
    );
    expect(host.textContent).toContain('Used by Ada');
    await click('Delete');
    expect(server.requests).toEqual([]);
    await click('Delete for every Bot');
    await settle();
    expect(server.requests).toEqual([{ method: 'DELETE', path: '/api/v1/skills/s1', body: null }]);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('Skills library', () => {
  it('lists each Skill with its summary and the Bots that use it', () => {
    const open = vi.fn();
    render(
      <SkillList
        skills={[
          skill({ usedBy: [{ id: 'b1', name: 'Ada', handle: 'ada' }] }),
          skill({ id: 's2', name: 'Triage', summary: '' }),
        ]}
        onOpen={open}
      />,
    );
    const rows = [...host.querySelectorAll('li')].map((li) => li.textContent);
    expect(rows).toEqual(['Weekly reportFridaysUsed by Ada', 'TriageNot enabled for any Bot']);
    act(() => host.querySelectorAll('button')[1]!.click());
    expect(open).toHaveBeenCalledWith('s2');
  });

  it('words "used by" and matches the / query', () => {
    expect(usedByText([])).toBe('Not enabled for any Bot');
    expect(usedByText([{ name: 'Ada' }, { name: 'Bo' }, { name: 'Cy' }])).toBe(
      'Used by Ada, Bo and Cy',
    );
    const ada = [{ id: 'b1', name: 'Ada', handle: 'ada' }];
    const list = [
      skill({ name: 'Zeta', slug: 'zeta', usedBy: ada }),
      skill({ name: 'Weekly report', slug: 'weekly-report', usedBy: ada }),
      skill({ name: 'Alpha week', slug: 'alpha-week', usedBy: ada }),
      skill({ name: 'Other week', slug: 'other-week' }),
    ];
    // Only Skills enabled for one of the chat's Bots (S2).
    expect(matchSkills(list, 'WEEK', ['b1']).map((s) => s.name)).toEqual([
      'Alpha week',
      'Weekly report',
    ]);
    expect(matchSkills(list, '', ['b1']).map((s) => s.name)).toEqual([
      'Alpha week',
      'Weekly report',
      'Zeta',
    ]);
    expect(matchSkills(list, '', ['b2'])).toEqual([]);
  });
});

describe('<BotSkillsForm>', () => {
  it("replaces the Bot's enabled Skills", async () => {
    render(
      <BotSkillsForm
        botId="b1"
        skills={[skill(), skill({ id: 's2', name: 'Triage' })]}
        enabled={['s1']}
      />,
    );
    expect(button('Save Skills')!.disabled).toBe(true);
    const boxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect([...boxes].map((b) => b.checked)).toEqual([true, false]);
    act(() => boxes[0]!.click());
    act(() => boxes[1]!.click());
    await click('Save Skills');
    await settle();
    expect(server.requests).toEqual([
      { method: 'PUT', path: '/api/v1/bots/b1/skills', body: { skillIds: ['s2'] } },
    ]);
  });
});
