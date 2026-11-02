import { localEmbedder } from '@openbots/agent';
import { promptText, scriptedModel, type ScriptedTurn } from '@openbots/agent/testing';
import type { MessagePart } from '@openbots/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import type { Message } from '../schemas.js';
import { registerRunHooks, RUNS_QUEUE, type RunJob } from '../services/runs.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { createRunWorker, type RunModel } from './runs.js';

// A form widget end to end (W1, W2): the Bot posts it with show_widget, the
// owner submits it through the widget action route, the values are stored in
// `widget_states` (so a reload shows them) and the Bot's next run gets them.

interface Bot {
  id: string;
  chatId: string;
}

const FORM = {
  title: 'Trip details',
  fields: [
    { name: 'city', label: 'City', type: 'text', required: true },
    { name: 'nights', label: 'Nights', type: 'number' },
    { name: 'breakfast', label: 'Breakfast', type: 'checkbox' },
  ],
};

describe('form widget', () => {
  let t: TestApp;
  let cookie: string;
  let unhook: () => void;
  const models = new Map<string, RunModel>();

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    cookie = (await t.signUp('dana@example.com')).cookie!;
    unhook = registerRunHooks();
    const worker = createRunWorker(t.deps, {
      resolveModel: async (_config, bot) => models.get(bot.id)!,
      smallModel: async () => null,
      embedder: localEmbedder,
    });
    await t.deps.infra.queue<RunJob>(RUNS_QUEUE).process(worker, { concurrency: 2 });
  });
  afterAll(async () => {
    unhook();
    await t.close();
  });

  function call(method: string, path: string, body?: unknown) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function newBot(name: string, turns: ScriptedTurn[]) {
    const res = await call('POST', '/bots', {
      name,
      modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
    });
    const bot = (await res.json()) as Bot;
    const model = scriptedModel(turns);
    models.set(bot.id, { model, info: null, providerOptions: {} });
    return { bot, model };
  }

  const runsOf = (botId: string) =>
    t.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.botId, botId))
      .orderBy(asc(schema.runs.createdAt));
  const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });
  const settled = (botId: string, n: number) =>
    until(async () => {
      const runs = await runsOf(botId);
      expect(runs).toHaveLength(n);
      expect(runs.every((r) => r.status === 'completed')).toBe(true);
      return runs;
    });

  it('stores a submitted form, shows it on reload and hands the values to the Bot', async () => {
    const { bot, model } = await newBot('Planner', [
      [{ tool: 'show_widget', args: { kind: 'form', props: FORM } }],
      [{ text: 'Fill this in.' }],
      [{ text: 'Booking Oslo for 3 nights.' }],
    ]);
    await call('POST', `/chats/${bot.chatId}/messages`, { text: 'Plan my trip' });
    await settled(bot.id, 1);

    const [posted] = (
      await t.db
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.chatId, bot.chatId), eq(schema.messages.authorType, 'bot')))
    ).filter((m) => (m.parts as MessagePart[]).some((p) => p.type === 'widget'));
    const partIndex = (posted!.parts as MessagePart[]).findIndex((p) => p.type === 'widget');
    expect((posted!.parts as MessagePart[])[partIndex]).toMatchObject({
      kind: 'form',
      props: FORM,
    });
    const action = (body: unknown) =>
      call('POST', `/messages/${posted!.id}/widgets/${partIndex}/action`, body);

    // Values that do not fit the fields are refused and nothing is stored.
    const missing = await action({ action: { type: 'submit', values: { nights: 3 } } });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      code: 'INVALID_WIDGET_ACTION',
      title: 'City is required',
    });
    const wrongShape = await action({ action: { type: 'submit' } });
    expect(wrongShape.status).toBe(400);
    expect(await t.db.select().from(schema.widgetStates)).toEqual([]);

    const res = await action({
      action: { type: 'submit', values: { city: ' Oslo ', nights: 3, breakfast: true } },
    });
    expect(res.status).toBe(200);
    const submitted = { status: 'submitted', values: { city: 'Oslo', nights: 3, breakfast: true } };
    const result = (await res.json()) as { startedRunId: string };
    expect(result).toMatchObject({
      widget: { messageId: posted!.id, partIndex, state: submitted },
      resumedRunId: null,
    });
    expect(result.startedRunId).toBeTruthy();

    const [stored] = await t.db
      .select()
      .from(schema.widgetStates)
      .where(eq(schema.widgetStates.messageId, posted!.id));
    expect(stored).toMatchObject({ partIndex, state: submitted, pendingRunId: null });

    // A reload: the message page overlays the stored state onto the part.
    const page = await call('GET', `/chats/${bot.chatId}/messages`);
    const reloaded = ((await page.json()) as { messages: Message[] }).messages.find(
      (m) => m.id === posted!.id,
    )!;
    expect(reloaded.parts[partIndex]).toMatchObject({ kind: 'form', state: submitted });

    // The submit started a widget_action run that is told the checked values.
    const runs = await settled(bot.id, 2);
    expect(runs[1]).toMatchObject({ id: result.startedRunId, trigger: 'widget_action' });
    expect(promptText(model.calls[2]!)).toContain(
      '[acted on your form widget: {"type":"submit","values":{"city":"Oslo","nights":3,"breakfast":true}}]',
    );

    // A form is submitted once.
    const again = await action({ action: { type: 'submit', values: { city: 'Rome' } } });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'WIDGET_CLOSED' });
  });
});
