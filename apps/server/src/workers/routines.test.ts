import { localEmbedder } from '@openbots/agent';
import { promptText, scriptedModel, type ScriptedTurn } from '@openbots/agent/testing';
import type { MessagePart } from '@openbots/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import {
  claimRoutineRun,
  registerRoutineHooks,
  ROUTINE_TICK_MS,
  startRoutineScheduler,
  tickDueRoutines,
} from '../services/routines.js';
import { registerRunHooks, RUNS_QUEUE, type RunJob } from '../services/runs.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { createRunWorker, type RunModel } from './runs.js';

// Routines end to end (plan 10.2, R1 to R5) on a test database with the
// recorded-provider double: the schedule API, the scheduler's exactly-once
// claim, run records with trim, run-now, the "Routine ran" widget with its
// exception actions, and propose_routine with Confirm. The Phase 6 exit
// criterion ("a weekday 8:00 Routine posts into the transcript") runs the
// 30-second ticker on a faked clock.

interface Bot {
  id: string;
  chatId: string;
}

interface RoutineView {
  id: string;
  name: string;
  schedule: string;
  trigger: { type: string; cron?: string };
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRun: { status: string } | null;
}

describe('routines', () => {
  let t: TestApp;
  let cookie: string;
  let unhook: () => void;
  const models = new Map<string, RunModel>();

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    cookie = (await t.signUp('dana@example.com')).cookie!;
    const off = [registerRunHooks(), registerRoutineHooks()];
    unhook = () => off.forEach((f) => f());
    const worker = createRunWorker(t.deps, {
      resolveModel: async (_config, bot) => models.get(bot.id)!,
      smallModel: async () => null,
      embedder: localEmbedder,
    });
    await t.deps.infra.queue<RunJob>(RUNS_QUEUE).process(worker, { concurrency: 4 });
  });
  afterAll(async () => {
    unhook();
    await t.close();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function call(method: string, path: string, body?: unknown, as = cookie) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        cookie: as,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function newBot(name: string, turns: ScriptedTurn[] = []) {
    const res = await call('POST', '/bots', {
      name,
      modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
    });
    expect(res.status).toBe(201);
    const bot = (await res.json()) as Bot;
    const model = scriptedModel(turns);
    models.set(bot.id, { model, info: null, providerOptions: {} });
    return { bot, model };
  }

  async function newRoutine(botId: string, body: Record<string, unknown>) {
    const res = await call('POST', `/bots/${botId}/routines`, body);
    expect(res.status).toBe(201);
    return (await res.json()) as RoutineView;
  }

  const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });

  const messagesOf = (chatId: string) =>
    t.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.chatId, chatId))
      .orderBy(asc(schema.messages.seq));

  const widgetsOf = async (chatId: string, kind: string) =>
    (await messagesOf(chatId)).flatMap((m) =>
      (m.parts as MessagePart[])
        .map((p, partIndex) => ({ message: m, part: p, partIndex }))
        .filter(({ part }) => part.type === 'widget' && part.kind === kind),
    );

  const recordsOf = (routineId: string) =>
    t.db
      .select()
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.routineId, routineId))
      .orderBy(asc(schema.routineRuns.startedAt));

  const weekdays = { type: 'schedule', preset: { kind: 'weekdays', time: '08:00' } };

  it('creates, lists, edits and deletes Routines with presets in their timezone', async () => {
    const { bot } = await newBot('Planner');
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-16T13:00:00Z') });
    const routine = await newRoutine(bot.id, {
      name: 'Morning briefing',
      prompt: 'Summarize my inbox',
      trigger: weekdays,
      timezone: 'America/New_York',
    });
    expect(routine).toMatchObject({
      name: 'Morning briefing',
      schedule: 'Weekdays at 08:00 (America/New_York)',
      trigger: { type: 'schedule', cron: '0 8 * * 1-5' },
      enabled: true,
      // Friday afternoon: next is Monday 08:00 EDT.
      nextRunAt: '2026-10-19T12:00:00.000Z',
      lastRun: null,
    });

    const list = await call('GET', `/bots/${bot.id}/routines`);
    expect(((await list.json()) as { items: RoutineView[] }).items.map((r) => r.id)).toEqual([
      routine.id,
    ]);

    // A new schedule or timezone moves the next run from now.
    const edited = await call('PATCH', `/routines/${routine.id}`, {
      trigger: { type: 'schedule', preset: { kind: 'every_minutes', minutes: 15 } },
    });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({
      schedule: 'Every 15 minutes',
      nextRunAt: '2026-10-16T13:15:00.000Z',
    });
    const paused = await call('PATCH', `/routines/${routine.id}`, { enabled: false });
    expect(await paused.json()).toMatchObject({ enabled: false, nextRunAt: null });

    // Bad input.
    const bad = async (body: unknown, code: string) => {
      const res = await call('POST', `/bots/${bot.id}/routines`, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code });
    };
    await bad(
      { name: 'x', prompt: 'y', trigger: weekdays, timezone: 'Mars/Olympus' },
      'INVALID_SCHEDULE',
    );
    await bad(
      {
        name: 'x',
        prompt: 'y',
        trigger: { type: 'schedule', preset: { kind: 'custom', cron: 'not a cron' } },
      },
      'INVALID_SCHEDULE',
    );
    await bad({ name: 'x', prompt: '  ', trigger: weekdays }, 'EMPTY_ROUTINE');

    // Another owner sees nothing.
    const other = (await t.signUp('eve@example.com')).cookie!;
    expect((await call('GET', `/routines/${routine.id}`, undefined, other)).status).toBe(404);
    expect((await call('GET', `/bots/${bot.id}/routines`, undefined, other)).status).toBe(404);

    expect((await call('DELETE', `/routines/${routine.id}`)).status).toBe(204);
    expect((await call('GET', `/routines/${routine.id}`)).status).toBe(404);
  });

  it('rejects an event trigger whose matching rule does not parse, on create and on edit', async () => {
    const { bot } = await newBot('Watcher');
    const event = (source: string, match: Record<string, unknown>) => ({
      name: 'Watch',
      prompt: 'Look at the event',
      trigger: { type: 'event', source, match },
    });
    const rejected = async (res: Response, path: (string | number)[]) => {
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; issues: { path: unknown[] }[] };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.issues.map((i) => i.path)).toContainEqual(path);
    };
    const badRegex = event('webhook', {
      conditions: [{ path: 'kind', op: 'matches', value: '(unclosed' }],
    });
    const wrongShape = event('github', { event: 'push_happened' });

    await rejected(await call('POST', `/bots/${bot.id}/routines`, badRegex), [
      'trigger',
      'match',
      'conditions',
      0,
      'value',
    ]);
    await rejected(await call('POST', `/bots/${bot.id}/routines`, wrongShape), [
      'trigger',
      'match',
      'event',
    ]);
    // The trigger's source decides, whatever `source` the rule names.
    await rejected(
      await call(
        'POST',
        `/bots/${bot.id}/routines`,
        event('slack', { source: 'github', event: 'pr_opened' }),
      ),
      ['trigger', 'match', 'event'],
    );

    const routine = await newRoutine(
      bot.id,
      event('webhook', { conditions: [{ path: 'kind', op: 'matches', value: '^deploy' }] }),
    );
    await rejected(await call('PATCH', `/routines/${routine.id}`, { trigger: badRegex.trigger }), [
      'trigger',
      'match',
      'conditions',
      0,
      'value',
    ]);
    await rejected(
      await call('PATCH', `/routines/${routine.id}`, { trigger: wrongShape.trigger }),
      ['trigger', 'match', 'event'],
    );
    const unchanged = await call('GET', `/routines/${routine.id}`);
    expect(await unchanged.json()).toMatchObject({
      trigger: { match: { conditions: [{ value: '^deploy' }] } },
    });
  });

  it('caps Routines per Bot (R4)', async () => {
    const { bot } = await newBot('Busy');
    expect((await call('PATCH', '/settings', { limits: { routinesPerBot: 2 } })).status).toBe(200);
    try {
      for (const name of ['One', 'Two']) {
        await newRoutine(bot.id, { name, prompt: 'p', trigger: weekdays });
      }
      const res = await call('POST', `/bots/${bot.id}/routines`, {
        name: 'Three',
        prompt: 'p',
        trigger: weekdays,
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'ROUTINE_LIMIT_REACHED' });
    } finally {
      await call('PATCH', '/settings', { limits: { routinesPerBot: 50 } });
    }
  });

  it('posts a weekday 8:00 Routine into the transcript at 8:00 (Phase 6 exit criterion)', async () => {
    const { bot, model } = await newBot('Briefer', [
      [{ text: 'Good morning. Three new emails, none urgent.' }],
    ]);
    // Monday 2026-10-19, 07:59:00 in London (BST, UTC+1). Only Date and the
    // ticker's interval are faked; the queue and the worker run on real timers.
    vi.useFakeTimers({
      toFake: ['Date', 'setInterval', 'clearInterval'],
      now: new Date('2026-10-19T06:59:00Z'),
    });
    const routine = await newRoutine(bot.id, {
      name: 'Morning briefing',
      prompt: 'Summarize what came in overnight.',
      trigger: weekdays,
      timezone: 'Europe/London',
    });
    expect(routine.nextRunAt).toBe('2026-10-19T07:00:00.000Z');

    const stop = startRoutineScheduler(t.deps);
    try {
      // The first tick runs at once; the next at 07:59:30, nothing due yet.
      await vi.advanceTimersByTimeAsync(ROUTINE_TICK_MS);
      expect(await recordsOf(routine.id)).toHaveLength(0);
      // 08:00:00 London.
      await vi.advanceTimersByTimeAsync(ROUTINE_TICK_MS);
      await until(async () => expect(await recordsOf(routine.id)).toHaveLength(1));
    } finally {
      stop();
    }

    const [record] = await until(async () => {
      const rows = await recordsOf(routine.id);
      expect(rows[0]?.status).toBe('completed');
      return rows;
    });
    expect(record).toMatchObject({ reason: 'schedule', slot: new Date('2026-10-19T07:00:00Z') });
    const [run] = await t.db.select().from(schema.runs).where(eq(schema.runs.id, record!.runId!));
    expect(run).toMatchObject({ trigger: 'routine', priority: 3, chatId: bot.chatId });

    // The Bot was told what to do, and its reply and the "Routine ran" widget are in the transcript.
    const prompt = promptText(model.calls[0]!);
    expect(prompt).toContain('Your Routine "Morning briefing" (Weekdays at 08:00 (Europe/London))');
    expect(prompt).toContain('Summarize what came in overnight.');
    const messages = await until(async () => {
      const rows = await messagesOf(bot.chatId);
      expect(rows.some((m) => m.authorType === 'routine')).toBe(true);
      return rows;
    });
    const reply = messages.find((m) => m.authorType === 'bot' && m.runId === run!.id)!;
    expect(reply.parts).toEqual([
      { type: 'text', text: 'Good morning. Three new emails, none urgent.' },
    ]);
    const ran = messages.find((m) => m.authorType === 'routine')!;
    expect(ran.seq).toBeGreaterThan(reply.seq);
    expect(ran.authorId).toBe(routine.id);
    expect(ran.parts).toEqual([
      {
        type: 'widget',
        kind: 'routine_run',
        props: expect.objectContaining({
          routine_id: routine.id,
          name: 'Morning briefing',
          run_id: run!.id,
          outcome: 'completed',
          reason: 'schedule',
        }),
      },
    ]);
    const [finished] = await recordsOf(routine.id);
    expect(finished!.resultMessageId).toBe(ran.id);

    // The next slot is Tuesday 08:00, and the same instant does not run again.
    const after = await call('GET', `/routines/${routine.id}`);
    expect(await after.json()).toMatchObject({
      nextRunAt: '2026-10-20T07:00:00.000Z',
      lastRun: { status: 'completed' },
    });
    await tickDueRoutines(t.deps);
  });

  it('enqueues each slot exactly once when two workers tick at the same time', async () => {
    const { bot } = await newBot(
      'Twin',
      Array.from({ length: 8 }, () => [{ text: 'ok' }]),
    );
    // A tick claims every due Routine in the database, and earlier tests leave
    // theirs due on the slots of their faked clocks (the Phase 6 one at
    // 2026-10-20 08:00 London), so only this test's four are scheduled here.
    await t.db.update(schema.routines).set({ nextRunAt: null });
    const ids: string[] = [];
    for (const name of ['A', 'B', 'C', 'D']) {
      ids.push((await newRoutine(bot.id, { name, prompt: 'p', trigger: weekdays })).id);
    }
    const slot = new Date(Date.now() - 60_000);
    for (const id of ids) {
      await t.db.update(schema.routines).set({ nextRunAt: slot }).where(eq(schema.routines.id, id));
    }
    // Two worker processes: separate deps over the same database.
    const other = { ...t.ownerDeps };
    const started = await Promise.all([
      tickDueRoutines(t.deps),
      tickDueRoutines(other),
      tickDueRoutines(t.deps),
      tickDueRoutines(other),
    ]);
    expect(started.reduce((a, b) => a + b, 0)).toBe(4);
    for (const id of ids) expect(await recordsOf(id)).toHaveLength(1);

    // A worker that read the Routine before the slot moved on still cannot claim it again.
    const [routine] = await t.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, ids[0]!));
    const again = await t.db.transaction((tx) =>
      claimRoutineRun(t.ownerDeps, tx, routine!, { reason: 'schedule', slot }),
    );
    expect(again).toBeNull();
    const runs = await t.db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.botId, bot.id), eq(schema.runs.trigger, 'routine')));
    expect(runs).toHaveLength(4);
  });

  it('runs every N minutes on an interval from its creation, one run per slot (R1)', async () => {
    const { bot } = await newBot(
      'Poller',
      Array.from({ length: 4 }, () => [{ text: 'ok' }]),
    );
    // Only this test's Routine is due (see the test above).
    await t.db.update(schema.routines).set({ nextRunAt: null });
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-16T10:00:20Z') });
    const routine = await newRoutine(bot.id, {
      name: 'Poll',
      prompt: 'Check the queue',
      trigger: { type: 'schedule', preset: { kind: 'every_minutes', minutes: 7 } },
      timezone: 'Asia/Tokyo',
    });
    expect(routine).toMatchObject({
      schedule: 'Every 7 minutes',
      trigger: { type: 'schedule', preset: { kind: 'every_minutes', minutes: 7 } },
      nextRunAt: '2026-10-16T10:07:00.000Z',
    });
    expect(routine.trigger).not.toHaveProperty('cron');

    // On time: the next slot is 7 minutes on.
    expect(await tickDueRoutines(t.deps, new Date('2026-10-16T10:07:10Z'))).toBe(1);
    const next = async () =>
      (await (await call('GET', `/routines/${routine.id}`)).json()) as RoutineView;
    expect((await next()).nextRunAt).toBe('2026-10-16T10:14:00.000Z');
    // Down for half an hour: one run, and the rhythm from the last slot is kept.
    expect(await tickDueRoutines(t.deps, new Date('2026-10-16T10:45:00Z'))).toBe(1);
    expect((await next()).nextRunAt).toBe('2026-10-16T10:49:00.000Z');
    // The same slot is never claimed twice.
    expect(await tickDueRoutines(t.deps, new Date('2026-10-16T10:45:30Z'))).toBe(0);
    expect((await recordsOf(routine.id)).map((r) => r.slot?.toISOString())).toEqual([
      '2026-10-16T10:07:00.000Z',
      '2026-10-16T10:14:00.000Z',
    ]);
  });

  it('keeps the 20 most recent run records per Routine (R4)', async () => {
    const { bot } = await newBot('Keeper');
    const view = await newRoutine(bot.id, { name: 'Often', prompt: 'p', trigger: weekdays });
    const [routine] = await t.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, view.id));
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-01T00:00:00Z') });
    const claimed: string[] = [];
    for (let i = 0; i < 23; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 0, i)));
      const run = await t.db.transaction((tx) =>
        claimRoutineRun(t.ownerDeps, tx, routine!, { reason: 'run_now' }),
      );
      claimed.push(run!.routineRun.id);
    }
    const kept = await recordsOf(view.id);
    expect(kept).toHaveLength(20);
    expect(kept.map((r) => r.id)).toEqual(claimed.slice(3));
  });

  it('runs now on request, records the failure and offers Run again and Pause', async () => {
    const { bot } = await newBot('Flaky', [
      { error: new Error('upstream exploded') },
      [{ text: 'Done this time.' }],
    ]);
    const routine = await newRoutine(bot.id, {
      name: 'Report',
      prompt: 'Write the report',
      trigger: weekdays,
    });
    const res = await call('POST', `/routines/${routine.id}/run-now`);
    expect(res.status).toBe(201);
    const first = (await res.json()) as { id: string; runId: string; reason: string };
    expect(first.reason).toBe('run_now');

    const failed = await until(async () => {
      const list = await call('GET', `/routines/${routine.id}/runs`);
      const { items } = (await list.json()) as {
        items: {
          id: string;
          status: string;
          exception: string | null;
          resultMessageId: string | null;
        }[];
      };
      expect(items[0]?.resultMessageId).toBeTruthy();
      return items[0]!;
    });
    expect(failed.status).toBe('failed');
    expect(failed.exception).toContain('upstream exploded');

    const [widget] = await widgetsOf(bot.chatId, 'routine_run');
    expect(widget!.part).toMatchObject({ props: { outcome: 'failed', reason: 'run_now' } });
    const act = (action: unknown) =>
      call('POST', `/messages/${widget!.message.id}/widgets/${widget!.partIndex}/action`, {
        action,
      });

    const rerun = await act({ type: 'run_again' });
    expect(rerun.status).toBe(200);
    const rerunState = ((await rerun.json()) as { widget: { state: { rerun_run_id: string } } })
      .widget.state;
    expect(rerunState.rerun_run_id).toBeTruthy();
    expect((await act({ type: 'run_again' })).status).toBe(409);
    await until(async () => {
      const rows = await recordsOf(routine.id);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        reason: 'retry',
        status: 'completed',
        runId: rerunState.rerun_run_id,
      });
    });
    const widgets = await until(async () => {
      const all = await widgetsOf(bot.chatId, 'routine_run');
      expect(all).toHaveLength(2);
      return all;
    });
    expect(widgets[1]!.part).toMatchObject({ props: { outcome: 'completed', reason: 'retry' } });

    expect((await act({ type: 'pause' })).status).toBe(200);
    const after = await call('GET', `/routines/${routine.id}`);
    expect(await after.json()).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('runs only a Skill that is on for the Bot, and says why when it cannot (S2)', async () => {
    const { bot, model } = await newBot('Skilled', [[{ text: 'Report done.' }]]);
    const newSkill = async (name: string) => {
      const res = await call('POST', '/skills', {
        name,
        content: 'Fridays.\n\n1. Collect the week',
      });
      expect(res.status).toBe(201);
      return (await res.json()) as { id: string };
    };
    const ready = await newSkill('Weekly report');
    const other = await newSkill('Half done');
    const refused = async (skillId: string, message: RegExp) => {
      const res = await call('POST', `/bots/${bot.id}/routines`, {
        name: 'Report',
        skillId,
        trigger: weekdays,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; detail?: string; title?: string };
      expect(body.code).toBe('SKILL_UNAVAILABLE');
      expect(JSON.stringify(body)).toMatch(message);
    };
    const block = (skillId: string, botIds: string[]) =>
      call('PUT', `/skills/${skillId}/blocked-bots`, { botIds });
    // Skills are on by default; turned off for this Bot, it is refused.
    await block(ready.id, [bot.id]);
    await block(other.id, [bot.id]);
    await refused(ready.id, /turned off for this Bot/);
    await block(ready.id, []);
    const routine = await newRoutine(bot.id, {
      name: 'Report',
      skillId: ready.id,
      trigger: { type: 'schedule', preset: { kind: 'every_minutes', minutes: 1 } },
    });
    // Switching to a Skill the Bot lacks on edit is refused the same way; other edits are not.
    const edit = await call('PATCH', `/routines/${routine.id}`, { skillId: other.id });
    expect(edit.status).toBe(400);
    expect((await call('PATCH', `/routines/${routine.id}`, { name: 'Report' })).status).toBe(200);

    // The Skill is turned off: due slots record a failure, start no run and post one event row.
    await block(ready.id, [bot.id]);
    const due = () =>
      t.db
        .update(schema.routines)
        .set({ nextRunAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.routines.id, routine.id));
    await due();
    await tickDueRoutines(t.deps);
    await due();
    await tickDueRoutines(t.deps);
    const records = await recordsOf(routine.id);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record).toMatchObject({ status: 'failed', runId: null });
      expect(record.exception).toMatch(/"Weekly report" is turned off for this Bot/);
    }
    const events = (await messagesOf(bot.chatId)).flatMap((m) =>
      (m.parts as MessagePart[]).filter((p) => p.type === 'event' && p.kind === 'routine_skipped'),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      text: expect.stringContaining('The Routine "Report" did not run.'),
    });
    expect(model.calls).toHaveLength(0);
    // Run now refuses with the reason instead.
    const now = await call('POST', `/routines/${routine.id}/run-now`);
    expect(now.status).toBe(409);
    expect(await now.json()).toMatchObject({ code: 'SKILL_UNAVAILABLE' });

    // On again: it runs, with the Skill in full.
    await block(ready.id, []);
    expect((await call('POST', `/routines/${routine.id}/run-now`)).status).toBe(201);
    await until(() => expect(model.calls).toHaveLength(1));
    expect(promptText(model.calls[0]!)).toContain(
      'Follow the Skill "Weekly report":\n\n<skill name="Weekly report">\nFridays.\n\n1. Collect the week\n</skill>',
    );
  });

  it('proposes a Routine from conversation and creates it on Confirm (R5)', async () => {
    const { bot, model } = await newBot('Helper', [
      [
        { text: 'I can do that every weekday.' },
        {
          tool: 'propose_routine',
          id: 'p1',
          args: {
            name: 'Standup notes',
            prompt: 'Collect yesterday’s merged PRs into standup notes.',
            schedule: { kind: 'weekdays', time: '09:30' },
          },
        },
      ],
      [{ text: 'Done: it runs weekdays at 09:30.' }],
    ]);
    const say = await call('POST', `/chats/${bot.chatId}/messages`, {
      text: 'Can you prepare my standup notes every weekday morning?',
    });
    expect(say.status).toBe(201);

    const [proposal] = await until(async () => {
      const found = await widgetsOf(bot.chatId, 'routine_proposal');
      expect(found).toHaveLength(1);
      const [run] = await t.db.select().from(schema.runs).where(eq(schema.runs.botId, bot.id));
      expect(run?.status).toBe('waiting');
      return found;
    });
    expect(proposal!.part).toMatchObject({
      props: {
        name: 'Standup notes',
        trigger: { type: 'schedule', preset: { kind: 'weekdays', time: '09:30' } },
      },
    });

    const res = await call(
      'POST',
      `/messages/${proposal!.message.id}/widgets/${proposal!.partIndex}/action`,
      { action: { type: 'confirm', timezone: 'Europe/Berlin' } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      widget: { state: { status: string; routine_id: string } };
      resumedRunId: string | null;
    };
    expect(body.widget.state).toMatchObject({ status: 'confirmed' });
    expect(body.resumedRunId).toBeTruthy();

    const list = await call('GET', `/bots/${bot.id}/routines`);
    const [routine] = ((await list.json()) as { items: RoutineView[] }).items;
    expect(routine).toMatchObject({
      id: body.widget.state.routine_id,
      name: 'Standup notes',
      timezone: 'Europe/Berlin',
      schedule: 'Weekdays at 09:30 (Europe/Berlin)',
    });

    const [created] = await widgetsOf(bot.chatId, 'routine_created');
    expect(created!.part).toMatchObject({
      props: { routine_id: routine!.id, name: 'Standup notes', timezone: 'Europe/Berlin' },
    });
    await until(async () => {
      const [run] = await t.db.select().from(schema.runs).where(eq(schema.runs.botId, bot.id));
      expect(run?.status).toBe('completed');
    });
    // The resumed run was told the Routine exists.
    expect(promptText(model.calls[1]!)).toContain(routine!.id);
    // A second answer is refused.
    const again = await call(
      'POST',
      `/messages/${proposal!.message.id}/widgets/${proposal!.partIndex}/action`,
      { action: { type: 'decline' } },
    );
    expect(again.status).toBe(409);
  });
});
