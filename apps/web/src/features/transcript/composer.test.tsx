// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer, type ComposerProps } from './composer.js';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    posts: [] as { path: string; body: unknown }[],
    skills: [] as unknown[],
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    if (path === '/api/v1/skills') return Response.json({ items: state.skills });
    if (path === '/api/v1/files') {
      const form = await request.formData();
      const file = form.get('file') as File;
      state.posts.push({ path, body: file.name });
      return Response.json(
        {
          id: 'file-1',
          name: file.name,
          mime: file.type,
          size: file.size,
          sha256: '',
          createdAt: '',
        },
        { status: 201 },
      );
    }
    const body = await request.json();
    state.posts.push({ path, body });
    return Response.json({ id: 'm1', seq: 1, parts: [] }, { status: 201 });
  };
  return state;
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = {
  id: 'b1',
  handle: 'ada',
  name: 'Ada',
  avatar: { kind: 'generated' as const, seed: 'ada' },
};

let root: Root;
let host: HTMLElement;
let sent: ReturnType<typeof vi.fn<() => void>>;
const skill = (name: string, slug: string, usedBy = ['b1']) => ({
  id: `skill-${slug}`,
  name,
  slug,
  summary: `When ${name}`,
  usedBy: usedBy.map((id) => ({ id, name: id, handle: id })),
});

let client: QueryClient;
/** Renders the composer on a fresh root and query client, so the Skills are fetched again. */
function mount(props: Partial<ComposerProps> = {}) {
  if (root) act(() => root.unmount());
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <Composer chatId="chat-1" mentionable={[bot]} onSent={sent} {...props} />
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  server.posts.length = 0;
  server.skills = [];
  sent = vi.fn<() => void>();
  host = document.createElement('div');
  document.body.append(host);
  mount();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const textarea = () => host.querySelector('textarea')!;
function type(value: string) {
  act(() => {
    const el = textarea();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.setSelectionRange(value.length, value.length);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const key = (k: string, shiftKey = false) =>
  act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true }));
  });
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
/** The Skills library has reached the composer's query. */
const loaded = () =>
  vi.waitFor(async () => {
    await settle();
    expect(client.getQueryData(['skills', 'list'])).toBeDefined();
  });

