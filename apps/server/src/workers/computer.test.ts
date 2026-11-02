import { localEmbedder } from '@openbots/agent';
import { scriptedModel } from '@openbots/agent/testing';
import { TINY_PNG } from '@openbots/computer/testing';
import { EVENTS_CHANNEL, OWNER_HAS_SCREEN, type MessagePart, type WsEvent } from '@openbots/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import { enqueueRun, registerRunHooks, RUNS_QUEUE, type RunJob } from '../services/runs.js';
import { useTestComputer, type TestComputer } from '../test-computer.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { createRunWorker, type RunModel, type RunWorkerOptions } from './runs.js';

// Phase 4 in a run (plan 18 exit criterion, as far as it goes without a
// daemon or a browser): a scripted Bot starts the computer on first use,
// browses on its own screen, takes screenshots the model sees as images,
// publishes a file as an Artifact, asks before bash and runs it once on
// approval, and waits while the owner has its screen, continuing after the
// hand back.

describe('computer tools in a run', () => {
  let t: TestApp;
  let computer: TestComputer;
  let cookie: string;
  let unhook: () => void;
  const events: WsEvent[] = [];
  const models = new Map<string, RunModel>();
  const options: RunWorkerOptions = {
    resolveModel: async (_config, bot) => models.get(bot.id)!,
    smallModel: async () => null,
    embedder: localEmbedder,
    takeoverWaitMs: 50,
  };

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    computer = await useTestComputer(t.ownerDeps);
    cookie = (await t.signUp('dana@example.com')).cookie!;
    unhook = registerRunHooks();
    await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
    await t.deps.infra.queue<RunJob>(RUNS_QUEUE).process(createRunWorker(t.deps, options), {
      concurrency: 2,
    });
  });
  afterAll(async () => {
    unhook();
    await computer.close();
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

  async function newBot(name: string, script: Parameters<typeof scriptedModel>[0]) {
    const res = await call('POST', '/bots', {
      name,
      modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
    });
    const bot = (await res.json()) as { id: string; chatId: string };
    const model = scriptedModel(script);
    models.set(bot.id, { model, info: null, providerOptions: {} });
    return { ...bot, model };
  }

  /**
   * A run no owner message came before: an owner's message wakes a stopped
   * computer itself (plan 9.5), so a webhook's run is the one that boots it.
   */
  const webhookRun = (bot: { id: string; chatId: string }) =>
    enqueueRun(t.ownerDeps, { botId: bot.id, chatId: bot.chatId, trigger: 'webhook' });

  async function runOf(botId: string, status: string) {
    return until(async () => {
      const [row] = await t.db.select().from(schema.runs).where(eq(schema.runs.botId, botId));
      expect(row?.status).toBe(status);
      return row!;
    });
  }

  async function partsOf(runId: string) {
    const rows = await t.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.runId, runId))
      .orderBy(asc(schema.messages.seq));
    return rows.flatMap((m) => m.parts as MessagePart[]);
  }

  it('starts the computer on first use and works on the Bot screen and files', async () => {
    computer.agent.files.set('report.md', new TextEncoder().encode('# Findings'));
    const bot = await newBot('Researcher', [
      [
        { tool: 'list_dir', args: {}, id: 'l1' },
        { tool: 'browser_navigate', args: { url: 'https://github.com/login' }, id: 'n1' },
      ],
      [{ tool: 'computer', args: { action: 'screenshot' }, id: 's1' }],
      [{ tool: 'publish_artifact', args: { path: 'report.md' }, id: 'p1' }],
      [{ text: 'Done.' }],
    ]);
    await call('POST', `/chats/${bot.chatId}/messages`, { text: 'Look into it' });
    const run = await runOf(bot.id, 'completed');

    // Its own screen, started on the agent.
    const [screen] = await t.db
      .select()
      .from(schema.botScreens)
      .where(eq(schema.botScreens.botId, bot.id));
    expect(screen).toMatchObject({ displayNumber: 10, cdpPort: 9222, status: 'running' });
    expect(computer.agent.browser).toEqual([
      { n: 0, action: { action: 'navigate', url: 'https://github.com/login' } },
    ]);

    // The screenshot reached the model as an image; the transcript has no bytes.
    const base64 = Buffer.from(TINY_PNG).toString('base64');
    const toolTurn = bot.model.calls[2]!.prompt.filter((m) => m.role === 'tool').at(-1)!;
    expect(JSON.stringify(toolTurn.content)).toContain(base64);
    const parts = await partsOf(run.id);
    expect(JSON.stringify(parts)).not.toContain(base64);
    expect(parts.find((p) => p.type === 'tool_result' && p.tool_name === 'computer')).toMatchObject(
      {
        result: { type: 'screenshot', width: 1, height: 1 },
        label: 'Took screenshot',
      },
    );
    // The published file is an Artifact with a card (A3).
    expect(parts.find((p) => p.type === 'artifact')).toMatchObject({
      title: 'report.md',
      kind: 'document',
      version: 1,
    });

    // Activity: the start is logged once, then each call with its label.
    const steps = await t.db
      .select()
      .from(schema.runSteps)
      .where(eq(schema.runSteps.runId, run.id))
      .orderBy(asc(schema.runSteps.idx));
    const labels = steps.filter((s) => s.type === 'tool_call').map((s) => s.label);
    expect(labels[0]).toMatch(/^Environment ready \d+ms$/);
    expect(labels.slice(1)).toEqual([
      'Listed home',
      'Opened github.com',
      'Took screenshot',
      'Published report.md',
    ]);

    // Working on a computer tool names it (the title-bar icon, I5).
    const tools = events
      .filter((e) => e.type === 'bot.state' && e.bot_id === bot.id && e.payload.state === 'working')
      .map((e) => (e.payload as { currentTool?: string }).currentTool);
    expect(tools).toEqual(['list_dir', 'browser_navigate', 'computer', 'publish_artifact']);
    const state = (await (await call('GET', `/bots/${bot.id}/state`)).json()) as {
      currentTool: string | null;
    };
    expect(state.currentTool).toBeNull();
  });

  it('asks before bash, then runs it exactly once on approval', async () => {
    let runs = 0;
    computer.agent.exec = () => {
      runs++;
      return { stdout: 'Tests 3 passed\n', exitCode: 0 };
    };
    const bot = await newBot('Builder', [
      [{ tool: 'bash', args: { command: 'npm test' }, id: 'b1' }],
      [{ text: 'All green.' }],
    ]);
    await call('POST', `/chats/${bot.chatId}/messages`, { text: 'Run the tests' });
    const run = await runOf(bot.id, 'waiting');
    expect(runs).toBe(0);
    const [approval] = await t.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.runId, run.id));
    const res = await call('POST', `/approvals/${approval!.id}/decide`, { decision: 'approve' });
    expect(res.status).toBe(200);
    await runOf(bot.id, 'completed');
    expect(runs).toBe(1);
    const steps = await t.db
      .select()
      .from(schema.runSteps)
      .where(eq(schema.runSteps.runId, run.id));
    expect(steps.map((s) => s.label)).toContain('Ran npm test: 3 passed');
  });

  it('waits while the owner has the screen, then answers that the owner has it', async () => {
    const bot = await newBot('Clicker', [
      [{ tool: 'computer', args: { action: 'click', coordinate: [5, 5] }, id: 'c1' }],
      [{ text: 'I will wait.' }],
    ]);
    const taken = await call('POST', `/bots/${bot.id}/screen/control`, { action: 'take' });
    expect(await taken.json()).toMatchObject({ display: 11 });
    const before = computer.agent.inputs.length;
    await call('POST', `/chats/${bot.chatId}/messages`, { text: 'Click it' });
    const run = await runOf(bot.id, 'completed');
    expect(computer.agent.inputs).toHaveLength(before);
    const result = (await partsOf(run.id)).find((p) => p.type === 'tool_result');
    expect(result).toMatchObject({
      result: { status: 'owner_has_screen', message: OWNER_HAS_SCREEN },
      label: 'Waiting: the owner has the screen',
    });
    expect(
      events.some(
        (e) =>
          e.type === 'bot.state' &&
          e.bot_id === bot.id &&
          e.payload.state === 'waiting' &&
          e.payload.currentAction === 'Waiting: the owner has the screen',
      ),
    ).toBe(true);
    await call('POST', `/bots/${bot.id}/screen/control`, { action: 'release' });
  });

  it('continues the action when the owner hands the screen back', async () => {
    options.takeoverWaitMs = 5_000;
    const bot = await newBot('Patient', [
      [{ tool: 'computer', args: { action: 'click', coordinate: [9, 9] }, id: 'c2' }],
      [{ text: 'Clicked.' }],
    ]);
    await call('POST', `/bots/${bot.id}/screen/control`, { action: 'take' });
    await call('POST', `/chats/${bot.chatId}/messages`, { text: 'Click it' });
    await until(async () => {
      const [row] = await t.db
        .select()
        .from(schema.botState)
        .where(eq(schema.botState.botId, bot.id));
      expect(row?.state).toBe('waiting');
    });
    await call('POST', `/bots/${bot.id}/screen/control`, { action: 'release' });
    const run = await runOf(bot.id, 'completed');
    expect(computer.agent.inputs.at(-1)).toEqual({
      n: 2,
      action: { action: 'click', x: 9, y: 9 },
    });
    expect((await partsOf(run.id)).find((p) => p.type === 'tool_result')).toMatchObject({
      result: { ok: true },
    });
  });

  it('posts one compact "Computer started" row when a run boots the computer (W3)', async () => {
    const startedRows = async (chatId?: string) =>
      (
        await t.db
          .select()
          .from(schema.messages)
          .where(chatId ? eq(schema.messages.chatId, chatId) : undefined)
      ).filter((m) =>
        (m.parts as MessagePart[]).some((p) => p.type === 'event' && p.kind === 'computer_started'),
      );
    // The owner's own start from the Computer page posts nothing.
    expect((await call('POST', '/computer/stop')).status).toBe(200);
    const before = (await startedRows()).length;
    expect((await call('POST', '/computer/start')).status).toBe(200);
    expect(await startedRows()).toHaveLength(before);
    expect((await call('POST', '/computer/stop')).status).toBe(200);

    // Two computer calls in one run that boots it: one row, in the run's chat.
    const bot = await newBot('Booter', [
      [{ tool: 'list_dir', args: {}, id: 'b1' }],
      [{ tool: 'list_dir', args: {}, id: 'b2' }],
      [{ text: 'Listed.' }],
    ]);
    await webhookRun(bot);
    const run = await runOf(bot.id, 'completed');
    const rows = await startedRows(bot.chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ authorType: 'system', runId: run.id });
    const part = (rows[0]!.parts as MessagePart[])[0]!;
    expect(part).toMatchObject({
      type: 'event',
      kind: 'computer_started',
      data: { runId: run.id, durationMs: expect.any(Number) },
    });
    expect(part.type === 'event' && part.text).toMatch(/^Computer started \d+\.\ds$/);
    expect(
      events.some((e) => e.type === 'message.created' && e.payload.message.id === rows[0]!.id),
    ).toBe(true);

    // Already running: the next run posts nothing.
    const again = await newBot('Second', [
      [{ tool: 'list_dir', args: {}, id: 'b3' }],
      [{ text: 'Listed again.' }],
    ]);
    await call('POST', `/chats/${again.chatId}/messages`, { text: 'List home' });
    await runOf(again.id, 'completed');
    expect(await startedRows(again.chatId)).toHaveLength(0);
  });

  it('says so in the row when the start updated the computer first (plan 16.3)', async () => {
    expect((await call('POST', '/computer/stop')).status).toBe(200);
    const old = t.deps.config.sandboxImage;
    t.deps.config.sandboxImage = 'ghcr.io/danielpang/openbots/computer:9.9.9';
    try {
      const bot = await newBot('Updater', [
        [{ tool: 'list_dir', args: {}, id: 'u1' }],
        [{ text: 'Listed.' }],
      ]);
      await webhookRun(bot);
      await runOf(bot.id, 'completed');
      const parts = (
        await t.db.select().from(schema.messages).where(eq(schema.messages.chatId, bot.chatId))
      ).flatMap((m) => m.parts as MessagePart[]);
      const row = parts.find((p) => p.type === 'event' && p.kind === 'computer_started');
      expect(row).toMatchObject({ data: { updated: true } });
      expect(row?.type === 'event' && row.text).toMatch(
        /^Updated your computer and started it \d+\.\ds$/,
      );
    } finally {
      t.deps.config.sandboxImage = old;
    }
  });

  it('holds bash while the owner has the screen (S-7)', async () => {
    options.takeoverWaitMs = 50;
    let runs = 0;
    computer.agent.exec = () => {
      runs++;
      return { stdout: '', exitCode: 0 };
    };
    const bot = await newBot('Scripter', [
      [{ tool: 'bash', args: { command: 'xdotool click 1' }, id: 'b2' }],
      [{ text: 'I will wait.' }],
    ]);
    await call('POST', `/bots/${bot.id}/screen/control`, { action: 'take' });
    await call('POST', `/chats/${bot.chatId}/messages`, { text: 'Click with xdotool' });
    const run = await runOf(bot.id, 'waiting');
    const [approval] = await t.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.runId, run.id));
    await call('POST', `/approvals/${approval!.id}/decide`, { decision: 'approve' });
    await runOf(bot.id, 'completed');
    expect(runs).toBe(0);
    expect((await partsOf(run.id)).find((p) => p.type === 'tool_result')).toMatchObject({
      result: { status: 'owner_has_screen', message: OWNER_HAS_SCREEN },
      label: 'Waiting: the owner has the screen',
    });

    await call('POST', `/bots/${bot.id}/screen/control`, { action: 'release' });
  });
  it('publishes a binary file as is and copies it back unchanged (A3)', async () => {
    computer.agent.files.set('out/chart.png', TINY_PNG);
    let artifactId = '';
    const bot = await newBot('Plotter', [
      [{ tool: 'publish_artifact', args: { path: 'out/chart.png' }, id: 'p1' }],
      () => [
        { tool: 'artifact_to_computer', args: { id: artifactId, path: 'copy.png' }, id: 'c1' },
      ],
      [{ text: 'Charted.' }],
    ]);
    const unsubscribe = await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => {
      if (e.type === 'artifact.created' && e.bot_id === bot.id) artifactId = e.payload.artifactId;
    });
    await call('POST', `/chats/${bot.chatId}/messages`, { text: 'Chart it' });
    const run = await runOf(bot.id, 'completed');
    await unsubscribe();

    expect((await partsOf(run.id)).find((p) => p.type === 'artifact')).toMatchObject({
      title: 'chart.png',
      kind: 'design',
    });
    const versions = (await (await call('GET', `/artifacts/${artifactId}/versions`)).json()) as {
      items: { mime: string; size: number; summary: string | null }[];
    };
    expect(versions.items).toMatchObject([
      { mime: 'image/png', size: TINY_PNG.byteLength, summary: null },
    ]);
    expect(computer.agent.files.get('copy.png')).toEqual(TINY_PNG);
  });
});
