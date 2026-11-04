import { DEFAULT_LIMITS } from '@openbots/shared';
import { Dialog } from '@openbots/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterContextProvider, RouterProvider } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { meQuery } from '../../app/api.js';
import { NewFlow } from '../../app/new-dialog.js';
import { createAppRouter } from '../../app/router.js';
import { me } from '../../test-utils.js';
import { memoriesQuery } from '../memory/memory-tab.js';
import { DESCRIPTION_HELP, MAIN_BOT_HELP } from './bot-settings.js';
import { createBotBody, startingAvatar } from './create.js';
import {
  applyBotState,
  botsQuery,
  hoverAction,
  rosterSections,
  takenAvatars,
  type Bot,
} from './queries.js';

let n = 0;
function bot(name: string, fields: Partial<Bot> = {}): Bot {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  return {
    id,
    handle: name.toLowerCase(),
    name,
    label: null,
    description: '',
    avatar: { kind: 'generated', seed: name },
    modelConfig: null,
    toolPolicy: {},
    pinned: false,
    hidden: false,
    isMain: false,
    chatId: id,
    state: {
      botId: id,
      state: 'idle',
      currentAction: null,
      runId: null,
      updatedAt: '2026-10-16T00:00:00.000Z',
    },
    createdAt: `2026-10-16T00:00:${String(n).padStart(2, '0')}.000Z`,
    updatedAt: '2026-10-16T00:00:00.000Z',
    ...fields,
  };
}

function seeded(items: Bot[], extra: [readonly unknown[], unknown][] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(meQuery.queryKey, { ...me('member'), limits: DEFAULT_LIMITS });
  queryClient.setQueryData(botsQuery.queryKey, { items });
  for (const [key, data] of extra) queryClient.setQueryData(key, data);
  return queryClient;
}

/** Renders a path through the real route tree with the queries already answered. */
async function renderPath(path: string, queryClient: QueryClient) {
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function renderInRouter(node: ReactNode) {
  const queryClient = seeded([]);
  const router = createAppRouter(queryClient, createMemoryHistory());
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <RouterContextProvider router={router}>
        {/* The flow's titles need a Dialog; its content would portal away. */}
        <Dialog open>{node}</Dialog>
      </RouterContextProvider>
    </QueryClientProvider>,
  );
}

const order = (html: string, names: string[]) =>
  names.map((name) => html.indexOf(`>${name}</span>`));

describe('roster', () => {
  const ada = bot('Ada');
  const grace = bot('Grace', { pinned: true });
  const linus = bot('Linus', { hidden: true });
  const margaret = bot('Margaret');

  it('puts pinned Bots first, keeps oldest first, and sets hidden Bots apart', () => {
    const roster = rosterSections([margaret, linus, grace, ada]);
    expect(roster.pinned.map((b) => b.name)).toEqual(['Grace']);
    expect(roster.bots.map((b) => b.name)).toEqual(['Ada', 'Margaret']);
    expect(roster.hidden.map((b) => b.name)).toEqual(['Linus']);
  });

  it('renders the sections in order with hidden Bots left out of the sidebar', async () => {
    const html = await renderPath('/', seeded([ada, grace, linus, margaret]));
    const [pinned, bots, groups] = ['Pinned', 'Bots', 'Groups'].map((h) =>
      html.indexOf(`>${h}</h2>`),
    );
    const [g, a, m] = order(html, ['Grace', 'Ada', 'Margaret']);
    expect(pinned).toBeLessThan(g!);
    expect(g).toBeLessThan(bots!);
    expect(bots).toBeLessThan(a!);
    expect(a).toBeLessThan(m!);
    expect(m).toBeLessThan(groups!);
    expect(html).not.toContain('>Linus</span>');
    expect(html).toContain('Show hidden (1)');
    expect(html).toContain(`href="/bots/${ada.id}"`);
  });

  it('shows no hidden toggle when nothing is hidden', async () => {
    const html = await renderPath('/', seeded([ada]));
    expect(html).not.toContain('Show hidden');
  });

  it('shows each empty section its empty state', async () => {
    const html = await renderPath('/', seeded([]));
    for (const empty of ['Pinned Bots appear here.', 'No Bots yet.', 'No groups yet.']) {
      expect(html).toContain(empty);
    }
  });

  it('shows the current action on hover while working, waiting or blocked (I3)', () => {
    const state = (s: Bot['state']['state'], currentAction: string | null) => ({
      state: s,
      currentAction,
    });
    expect(hoverAction(state('working', 'Running npm test'))).toBe('Running npm test');
    expect(hoverAction(state('waiting', 'Waiting for approval: send email'))).toBe(
      'Waiting for approval: send email',
    );
    expect(hoverAction(state('blocked', 'GitHub needs login'))).toBe('GitHub needs login');
    for (const quiet of ['idle', 'thinking', 'done'] as const) {
      expect(hoverAction(state(quiet, 'Ran npm test'))).toBeNull();
    }
  });

  it('drives the row avatar from the Bot state, and bot.state events update it', async () => {
    const event = {
      type: 'bot.state' as const,
      ts: Date.parse('2026-10-16T01:00:00.000Z'),
      bot_id: ada.id,
      payload: {
        botId: ada.id,
        state: 'working' as const,
        currentAction: 'Running npm test',
        runId: null,
      },
    };
    const items = applyBotState([ada, margaret], event);
    expect(items[0]!.state).toMatchObject({ state: 'working', currentAction: 'Running npm test' });
    expect(items[1]).toBe(margaret);

    const html = await renderPath('/', seeded(items));
    expect(html).toMatch(
      /role="img" aria-label="Ada"[^>]*data-state="working"|data-state="working"[^>]*aria-label="Ada"/,
    );
    expect(html).toMatch(
      /data-state="idle"[^>]*aria-label="Margaret"|aria-label="Margaret"[^>]*data-state="idle"/,
    );
  });
});