describe('<Composer>', () => {
  it('sends on Enter and keeps Shift+Enter for a new line', async () => {
    type('first line');
    await key('Enter', true);
    expect(server.posts).toEqual([]);
    type('first line\nsecond');
    await key('Enter');
    await settle();
    expect(server.posts).toEqual([
      { path: '/api/v1/chats/chat-1/messages', body: { text: 'first line\nsecond' } },
    ]);
    expect(sent).toHaveBeenCalledOnce();
    expect(textarea().value).toBe('');
  });

  it('opens the Bot mention picker on @ and inserts the handle', async () => {
    type('hi @a');
    const listbox = host.querySelector('[role="listbox"]')!;
    expect(listbox.getAttribute('aria-label')).toBe('Mention a Bot');
    expect(listbox.textContent).toContain('@ada');
    await key('Enter');
    expect(textarea().value).toBe('hi @ada ');
    expect(server.posts).toEqual([]);
  });

  it('opens an empty Skills picker on / when the library is empty', async () => {
    await settle();
    type('/');
    expect(host.querySelector('[role="listbox"]')!.textContent).toBe('No Skills yet');
  });

  it('picks a Skill with / and sends it as the message reference', async () => {
    server.skills = [
      skill('Weekly report', 'weekly-report'),
      skill('Release notes', 'release-notes'),
      // Not offered: a Skill only another Bot has enabled (S2), or none.
      skill('Elsewhere', 'elsewhere', ['b2']),
      skill('Unused', 'unused', []),
    ];
    mount();
    await loaded();
    type('/');
    const listbox = host.querySelector('[role="listbox"]')!;
    expect(listbox.getAttribute('aria-label')).toBe('Skills');
    expect([...listbox.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
      'Release notesWhen Release notes',
      'Weekly reportWhen Weekly report',
    ]);
    type('please /rel');
    await key('Enter');
    expect(textarea().value).toBe('please ');
    expect(host.textContent).toContain('/release-notes');
    expect(host.querySelector('[role="listbox"]')).toBeNull();

    await key('Enter');
    await settle();
    expect(server.posts).toEqual([
      {
        path: '/api/v1/chats/chat-1/messages',
        body: { text: 'please ', skillId: 'skill-release-notes' },
      },
    ]);
    expect(host.textContent).not.toContain('/release-notes');
  });

  it('offers the Skills enabled for any Bot of a group', async () => {
    server.skills = [
      skill('Mine', 'mine'),
      skill('Theirs', 'theirs', ['b2']),
      skill('Nobody', 'nobody', []),
    ];
    const grace = { ...bot, id: 'b2', handle: 'grace', name: 'Grace' };
    mount({ mentionable: [bot, grace], everyone: true });
    await loaded();
    type('/');
    const names = [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(names).toEqual(['MineWhen Mine', 'TheirsWhen Theirs']);
  });

  it('says how to get a Skill into / when none is usable here', async () => {
    server.skills = [skill('Unused', 'unused', [])];
    mount();
    await loaded();
    type('/');
    expect(host.querySelector('[role="listbox"]')!.textContent).toBe(
      "No Skills are enabled here. Enable one in a Bot's Settings.",
    );
  });

  it('sends a Skill alone and drops it on remove', async () => {
    server.skills = [skill('Weekly report', 'weekly-report')];
    mount();
    await loaded();
    type('/week');
    await key('Tab');
    expect(textarea().value).toBe('');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Remove Skill Weekly report"]')!.click(),
    );
    expect(host.textContent).not.toContain('/weekly-report');
    type('/week');
    await key('Enter');
    await key('Enter');
    await settle();
    expect(server.posts).toEqual([
      { path: '/api/v1/chats/chat-1/messages', body: { skillId: 'skill-weekly-report' } },
    ]);
  });

  it('closes a picker on Escape', async () => {
    type('@zz');
    expect(host.querySelector('[role="listbox"]')!.textContent).toBe('No Bots match');
    await key('Escape');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('notes links in the draft', () => {
    type('see https://example.com/page and https://docs.example.org');
    expect(host.textContent).toContain('Links: example.com, docs.example.org');
  });

  it('uploads a pasted image and sends its id as an attachment', async () => {
    const file = new File(['png'], 'shot.png', { type: 'image/png' });
    await act(async () => {
      const paste = new Event('paste', { bubbles: true }) as Event & {
        clipboardData: unknown;
      };
      paste.clipboardData = { files: [file], getData: () => '' };
      textarea().dispatchEvent(paste);
    });
    await settle();
    expect(server.posts[0]).toEqual({ path: '/api/v1/files', body: 'shot.png' });
    expect(host.textContent).toContain('shot.png');
    await key('Enter');
    await settle();
    expect(server.posts[1]).toEqual({
      path: '/api/v1/chats/chat-1/messages',
      body: { attachments: ['file-1'] },
    });
  });
});

describe('<Composer> in a group', () => {
  const grace = { id: 'b2', handle: 'grace', name: 'Grace', avatar: bot.avatar };
  const linus = { id: 'b3', handle: 'linus', name: 'Linus', avatar: bot.avatar };
  beforeEach(() => {
    mount({ chatId: 'group-1', mentionable: [bot, grace], everyone: true, addable: [linus] });
  });
  const options = () => [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent);

  it('offers the members, @everyone, then Bots a mention adds to the group', () => {
    type('@');
    expect(options()).toEqual([
      'Ada@ada',
      'Grace@grace',
      '@everyoneEvery Bot in the group',
      'Linus@linusAdds to the group',
    ]);
    type('@e');
    expect(options()).toEqual(['@everyoneEvery Bot in the group']);
  });

  it('inserts @everyone and a handle at the caret, then sends the mentions as text', async () => {
    type('@ev');
    await key('Enter');
    expect(textarea().value).toBe('@everyone ');
    type('@everyone and @li');
    await key('ArrowDown');
    await key('Tab');
    expect(textarea().value).toBe('@everyone and @linus ');
    type('@everyone and @linus please look');
    await key('Enter');
    await settle();
    expect(server.posts).toEqual([
      {
        path: '/api/v1/chats/group-1/messages',
        body: { text: '@everyone and @linus please look' },
      },
    ]);
  });
});
