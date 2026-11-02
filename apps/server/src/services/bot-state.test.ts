import { EVENTS_CHANNEL, type WsEvent } from '@openbots/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { startWorkers } from '../workers.js';
import { ensureWorkspace } from '../workspace.js';
import { DONE_SETTLE_MS, clearBlockedOnOpen, getState, setState } from './bot-state.js';
import { createBot } from './bots.js';

describe('Bot state service', () => {
  let t: TestApp;
  let botId: string;
  let runId: string;
  let otherRunId: string;
  const events: WsEvent[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    await t.signUp('owner@example.com');
    const { db } = t;
    const [user] = await db.select().from(schema.users);
    const workspace = await ensureWorkspace(db);
    const owner = { id: user!.id, workspaceId: workspace.id };
    const { bot, chatId } = await createBot(t.ownerDeps, owner, { name: 'Busy' });
    botId = bot.id;
    // Finished runs to name in the states; a queued one would be started by the workers.
    const [a, b] = await db
      .insert(schema.runs)
      .values([
        { workspaceId: workspace.id, botId, chatId, trigger: 'message', status: 'completed' },
        { workspaceId: workspace.id, botId, chatId, trigger: 'message', status: 'completed' },
      ])
      .returning();
    runId = a!.id;
    otherRunId = b!.id;
    await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
    await startWorkers(t.deps);
  });
  afterAll(() => t.close());
  beforeEach(() => {
    events.length = 0;
  });

  const until = async (check: () => Promise<boolean>, ms = DONE_SETTLE_MS + 2_000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it('writes bot_state and publishes bot.state on every change', async () => {
    await setState(t.ownerDeps, botId, 'thinking', { runId });
    await setState(t.ownerDeps, botId, 'working', { runId, currentAction: 'Running npm test' });
    expect(await getState(t.ownerDeps, botId)).toMatchObject({
      state: 'working',
      runId,
      currentAction: 'Running npm test',
    });
    expect(events).toMatchObject([
      {
        type: 'bot.state',
        bot_id: botId,
        payload: { botId, state: 'thinking', runId, currentAction: null },
      },
      {
        type: 'bot.state',
        bot_id: botId,
        payload: { botId, state: 'working', runId, currentAction: 'Running npm test' },
      },
    ]);
  });

  it('settles done to idle after three seconds', async () => {
    const started = Date.now();
    await setState(t.ownerDeps, botId, 'done', { runId });
    expect((await getState(t.ownerDeps, botId))!.state).toBe('done');
    await until(async () => (await getState(t.ownerDeps, botId))!.state === 'idle');
    expect(Date.now() - started).toBeGreaterThanOrEqual(DONE_SETTLE_MS - 50);
    expect(events.map((e) => e.type === 'bot.state' && e.payload.state)).toEqual(['done', 'idle']);
  }, 10_000);

  it('leaves a later run alone when an earlier done settles', async () => {
    await setState(t.ownerDeps, botId, 'done', { runId });
    await setState(t.ownerDeps, botId, 'thinking', { runId: otherRunId });
    await new Promise((r) => setTimeout(r, DONE_SETTLE_MS + 300));
    expect(await getState(t.ownerDeps, botId)).toMatchObject({
      state: 'thinking',
      runId: otherRunId,
    });
  }, 10_000);

  it('clears blocked when the owner opens the transcript', async () => {
    await setState(t.ownerDeps, botId, 'blocked', { runId, currentAction: 'GitHub needs a login' });
    events.length = 0;
    expect(await clearBlockedOnOpen(t.ownerDeps, botId)).toBe(true);
    expect(await getState(t.ownerDeps, botId)).toMatchObject({
      state: 'idle',
      currentAction: null,
    });
    expect(events).toMatchObject([{ type: 'bot.state', payload: { state: 'idle' } }]);

    // Anything but blocked is left as it is, without an event.
    await setState(t.ownerDeps, botId, 'working', { runId });
    events.length = 0;
    expect(await clearBlockedOnOpen(t.ownerDeps, botId)).toBe(false);
    expect((await getState(t.ownerDeps, botId))!.state).toBe('working');
    expect(events).toEqual([]);
  });
});
