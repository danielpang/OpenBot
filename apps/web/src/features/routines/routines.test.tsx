// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RightPanelProvider, useRightPanel } from '../../app/right-panel.js';
import { readPanel } from '../transcript/panel.js';
import type { Routine, RoutineRun } from './api.js';
import { lastRunText, nextRunText, RoutinesTab } from './routines-tab.js';
import { DEFAULT_DRAFT, draftFromPreset, presetFromDraft, previewDraft } from './schedule.js';
import { DEFAULT_EVENT_DRAFT, draftFromTrigger, matchFromDraft } from './trigger.js';

// The Bot's Routines tab (R1, R3, R4) against a fake REST server: the list
// with schedule, last and next run, creating one from the preset editor, Run
// now, Pause, and run records that open the activity log; the event trigger
// editor with its narrow matching rule, and a Skill instead of a prompt.

const BOT = '00000000-0000-4000-8000-0000000000b1';
const ROUTINE = '00000000-0000-4000-8000-0000000000c1';
const RUN = '00000000-0000-4000-8000-0000000000d1';
const SKILL = '00000000-0000-4000-8000-0000000000f1';
const ENDPOINT = '00000000-0000-4000-8000-0000000000a1';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    requests: [] as { method: string; path: string; body: unknown }[],
    routines: [] as unknown[],
    runs: [] as unknown[],
    skills: [] as unknown[],
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
    if (pathname === '/api/v1/skills') return Response.json({ items: state.skills });
    if (pathname.endsWith('/endpoints')) return Response.json({ items: [] });
    if (pathname.endsWith('/routines') && request.method === 'GET') {
      return Response.json({ items: state.routines });
    }
    if (pathname.endsWith('/runs')) return Response.json({ items: state.runs });
    if (pathname.endsWith('/run-now')) return Response.json(state.runs[0], { status: 201 });
    if (pathname.endsWith('/routines') && request.method === 'POST') {
      return Response.json(state.routines[0], { status: 201 });
    }
    if (request.method === 'PATCH') return Response.json(state.routines[0]);
    return Response.json({ title: 'Not found' }, { status: 404 });
  };
  return state;
});

function routine(patch: Partial<Routine> = {}): Routine {
  return {
    id: ROUTINE,
    botId: BOT,
    name: 'Morning briefing',
    slug: 'morning-briefing',
    trigger: {
      type: 'schedule',
      cron: '0 8 * * 1-5',
      preset: { kind: 'weekdays', time: '08:00' },
    },
    schedule: 'Weekdays at 08:00 (Europe/London)',
    prompt: 'Summarize my inbox',
    skillId: null,
    chatId: null,
    enabled: true,
    timezone: 'Europe/London',
    nextRunAt: '2026-10-19T07:00:00.000Z',
    lastRunAt: null,
    lastRun: null,
    createdAt: '2026-10-18T10:00:00.000Z',
    ...patch,
  } as Routine;
}

const run = (patch: Partial<RoutineRun> = {}): RoutineRun => ({
  id: '00000000-0000-4000-8000-0000000000e1',
  routineId: ROUTINE,
  runId: RUN,
  status: 'failed',
  reason: 'schedule',
  slot: '2026-10-19T07:00:00.000Z',
  startedAt: '2026-10-19T07:00:01.000Z',
  finishedAt: '2026-10-19T07:00:09.000Z',
  resultMessageId: null,
  exception: 'The provider is down',
  ...patch,
});

/** A Skill this Bot has enabled, unless `patch` says otherwise. */
const skill = (patch: Record<string, unknown> = {}) => ({
  id: SKILL,
  name: 'Triage',
  slug: 'triage',
  usedBy: [{ id: BOT, name: 'Grace', handle: 'grace' }],
  ...patch,
});

