import { localEmbedder } from '@openbots/agent';
import { scriptedModel } from '@openbots/agent/testing';
import { EVENTS_CHANNEL, type MessagePart, type WsEvent } from '@openbots/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import { registerRunHooks, RUNS_QUEUE, type RunJob } from '../services/runs.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { createRunWorker, type RunModel } from './runs.js';

// Phase 3's story end to end (plan 18 exit criterion: "Bot writes a document,
// user edits it, both versions visible"): a scripted Bot creates and patches
// an Artifact through the tools, the transcript gets the cards and the bus
// the events, then the owner edits it and the history shows all three.

const DRAFT = '# Q3 summary\n\nRevenue grew.\nCosts fell.\n';
const PATCH =
  '@@ -3,2 +3,3 @@\n-Revenue grew.\n+Revenue grew 12%.\n+Margin improved.\n Costs fell.\n';

describe('artifact tools in a run', () => {
  let t: TestApp;
  let cookie: string;
  let unhook: () => void;
  const events: WsEvent[] = [];
  const models = new Map<string, RunModel>();

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    cookie = (await t.signUp('dana@example.com')).cookie!;
    unhook = registerRunHooks();
    await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
    await t.deps.infra.queue<RunJob>(RUNS_QUEUE).process(
      createRunWorker(t.deps, {
        resolveModel: async (_config, bot) => models.get(bot.id)!,
        smallModel: async () => null,
        embedder: localEmbedder,
      }),
      { concurrency: 2 },
    );
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

  const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });

  it('writes versions, posts cards and events, then takes the owner edit', async () => {
    const res = await call('POST', '/bots', {
      name: 'Analyst',
      modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
    });
    const bot = (await res.json()) as { id: string; chatId: string };
    let artifactId = '';
    const model = scriptedModel([
      [
        {
          tool: 'create_artifact',
          args: { title: 'Q3 summary', kind: 'document', content: DRAFT },
          id: 'c1',
        },
      ],
      // The id comes back in the tool result; the script reads it when the step runs.
      () => [{ tool: 'update_artifact', args: { id: artifactId, patch: PATCH }, id: 'u1' }],
      [{ text: 'The Q3 summary is ready.' }],
    ]);
    models.set(bot.id, { model, info: null, providerOptions: {} });
    const unsubscribe = await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => {
      if (e.type === 'artifact.created') artifactId = e.payload.artifactId;
    });

    await call('POST', `/chats/${bot.chatId}/messages`, { text: 'Write up Q3' });
    const run = await until(async () => {
      const [row] = await t.db.select().from(schema.runs).where(eq(schema.runs.botId, bot.id));
      expect(row?.status).toBe('completed');
      return row!;
    });
    await unsubscribe();

    // Cards in the run's message, after each tool result.
    const [reply] = await t.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.runId, run.id))
      .orderBy(asc(schema.messages.seq));
    const parts = reply!.parts as MessagePart[];
    expect(parts.filter((p) => p.type === 'artifact')).toEqual([
      {
        type: 'artifact',
        artifact_id: artifactId,
        title: 'Q3 summary',
        kind: 'document',
        version: 1,
      },
      {
        type: 'artifact',
        artifact_id: artifactId,
        title: 'Q3 summary',
        kind: 'document',
        version: 2,
      },
    ]);
    expect(parts.map((p) => p.type)).toEqual([
      'tool_call',
      'tool_result',
      'artifact',
      'tool_call',
      'tool_result',
      'artifact',
      'text',
    ]);

    // Events on the bus, scoped to the transcript and the Bot.
    expect(
      events
        .filter((e) => e.type.startsWith('artifact.'))
        .map((e) => [e.type, e.chat_id, e.bot_id, e.payload.version]),
    ).toEqual([
      ['artifact.created', bot.chatId, bot.id, 1],
      ['artifact.updated', bot.chatId, bot.id, 2],
    ]);

    // Activity labels in the log.
    const steps = await until(async () => {
      const rows = await t.db
        .select()
        .from(schema.runSteps)
        .where(eq(schema.runSteps.runId, run.id))
        .orderBy(asc(schema.runSteps.idx));
      expect(rows.filter((s) => s.type === 'tool_call')).toHaveLength(2);
      return rows;
    });
    expect(steps.filter((s) => s.type === 'tool_call').map((s) => s.label)).toEqual([
      'Created "Q3 summary"',
      'Updated "Q3 summary" +2 −1',
    ]);

    // The owner edits it in the viewer (A2).
    const edit = await call('PUT', `/artifacts/${artifactId}`, {
      content: '# Q3 summary\n\nRevenue grew 12%.\nMargin improved.\nCosts fell 3%.\n',
      baseVersion: 2,
    });
    expect(edit.status).toBe(200);

    const history = (await (await call('GET', `/artifacts/${artifactId}/versions`)).json()) as {
      items: Record<string, unknown>[];
    };
    expect(history.items).toMatchObject([
      { version: 3, summary: '+1 −1', createdBy: 'user', createdByRunId: null },
      {
        version: 2,
        summary: '+2 −1',
        createdBy: 'bot',
        createdByRunId: run.id,
        createdByUserId: null,
      },
      {
        version: 1,
        summary: '+4 −0',
        createdBy: 'bot',
        createdByRunId: run.id,
        createdByUserId: null,
      },
    ]);
    const listed = (await (await call('GET', `/bots/${bot.id}/artifacts`)).json()) as {
      items: { id: string; currentVersion: { version: number } }[];
    };
    expect(listed.items).toMatchObject([{ id: artifactId, currentVersion: { version: 3 } }]);
    const v1 = await call('GET', `/artifacts/${artifactId}/download?version=1`);
    expect(await v1.text()).toBe(DRAFT);
  });
});