describe('New', () => {
  it('asks for a name and an icon, and offers New chat once there are two Bots', () => {
    const html = renderInRouter(<NewFlow onDone={() => {}} />);
    expect(html).toContain('New Bot');
    expect(html).toContain('aria-label="Bot name"');
    expect(html).toContain('aria-label="Icon preview"');
    for (const shape of ['Moon', 'Box', 'Egg']) expect(html).toContain(`title="${shape}"`);
    expect(html).toContain('>Shuffle</button>');
    expect(html).toContain('>Create</button>');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>New chat/);
    expect(html).toContain('needs two Bots');
    expect(html).not.toMatch(/template|schedul|<textarea|<select/i);
  });

  it('creates from the name and the picked icon alone', () => {
    const avatar = { kind: 'generated' as const, seed: 's', shape: 'blob' };
    expect(createBotBody('  Finance ', avatar)).toEqual({ name: 'Finance', avatar });
  });

  it('starts on a Bot shape with an avatar unlike the rest of the roster', () => {
    const taken = takenAvatars([
      bot('Ada'),
      bot('Pic', { avatar: { kind: 'upload', file_id: 'x' } }),
    ]);
    expect(taken).toHaveLength(1);
    const avatar = startingAvatar(taken, 'seed');
    expect(avatar).toEqual({ kind: 'generated', seed: expect.any(String), shape: avatar.shape });
    expect(['bean', 'rounded', 'blob']).toContain(avatar.shape);
  });
});

describe('Bot view', () => {
  const ada = bot('Ada', { label: 'Chief of Staff' });

  it('shows the title bar and the five tabs', async () => {
    const html = await renderPath(`/bots/${ada.id}`, seeded([ada]));
    expect(html).toContain('>Ada</h1>');
    expect(html).toContain('Chief of Staff');
    for (const tab of ['Chat', 'Routines', 'Artifacts', 'Memory', 'Settings']) {
      expect(html).toContain(`>${tab}</a>`);
    }
    expect(html).not.toContain('aria-pressed');
  });

  it('centres the tabs in their bar, marks the open one, and scrolls the tab below', async () => {
    const html = await renderPath(`/bots/${ada.id}/routines`, seeded([ada]));
    // The middle of three columns, so the tabs stay centred whatever sits beside them.
    expect(html).toMatch(/data-slot="bot-tabs" class="grid grid-cols-\[1fr_auto_1fr\][^"]*"/);
    expect(html).toMatch(/role="tablist" class="col-start-2 /);
    const tab = (label: string) => html.match(new RegExp(`<a [^>]*>${label}</a>`))![0];
    expect(tab('Routines')).toContain('data-status="active"');
    expect(tab('Routines')).toContain('aria-selected="true"');
    expect(tab('Routines')).toContain('data-[status=active]:text-foreground');
    expect(tab('Chat')).not.toContain('data-status="active"');
    expect(html).toContain('class="relative min-h-0 flex-1 overflow-auto"');
  });

  it('shows the profile fields with the description guidance in Settings', async () => {
    const html = await renderPath(`/bots/${ada.id}/settings`, seeded([ada]));
    expect(html).toContain(DESCRIPTION_HELP);
    for (const text of ['Name', 'Label', 'Avatar', 'Model', 'Duplicate', 'Removes the profile']) {
      expect(html).toContain(text);
    }
  });

  it('offers the main Bot toggle in Settings, and no roster badge (K8)', async () => {
    const lead = bot('Lead', { isMain: true });
    const html = await renderPath(`/bots/${ada.id}/settings`, seeded([ada, lead]));
    expect(html).toContain('>Main Bot</span>');
    expect(html).toContain(MAIN_BOT_HELP);
    expect(html).toContain('Replaces @lead as your main Bot.');
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);

    const own = await renderPath(`/bots/${lead.id}/settings`, seeded([ada, lead]));
    expect(own).toMatch(/type="checkbox"[^>]*checked/);
    expect(own).not.toContain('as your main Bot.');

    const roster = await renderPath(`/bots/${ada.id}`, seeded([ada, lead]));
    expect(roster).not.toContain('Main Bot');
  });

  it('groups memories by kind with the staleness note', async () => {
    const memory = (kind: string, content: string) => ({
      id: `m-${content}`,
      botId: ada.id,
      kind,
      content,
      sourceRunId: null,
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
    });
    const html = await renderPath(
      `/bots/${ada.id}/memory`,
      seeded(
        [ada],
        [
          [
            memoriesQuery(ada.id).queryKey,
            {
              items: [
                memory('summary', 'Closed Q3'),
                memory('preference', 'Bullets please'),
                memory('fact', 'Fiscal year starts in April'),
              ],
            },
          ],
        ],
      ),
    );
    expect(html).toContain('Memory can be stale');
    const positions = [
      'Preferences',
      'Bullets please',
      'Facts',
      'Fiscal year',
      'Summaries',
      'Closed Q3',
    ].map((text) => html.indexOf(text));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
