import { conversationTools, defineTool, localEmbedder, type ToolGroup } from '@openbots/agent';
import { scriptedModel, type ScriptedTurn } from '@openbots/agent/testing';
import type { ProviderModel } from '@openbots/models';
import { DEFAULT_CAPABILITIES } from '@openbots/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { schema } from '../db/client.js';
import { registerRunHooks, RUNS_QUEUE, type RunJob } from '../services/runs.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { createRunWorker, NO_VISION_NOTE, type RunModel } from './runs.js';

// Vision gating at run start (L4, plan 5.9): a model that cannot see images
// runs without the screenshot tools instead of failing or looping on images
// it cannot read; runs that never need the computer are left alone.

interface Bot {
  id: string;
  chatId: string;
}

describe('a model without vision', () => {
  let t: TestApp;
  let cookie: string;
  let unhook: () => void;
  const models = new Map<string, RunModel>();

  const screenTool = (name: string) =>
    defineTool({
      description: `The ${name} tool`,
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    });
  const computerGroup: ToolGroup = {
    name: 'computer',
    tools: () => ({
      bash: screenTool('bash'),
      browser_snapshot: screenTool('browser_snapshot'),
      browser_screenshot: screenTool('browser_screenshot'),
      computer: screenTool('computer'),
    }),
  };

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    cookie = (await t.signUp('dana@example.com')).cookie!;
    unhook = registerRunHooks();
    await t.deps.infra.queue<RunJob>(RUNS_QUEUE).process(
      createRunWorker(t.deps, {
        resolveModel: async (_config, bot) => models.get(bot.id)!,
        smallModel: async () => null,
        embedder: localEmbedder,
        toolGroups: [conversationTools, computerGroup],
      }),
    );
  });
  afterAll(async () => {
    unhook();
    await t.close();
  });

  const call = (method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const info = (vision: boolean): ProviderModel => ({
    providerId: '00000000-0000-4000-8000-000000000001',
    modelId: 'scripted',
    displayName: 'Scripted',
    capabilities: { ...DEFAULT_CAPABILITIES, tools: true, vision },
    pricing: null,
    enabled: true,
  });

  async function runBot(name: string, vision: boolean, turns: ScriptedTurn[], toolPolicy = {}) {
    const res = await call('POST', '/bots', {
      name,
      modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
      toolPolicy,
    });
    expect(res.status).toBe(201);
    const bot = (await res.json()) as Bot;
    const model = scriptedModel(turns);
    models.set(bot.id, { model, info: info(vision), providerOptions: {} });
    const said = await call('POST', `/chats/${bot.chatId}/messages`, { text: 'look' });
    expect(said.status).toBe(201);
    const run = await vi.waitFor(
      async () => {
        const [row] = await t.db.select().from(schema.runs).where(eq(schema.runs.botId, bot.id));
        expect(row?.status).toBe('completed');
        return row!;
      },
      { timeout: 5_000, interval: 10 },
    );
    const steps = await t.db
      .select()
      .from(schema.runSteps)
      .where(eq(schema.runSteps.runId, run.id))
      .orderBy(asc(schema.runSteps.idx));
    const offered = (model.calls[0]!.tools ?? []).map((tool) => tool.name);
    return { model, steps, offered };
  }

  it('runs without the screenshot tools and notes it in the activity log', async () => {
    const { offered, steps, model } = await runBot('Blind', false, [
      [{ tool: 'browser_snapshot', args: {} }],
      [{ text: 'The page has a login form.' }],
    ]);
    expect(offered).not.toContain('computer');
    expect(offered).not.toContain('browser_screenshot');
    expect(offered).toEqual(expect.arrayContaining(['bash', 'browser_snapshot', 'ask_user']));
    expect(steps.map((s) => [s.type, s.label])).toContainEqual(['error', NO_VISION_NOTE]);
    // The run itself goes on as usual.
    expect(model.calls).toHaveLength(2);
  });

  it('keeps the screenshot tools for a model with vision', async () => {
    const { offered, steps } = await runBot('Seer', true, [[{ text: 'Looking.' }]]);
    expect(offered).toEqual(expect.arrayContaining(['computer', 'browser_screenshot']));
    expect(steps.map((s) => s.label)).not.toContain(NO_VISION_NOTE);
  });

  it('says nothing for a Bot that may not use its computer', async () => {
    const { steps } = await runBot('Desk', false, [[{ text: 'Done.' }]], {
      groups: { computer: 'deny' },
    });
    expect(steps.map((s) => s.label)).not.toContain(NO_VISION_NOTE);
  });
});
