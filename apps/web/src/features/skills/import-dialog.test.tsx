// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Skill, SkillImportPreview } from './api.js';
import { SkillsPage } from './skills-page.js';

// The "Import from GitHub" flow on the Skills page (S3), against a fake API:
// a link, the Skills found, the picks and names, then the import.

const SHA = 'ca45fc496a3436251f191354091d557da31c15b5';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    requests: [] as { method: string; path: string; body: unknown }[],
    library: [] as unknown[],
    preview: null as unknown,
    previewError: null as null | { status: number; problem: unknown },
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    const text = request.method === 'GET' ? '' : await request.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    state.requests.push({ method: request.method, path, body });
    if (path === '/api/v1/skills' && request.method === 'GET') {
      return Response.json({ items: state.library });
    }
    if (path === '/api/v1/skills/import/preview') {
      if (state.previewError) {
        return Response.json(state.previewError.problem, {
          status: state.previewError.status,
          headers: { 'content-type': 'application/problem+json' },
        });
      }
      return Response.json(state.preview);
    }
    if (path === '/api/v1/skills/import') {
      const picked = (body as { skills: { path: string; name: string }[] }).skills;
      const items = picked.map((s, i) => ({
        skill: { ...(state.library[0] as object), id: `imported-${i}`, name: s.name },
        path: s.path,
      }));
      state.library = items.map((item) => item.skill);
      return Response.json({ items }, { status: 201 });
    }
    return new Response(null, { status: 404 });
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
  server.library = [];
  server.previewError = null;
  server.preview = preview();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const skill = (overrides: Partial<Skill> = {}): Skill => ({
  id: 's1',
  name: 'internal-comms',
  slug: 'internal-comms',
  summary: 'Internal communications',
  content: 'Internal communications.\n\n1. Write',
  source: 'imported',
  createdFromRunId: null,
  origin: {
    kind: 'github',
    url: 'https://github.com/anthropics/skills',
    permalink: `https://github.com/anthropics/skills/blob/${SHA}/skills/internal-comms/SKILL.md`,
    repo: 'anthropics/skills',
    ref: 'main',
    sha: SHA,
    path: 'skills/internal-comms/SKILL.md',
    license: 'Complete terms in LICENSE.txt',
    importedAt: '2026-10-30T00:00:00.000Z',
  },
  usedBy: [],
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
  ...overrides,
});

function preview(overrides: Partial<SkillImportPreview> = {}): SkillImportPreview {
  return {
    source: {
      url: 'https://github.com/anthropics/skills',
      repo: 'anthropics/skills',
      ref: 'main',
      sha: SHA,
      path: '',
    },
    skills: [
      {
        path: 'skills/internal-comms/SKILL.md',
        name: 'internal-comms',
        suggestedName: 'internal-comms (2)',
        description: 'Write internal communications.',
        error: null,
      },
      {
        path: 'skills/webapp-testing/SKILL.md',
        name: 'webapp-testing',
        suggestedName: 'webapp-testing',
        description: 'Test local web applications.',
        error: null,
      },
      {
        path: 'big/SKILL.md',
        name: 'big',
        suggestedName: 'big',
        description: '',
        error: 'SKILL.md is larger than 256 KB',
      },
    ],
    more: false,
    authenticated: false,
    room: 10,
    limit: 200,
    ...overrides,
  };
}

const page = () => document.body;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const button = (text: string) =>
  [...page().querySelectorAll('button')].find((b) => b.textContent === text);