beforeEach(() => {
  server.requests = [];
  server.routines = [routine()];
  server.runs = [run()];
  server.skills = [skill()];
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
const click = (el: HTMLElement | undefined) => act(() => el!.click());

function type(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  act(() => {
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

describe('schedule drafts', () => {
  it('turns each preset into a schedule and back', () => {
    for (const preset of [
      { kind: 'daily', time: '07:30' },
      { kind: 'weekdays', time: '08:00' },
      { kind: 'weekly', day: 5, time: '17:00' },
      { kind: 'monthly', date: 'last', time: '09:00' },
      { kind: 'monthly', date: 15, time: '09:00' },
      { kind: 'every_minutes', minutes: 30 },
      { kind: 'custom', cron: '0 9 * * 1' },
    ] as const) {
      expect(presetFromDraft(draftFromPreset(preset))).toEqual({ ok: true, preset });
    }
  });

  it('takes any interval from 1 to 1440 minutes (R1)', () => {
    const every = (minutes: number) =>
      presetFromDraft({ ...DEFAULT_DRAFT, kind: 'every_minutes', minutes });
    for (const minutes of [1, 7, 90, 1440]) {
      expect(every(minutes)).toEqual({ ok: true, preset: { kind: 'every_minutes', minutes } });
    }
    for (const minutes of [0, 1441, 2.5, Number.NaN]) {
      expect(every(minutes)).toEqual({
        ok: false,
        error: 'Use a whole number of minutes from 1 to 1440',
      });
    }
    const preview = previewDraft(
      { ...DEFAULT_DRAFT, kind: 'every_minutes', minutes: 7 },
      'UTC',
      new Date('2026-10-16T12:00:30Z'),
    );
    expect(preview).toMatch(/^Every 7 minutes\. Next: .*12:07.*\(UTC\)$/);
  });

  it('says what is wrong with a draft', () => {
    expect(presetFromDraft({ ...DEFAULT_DRAFT, time: '' })).toMatchObject({ ok: false });
    expect(presetFromDraft({ ...DEFAULT_DRAFT, kind: 'custom', cron: '0 0 9 * * 1' })).toEqual({
      ok: false,
      error: expect.stringContaining('five cron fields'),
    });
  });

  it('previews the next run in the Routine’s timezone', () => {
    const preview = previewDraft(DEFAULT_DRAFT, 'Europe/London', new Date('2026-10-16T12:00:00Z'));
    expect(preview).toMatch(/^Weekdays at 08:00\. Next: .*19.*08:00.*\(Europe\/London\)$/);
  });

  it('describes last and next runs', () => {
    expect(lastRunText(routine())).toBe('Never');
    expect(lastRunText(routine({ lastRun: run() }))).toMatch(/^Failed · /);
    expect(nextRunText(routine({ enabled: false }))).toBe('Paused');
    expect(nextRunText(routine({ trigger: { type: 'event', source: 'github' } }))).toBe(
      'On the next event',
    );
  });
});

describe('the Bot Routines tab', () => {
  it('lists Routines with their schedule, last and next run, and runs one now', async () => {
    server.routines = [routine({ lastRun: run({ status: 'completed', exception: null }) })];
    render(<RoutinesTab botId={BOT} />);
    await until(() => !!host.querySelector('[data-routine]'), 'the list');
    const row = host.querySelector('[data-routine]')!;
    expect(row.textContent).toContain('Morning briefing');
    expect(row.textContent).toContain('Weekdays at 08:00 (Europe/London)');
    expect(row.textContent).toContain('Last runCompleted');
    expect(row.textContent).not.toContain('Next runPaused');

    click(button('Run now'));
    await until(
      () => server.requests.some((r) => r.path === `/api/v1/routines/${ROUTINE}/run-now`),
      'run now',
    );
    click(button('Pause'));
    await until(() => server.requests.some((r) => r.method === 'PATCH'), 'pause');
    expect(server.requests.find((r) => r.method === 'PATCH')!.body).toEqual({ enabled: false });
  });

  it('shows the run records and opens a run’s activity log', async () => {
    render(<RoutinesTab botId={BOT} />);
    await until(() => !!host.querySelector('details'), 'the list');
    const details = host.querySelector('details')!;
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    await until(() => !!host.querySelector('[data-status="failed"]'), 'the runs');
    expect(host.textContent).toContain('The provider is down');
    click(button('Activity log'));
    expect(readPanel(BOT)).toEqual({ kind: 'activity', runId: RUN });
  });

  it('creates a Routine from the preset editor', async () => {
    server.routines = [];
    render(<RoutinesTab botId={BOT} />);
    await until(() => host.textContent!.includes('No Routines yet.'), 'the empty state');
    click(button('New Routine'));
    type(host.querySelector('input[aria-label="Routine name"]')!, 'Weekly review');
    type(host.querySelector('textarea[aria-label="Prompt"]')!, 'Review the week');
    type(host.querySelector('select[aria-label="Repeats"]')!, 'weekly');
    type(host.querySelector('select[aria-label="Day"]')!, '5');
    type(host.querySelector('input[aria-label="Time"]')!, '16:30');
    type(host.querySelector('input[aria-label="Timezone"]')!, 'Asia/Tokyo');
    expect(host.textContent).toContain('Every Friday at 16:30. Next:');
    server.routines = [routine()];
    act(() => host.querySelector('form')!.requestSubmit());
    await until(() => server.requests.some((r) => r.method === 'POST'), 'create');
    expect(server.requests.find((r) => r.method === 'POST')).toMatchObject({
      path: `/api/v1/bots/${BOT}/routines`,
      body: {
        name: 'Weekly review',
        prompt: 'Review the week',
        timezone: 'Asia/Tokyo',
        trigger: { type: 'schedule', preset: { kind: 'weekly', day: 5, time: '16:30' } },
      },
    });
  });
});

describe('the interval field', () => {
  it('takes any number of minutes and sends it as every_minutes', async () => {
    server.routines = [];
    render(<RoutinesTab botId={BOT} />);
    await until(() => host.textContent!.includes('No Routines yet.'), 'the empty state');
    click(button('New Routine'));
    type(host.querySelector('input[aria-label="Routine name"]')!, 'Poll');
    type(host.querySelector('textarea[aria-label="Prompt"]')!, 'Check the queue');
    type(host.querySelector('select[aria-label="Repeats"]')!, 'every_minutes');
    const minutes = host.querySelector<HTMLInputElement>(
      'input[aria-label="Interval in minutes"]',
    )!;
    type(minutes, '1441');
    expect(host.textContent).toContain('Use a whole number of minutes from 1 to 1440');
    type(minutes, '7');
    expect(host.textContent).toContain('Every 7 minutes. Next:');
    act(() => host.querySelector('form')!.requestSubmit());
    await until(() => server.requests.some((r) => r.method === 'POST'), 'create');
    expect(server.requests.find((r) => r.method === 'POST')).toMatchObject({
      body: { trigger: { type: 'schedule', preset: { kind: 'every_minutes', minutes: 7 } } },
    });
  });
});

describe('event trigger drafts', () => {
  it('stores only the fields the event reads, without the source', () => {
    expect(
      matchFromDraft({
        ...DEFAULT_EVENT_DRAFT,
        source: 'github',
        github: 'label_added',
        repo: ' acme/web ',
        label: 'bug',
        text: 'ignored for this event',
      }),
    ).toEqual({ ok: true, match: { event: 'label_added', repo: 'acme/web', label: 'bug' } });
    expect(
      matchFromDraft({
        ...DEFAULT_EVENT_DRAFT,
        source: 'slack',
        slack: 'reaction_added',
        emoji: 'eyes',
      }),
    ).toEqual({ ok: true, match: { event: 'reaction_added', emoji: 'eyes' } });
  });

  it('lets a webhook Routine match every delivery, or narrow it by conditions', () => {
    expect(matchFromDraft(DEFAULT_EVENT_DRAFT)).toEqual({ ok: true, match: undefined });
    expect(
      matchFromDraft({
        ...DEFAULT_EVENT_DRAFT,
        conditions: [
          { path: 'data.status', op: 'equals', value: 'paid' },
          { path: ' ', op: 'equals', value: 'blank paths are dropped' },
        ],
      }),
    ).toEqual({
      ok: true,
      match: { conditions: [{ path: 'data.status', op: 'equals', value: 'paid' }] },
    });
  });

  it('says what is wrong with a rule', () => {
    expect(
      matchFromDraft({ ...DEFAULT_EVENT_DRAFT, source: 'github', github: 'comment_contains' }),
    ).toEqual({ ok: false, error: expect.stringContaining('text') });
    expect(
      matchFromDraft({ ...DEFAULT_EVENT_DRAFT, source: 'slack', slack: 'channel_created' }),
    ).toEqual({ ok: false, error: expect.stringContaining('pattern') });
    expect(
      matchFromDraft({
        ...DEFAULT_EVENT_DRAFT,
        conditions: [{ path: 'a', op: 'matches', value: '(' }],
      }),
    ).toEqual({ ok: false, error: expect.stringContaining('regular expression') });
  });

  it('reads a stored rule back into a draft', () => {
    const match = { event: 'comment_contains', repo: 'acme/*', text: 'deploy' };
    const draft = draftFromTrigger({ source: 'github', match });
    expect(draft).toMatchObject({ source: 'github', github: 'comment_contains', repo: 'acme/*' });
    expect(matchFromDraft(draft)).toEqual({ ok: true, match });
  });
});

describe('the Routine editor', () => {
  it('creates an event Routine with a GitHub rule that runs a Skill', async () => {
    server.routines = [];
    render(<RoutinesTab botId={BOT} />);
    await until(() => host.textContent!.includes('No Routines yet.'), 'the empty state');
    click(button('New Routine'));
    type(host.querySelector('input[aria-label="Routine name"]')!, 'Triage bugs');
    await until(() => !!host.querySelector(`option[value="${SKILL}"]`), 'the Skills');
    type(host.querySelector('select[aria-label="Skill"]')!, SKILL);
    type(host.querySelector('select[aria-label="Starts"]')!, 'event');
    expect(host.querySelector('input[aria-label="Timezone"]')).toBeNull();
    type(host.querySelector('select[aria-label="Source"]')!, 'github');
    type(host.querySelector('select[aria-label="Event"]')!, 'label_added');
    type(host.querySelector('input[aria-label="Repository"]')!, 'acme/web');
    type(host.querySelector('input[aria-label="Label"]')!, 'bug');
    // Pausing is the row's Pause, not a field of the form (principle 10).
    expect(host.querySelector('input[aria-label="Enabled"]')).toBeNull();
    server.routines = [routine()];
    act(() => host.querySelector('form')!.requestSubmit());
    await until(() => server.requests.some((r) => r.method === 'POST'), 'create');
    expect(server.requests.find((r) => r.method === 'POST')).toMatchObject({
      path: `/api/v1/bots/${BOT}/routines`,
      body: {
        name: 'Triage bugs',
        prompt: '',
        skillId: SKILL,
        trigger: {
          type: 'event',
          source: 'github',
          match: { event: 'label_added', repo: 'acme/web', label: 'bug' },
        },
      },
    });
  });

  it('offers only Skills this Bot has enabled (S2)', async () => {
    server.routines = [routine({ skillId: '00000000-0000-4000-8000-0000000000f3' })];
    server.skills = [
      skill(),
      skill({ id: '00000000-0000-4000-8000-0000000000f3', name: 'Elsewhere', usedBy: [] }),
      skill({ id: '00000000-0000-4000-8000-0000000000f4', name: 'Other Bot', usedBy: [] }),
    ];
    render(<RoutinesTab botId={BOT} />);
    await until(() => !!button('Edit'), 'the Routine');
    click(button('Edit'));
    await until(() => !!host.querySelector(`option[value="${SKILL}"]`), 'the Skills');
    const options = [
      ...host.querySelectorAll<HTMLOptionElement>('select[aria-label="Skill"] option'),
    ];
    expect(options.map((o) => [o.textContent, o.disabled])).toEqual([
      ['No Skill', false],
      ['Triage', false],
      // The Routine's own Skill stays listed with the reason it cannot run.
      ['Elsewhere (not enabled for this Bot)', true],
    ]);
  });

  it('asks for a prompt or a Skill, and for a valid rule, before saving', async () => {
    server.routines = [];
    render(<RoutinesTab botId={BOT} />);
    await until(() => host.textContent!.includes('No Routines yet.'), 'the empty state');
    click(button('New Routine'));
    type(host.querySelector('input[aria-label="Routine name"]')!, 'Nothing to do');
    act(() => host.querySelector('form')!.requestSubmit());
    expect(host.textContent).toContain('Write a prompt or pick a Skill.');
    type(host.querySelector('textarea[aria-label="Prompt"]')!, 'Reply');
    type(host.querySelector('select[aria-label="Starts"]')!, 'event');
    type(host.querySelector('select[aria-label="Source"]')!, 'slack');
    type(host.querySelector('select[aria-label="Event"]')!, 'channel_created');
    act(() => host.querySelector('form')!.requestSubmit());
    expect(host.textContent).toContain('channel_created needs a channel name pattern');
    expect(server.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('edits an event Routine and keeps the endpoint it waits on', async () => {
    server.routines = [
      routine({
        name: 'On payment',
        schedule: 'When a webhook arrives',
        nextRunAt: null,
        trigger: {
          type: 'event',
          source: 'webhook',
          endpoint_id: ENDPOINT,
          match: { conditions: [{ path: 'type', op: 'equals', value: 'paid' }] },
        },
      }),
    ];
    render(<RoutinesTab botId={BOT} />);
    await until(() => !!host.querySelector('[data-routine]'), 'the list');
    click(button('Edit'));
    expect(host.querySelector('select[aria-label="Starts"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Field path"]')!.value).toBe(
      'type',
    );
    type(host.querySelector('input[aria-label="Value"]')!, 'refunded');
    act(() => host.querySelector('form')!.requestSubmit());
    await until(() => server.requests.some((r) => r.method === 'PATCH'), 'save');
    expect(server.requests.find((r) => r.method === 'PATCH')!.body).toMatchObject({
      name: 'On payment',
      trigger: {
        type: 'event',
        source: 'webhook',
        endpoint_id: ENDPOINT,
        match: { conditions: [{ path: 'type', op: 'equals', value: 'refunded' }] },
      },
    });
  });
});