const click = async (text: string) => {
  const found = button(text);
  expect(found, text).toBeDefined();
  await act(async () => found!.click());
  await settle();
};
const field = (label: string) => page().querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
function type(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function toggle(el: HTMLInputElement) {
  act(() => el.click());
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <SkillsPage />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

async function findSkills(url = 'https://github.com/anthropics/skills') {
  await click('Import from GitHub');
  expect(page().textContent).toContain('Link a GitHub repository, folder or SKILL.md file.');
  expect(button('Find Skills')!.disabled).toBe(true);
  type(field('GitHub link'), url);
  await act(async () =>
    page().querySelector<HTMLFormElement>('form[aria-label="Import from GitHub"]')!.requestSubmit(),
  );
  await settle();
}

describe('Import from GitHub', () => {
  it('finds the Skills at a link, imports the picked one and opens it', async () => {
    server.library = [skill()];
    await render();
    await findSkills();
    expect(server.requests.at(-1)).toEqual({
      method: 'POST',
      path: '/api/v1/skills/import/preview',
      body: { url: 'https://github.com/anthropics/skills' },
    });

    const text = page().textContent!;
    expect(text).toContain('Found 3 Skills in anthropics/skills at main. Pick the ones to import.');
    expect(text).toContain('Your library already has a Skill named internal-comms.');
    expect(text).toContain('SKILL.md is larger than 256 KB');
    expect(text).toContain('Your library has room for 10 more Skills (limit 200).');
    // The importable Skills start ticked; the one that cannot be read cannot be.
    expect(field('Import skills/internal-comms/SKILL.md').checked).toBe(true);
    expect(field('Import skills/webapp-testing/SKILL.md').checked).toBe(true);
    expect(field('Import big/SKILL.md').disabled).toBe(true);
    expect(field('Name for skills/internal-comms/SKILL.md').value).toBe('internal-comms (2)');

    // Rename one, leave the other out.
    type(field('Name for skills/internal-comms/SKILL.md'), 'Company comms');
    toggle(field('Import skills/webapp-testing/SKILL.md'));
    await click('Import 1 Skill');

    expect(server.requests.find((r) => r.path === '/api/v1/skills/import')).toEqual({
      method: 'POST',
      path: '/api/v1/skills/import',
      body: {
        url: 'https://github.com/anthropics/skills',
        ref: 'main',
        sha: SHA,
        skills: [{ path: 'skills/internal-comms/SKILL.md', name: 'Company comms' }],
      },
    });
    // One imported Skill opens in the editor, with where it came from.
    await settle();
    expect(host.querySelector('form[aria-label="Skill editor"]')).not.toBeNull();
    expect(field('Name').value).toBe('Company comms');
    expect(host.textContent).toContain(
      `Imported from anthropics/skills/skills/internal-comms/SKILL.md at main (${SHA.slice(0, 7)}).`,
    );
    const link = host.querySelector<HTMLAnchorElement>('a[href*="blob"]')!;
    expect(link.href).toBe(skill().origin!.permalink);
    expect(link.rel).toBe('noreferrer');
  });

  it('closes after importing several Skills', async () => {
    server.library = [skill()];
    await render();
    await findSkills();
    await click('Import 2 Skills');
    expect(page().querySelector('form[aria-label="Import from GitHub"]')).toBeNull();
    expect(host.querySelector('form[aria-label="Skill editor"]')).toBeNull();
    expect(host.querySelectorAll('ul[aria-label="Skills"] li')).toHaveLength(2);
  });

  it("will not import more than the library's room", async () => {
    server.preview = preview({ room: 1 });
    await render();
    await findSkills();
    expect(field('Import skills/internal-comms/SKILL.md').checked).toBe(true);
    expect(field('Import skills/webapp-testing/SKILL.md').checked).toBe(false);
    expect(button('Import 1 Skill')!.disabled).toBe(false);
    toggle(field('Import skills/webapp-testing/SKILL.md'));
    expect(page().textContent).toContain(
      'Your library has room for 1 more Skill (limit 200). Pick fewer to import.',
    );
    expect(button('Import 2 Skills')!.disabled).toBe(true);
    // An emptied name blocks the import too.
    toggle(field('Import skills/webapp-testing/SKILL.md'));
    type(field('Name for skills/internal-comms/SKILL.md'), '  ');
    expect(button('Import 1 Skill')!.disabled).toBe(true);
  });

  it("shows GitHub's problem, such as the rate limit, and lets the owner try again", async () => {
    server.previewError = {
      status: 429,
      problem: {
        type: 'about:blank',
        status: 429,
        code: 'GITHUB_RATE_LIMITED',
        title:
          'GitHub allows 60 requests an hour without a token, and they are used up. Try again after 14:05 UTC, or add the GitHub connector so imports use your token, which allows more.',
      },
    };
    await render();
    await findSkills();
    expect(page().querySelector('[role="alert"]')!.textContent).toContain(
      'Try again after 14:05 UTC',
    );
    expect(button('Find Skills')!.disabled).toBe(false);

    server.previewError = null;
    server.preview = preview({ skills: [] });
    await click('Find Skills');
    expect(page().textContent).toContain(
      'No SKILL.md files found in anthropics/skills. Link a folder that has one, or a markdown file.',
    );
    await click('Back');
    expect(field('GitHub link').value).toBe('https://github.com/anthropics/skills');
  });
});
