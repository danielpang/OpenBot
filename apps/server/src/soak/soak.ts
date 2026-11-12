import { conversationTools, defineTool, localEmbedder, type ToolGroup } from '@openbots/agent';
import { scriptedModel, type ScriptedTurn } from '@openbots/agent/testing';
import { EVENTS_CHANNEL, type WsEvent } from '@openbots/shared';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../db/client.js';
import { BOT_STATE_QUEUE, settleHandler, type SettleJob } from '../services/bot-state.js';
import {
  insertRun,
  registerRunHooks,
  RUNS_QUEUE,
  scheduleRun,
  TRIGGER_PRIORITY,
  type RunJob,
  type RunStatus,
  type RunTrigger,
} from '../services/runs.js';
import { createTestApp } from '../test-app.js';
import { createRunWorker, type RunWorkerOptions } from '../workers/runs.js';

// The 1.0 soak test (plan 18.9): a fixed number of runs kept in flight across
// several Bots and accounts for a long stretch, with the recorded-provider
// double in place of the model. Owner messages go through the API, Routine
// and webhook runs are enqueued at their own priorities, and a share of the
// owner's requests ask for approval, which the driver decides a moment later.
//
// It checks the queue's contract on every start, from the `run.status` events
// in the order they were published: one run per Bot at a time, and a run never
// starts ahead of a more urgent one that was already queued for its Bot when
// the Bot came free (plan 5.1, C3, R4). At the end the driver stops adding
// work, decides what is still pending and checks that nothing leaked: no run
// queued, running or waiting, no pending approval, no streaming message, no
// Bot left looking busy.
//
// The database is PGlite unless DATABASE_URL is set, and the queues are
// in-process unless REDIS_URL is set; against the compose stack, set both.

export interface SoakOptions {
  durationMs: number;
  /** Bots across all accounts. */
  bots?: number;
  accounts?: number;
  /** Runs kept queued, running or waiting at once. */
  inFlight?: number;
  /** Seed for the driver's choices, so a failure can be replayed. */
  seed?: number;
  /** Share of owner messages whose run asks for approval. */
  askRate?: number;
  /** Shares of new runs that are Routine and webhook runs (the rest are owner messages). */
  routineRate?: number;
  webhookRate?: number;
  /** Delay between streamed chunks of the model double. */
  chunkDelayMs?: number;
  /** How long the driver waits before deciding an approval, at most. */
  decideDelayMs?: number;
  /** How long the final drain may take. */
  drainTimeoutMs?: number;
  /** Progress lines; silent by default. */
  log?: (line: string) => void;
}

export interface SoakReport {
  backend: { db: 'pglite' | 'postgres'; infra: 'memory' | 'redis' };
  durationMs: number;
  runs: number;
  byTrigger: Partial<Record<RunTrigger, number>>;
  byStatus: Partial<Record<RunStatus, number>>;
  approvals: number;
  /** Most runs queued, running or waiting at once, as the driver saw it. */
  peakInFlight: number;
  /** Queue ordering violations, one line each. */
  violations: string[];
  /** What was still open after the drain, one line each. */
  leaks: string[];
}

interface Account {
  cookie: string;
}

interface SoakBot {
  id: string;
  chatId: string;
  handle: string;
  account: Account;
}

/** Queue bookkeeping per Bot, rebuilt from `run.status` events. */
interface BotQueue {
  /** Queued runs: priority and the event index they were queued at. */
  queued: Map<string, { priority: number; at: number }>;
  running: string | null;
  /** Event index the Bot last came free at. */
  freeAt: number;
}

const OPEN: RunStatus[] = ['queued', 'running', 'waiting'];
const BUSY_STATES = ['thinking', 'working', 'waiting'];

export async function runSoak(options: SoakOptions): Promise<SoakReport> {
  const {
    durationMs,
    bots: botCount = 10,
    accounts: accountCount = 2,
    inFlight = 20,
    seed = 1,
    askRate = 0.25,
    routineRate = 0.3,
    webhookRate = 0.15,
    chunkDelayMs = 2,
    decideDelayMs = 1_000,
    drainTimeoutMs = 60_000,
    log = () => {},
  } = options;
  const random = mulberry32(seed);
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;

  const t = await createTestApp({
    OPENBOTS_DEPLOYMENT: 'managed',
    OPENBOTS_SIGNUP_MODE: 'open',
    ...(process.env.REDIS_URL ? { REDIS_URL: process.env.REDIS_URL } : {}),
  });
  // The owner's handle for the harness's own reads; the app works under RLS.
  const { db } = t;
  const { infra } = t.deps;
  const unhook = registerRunHooks();

  const violations: string[] = [];
  const queues = new Map<string, BotQueue>();
  const requeues = new Map<string, number>();
  const triggers = new Map<string, RunTrigger>();
  let eventIndex = 0;

  // Every start is checked against the Bot's queue as the events left it.
  const onEvent = (event: WsEvent) => {
    if (event.type !== 'run.status' || !event.bot_id) return;
    const at = eventIndex++;
    const { runId, status } = event.payload as { runId: string; status: RunStatus };
    let queue = queues.get(event.bot_id);
    if (!queue) {
      queue = { queued: new Map(), running: null, freeAt: 0 };
      queues.set(event.bot_id, queue);
    }
    if (status === 'queued') {
      // The first queueing is at the trigger's priority, every later one is a resume.
      const times = requeues.get(runId) ?? 0;
      requeues.set(runId, times + 1);
      const trigger = triggers.get(runId);
      // Runs the API started are owner messages.
      const priority = times > 0 ? TRIGGER_PRIORITY.resume : TRIGGER_PRIORITY[trigger ?? 'message'];
      queue.queued.set(runId, { priority, at });
      return;
    }
    if (status === 'running') {
      if (queue.running && queue.running !== runId) {
        violations.push(`run ${runId} started while ${queue.running} was running for its Bot`);
      }
      const self = queue.queued.get(runId);
      if (self) {
        // Runs already queued when the Bot came free (or when this one was queued) had a say.
        const cutoff = Math.max(self.at, queue.freeAt);
        for (const [other, entry] of queue.queued) {
          if (other !== runId && entry.at < cutoff && entry.priority < self.priority) {
            violations.push(
              `run ${runId} (priority ${self.priority}) started ahead of ${other} (priority ${entry.priority})`,
            );
          }
        }
      }
      queue.queued.delete(runId);
      queue.running = runId;
      return;
    }
    // waiting or terminal
    queue.queued.delete(runId);
    if (queue.running === runId) {
      queue.running = null;
      queue.freeAt = at;
    }
  };
  await infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, onEvent);

  const toolGroups: ToolGroup[] = [
    conversationTools,
    {
      name: 'computer',
      tools: () => ({
        bash: defineTool({
          description: 'Run a shell command',
          inputSchema: z.object({ command: z.string() }),
          execute: async () => ({ exitCode: 0, stdout: 'ok' }),
        }),
      }),
    },
  ];

  // One reply per model call: after a tool result, wrap up; on an owner
  // request marked [ask], call `bash` (ask by default); otherwise answer.
  const turn: ScriptedTurn = (call) => {
    const last = call.prompt.at(-1);
    if (last?.role === 'tool') return [{ text: 'Done, the command finished.' }];
    // The owner's request, and the run's context message that follows it.
    const text = JSON.stringify(call.prompt.slice(-2).map((m) => m.content));
    if (text.includes('[ask]')) {
      return [{ text: 'Running it.' }, { tool: 'bash', args: { command: `make ${randomUUID()}` } }];
    }
    return [{ text: 'Handled it. Nothing else needs you.' }];
  };
  const workerOptions: RunWorkerOptions = {
    resolveModel: async () => ({
      model: scriptedModel(
        Array.from({ length: 16 }, () => turn),
        { chunkDelayMs },
      ),
      info: null,
      providerOptions: {},
    }),
    smallModel: async () => null,
    embedder: localEmbedder,
    toolGroups,
  };
  await infra.queue<RunJob>(RUNS_QUEUE).process(createRunWorker(t.deps, workerOptions), {
    concurrency: 8,
    onError: (error) => violations.push(`run job failed: ${String(error)}`),
  });
  await infra.queue<SettleJob>(BOT_STATE_QUEUE).process(settleHandler(t.deps), { concurrency: 4 });

  const call = async (account: Account, method: string, path: string, body?: unknown) => {
    const res = await t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        cookie: account.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json() as Promise<unknown>;
  };

  const accounts: Account[] = [];
  for (let i = 0; i < accountCount; i++) {
    const { cookie } = await t.signUp(`soak${i}@example.com`);
    if (!cookie) throw new Error('sign-up returned no session');
    accounts.push({ cookie });
  }
  const bots: SoakBot[] = [];
  for (let i = 0; i < botCount; i++) {
    const account = accounts[i % accounts.length]!;
    const bot = (await call(account, 'POST', '/bots', {
      name: `Soak ${i + 1}`,
      modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
    })) as Omit<SoakBot, 'account'>;
    bots.push({ ...bot, account });
  }
  const botIds = bots.map((b) => b.id);

  const openRuns = async () => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.runs)
      .where(and(inArray(schema.runs.botId, botIds), inArray(schema.runs.status, OPEN)));
    return row?.n ?? 0;
  };

  let counter = 0;
  const startOne = async () => {
    const bot = pick(bots);
    const roll = random();
    if (roll < routineRate + webhookRate) {
      // Recorded before scheduleRun publishes the run's first event.
      const trigger: RunTrigger = roll < routineRate ? 'routine' : 'webhook';
      // As a Routine or a webhook would, in the Bot's organization.
      await t.inOrganization(async () => {
        const row = await insertRun(t.deps.db, { botId: bot.id, chatId: bot.chatId, trigger });
        triggers.set(row.id, trigger);
        await scheduleRun(t.deps, row, 'run');
      });
      return;
    }
    // Owner messages: the API starts a `message` run or steers the open one.
    const ask = random() < askRate ? ' [ask]' : '';
    await call(bot.account, 'POST', `/chats/${bot.chatId}/messages`, {
      text: `Task ${++counter}${ask}`,
    });
  };

  const decided = new Set<string>();
  const decidePending = async (immediately: boolean) => {
    const pending = await db
      .select({
        id: schema.approvals.id,
        createdAt: schema.approvals.createdAt,
        botId: schema.runs.botId,
      })
      .from(schema.approvals)
      .innerJoin(schema.runs, eq(schema.runs.id, schema.approvals.runId))
      .where(and(eq(schema.approvals.status, 'pending'), inArray(schema.runs.botId, botIds)));
    const now = Date.now();
    for (const approval of pending) {
      if (decided.has(approval.id)) continue;
      if (!immediately && now - approval.createdAt.getTime() < random() * decideDelayMs) continue;
      decided.add(approval.id);
      const bot = bots.find((b) => b.id === approval.botId)!;
      await call(bot.account, 'POST', `/approvals/${approval.id}/decide`, {
        decision: random() < 0.8 ? 'approve' : 'deny',
      });
    }
  };

  const started = Date.now();
  let peakInFlight = 0;
  let lastLog = started;
  log(
    `soak: ${botCount} Bots, ${accountCount} accounts, ${inFlight} runs in flight, ${durationMs}ms`,
  );
  while (Date.now() - started < durationMs) {
    let open = await openRuns();
    const before = open;
    peakInFlight = Math.max(peakInFlight, open);
    // Top up until the count itself shows the target: an owner message to a
    // busy Bot steers its run instead of adding one, and runs finish while
    // others start, so one pass of starts can land short of it. The starts of
    // a round go together, so the top-up keeps pace with a fast backend; each
    // makes its random choices before it awaits, so the seed still replays.
    const fillStart = Date.now();
    while (open < inFlight && Date.now() - fillStart < drainTimeoutMs) {
      await Promise.all(Array.from({ length: inFlight - open }, startOne));
      open = await openRuns();
      peakInFlight = Math.max(peakInFlight, open);
    }
    await decidePending(false);
    if (Date.now() - lastLog > 60_000) {
      lastLog = Date.now();
      log(
        `soak: ${Math.round((lastLog - started) / 1000)}s, ${counter} messages, ${before} open, ${violations.length} violations`,
      );
    }
    await sleep(25);
  }

  // Drain: no new work; decide whatever asks until nothing is open.
  const drainStart = Date.now();
  while (Date.now() - drainStart < drainTimeoutMs) {
    await decidePending(true);
    if ((await openRuns()) === 0) break;
    await sleep(50);
  }
  // Bots settle from `done` to `idle` after a short delay; give them a moment.
  await sleep(200);

  const runs = await db.select().from(schema.runs).where(inArray(schema.runs.botId, botIds));
  const leaks: string[] = [];
  for (const run of runs) {
    if (OPEN.includes(run.status))
      leaks.push(`run ${run.id} (${run.trigger}) is still ${run.status}`);
    if (run.status === 'failed') leaks.push(`run ${run.id} (${run.trigger}) failed: ${run.error}`);
  }
  const approvals = await db
    .select({ id: schema.approvals.id, status: schema.approvals.status })
    .from(schema.approvals)
    .innerJoin(schema.runs, eq(schema.runs.id, schema.approvals.runId))
    .where(inArray(schema.runs.botId, botIds));
  for (const a of approvals) if (a.status === 'pending') leaks.push(`approval ${a.id} is pending`);
  const streaming = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(
      and(
        inArray(
          schema.messages.chatId,
          bots.map((b) => b.chatId),
        ),
        eq(schema.messages.status, 'streaming'),
      ),
    );
  for (const m of streaming) leaks.push(`message ${m.id} is still streaming`);
  const states = await db
    .select()
    .from(schema.botState)
    .where(inArray(schema.botState.botId, botIds));
  for (const s of states) {
    if (BUSY_STATES.includes(s.state)) leaks.push(`Bot ${s.botId} is left ${s.state}`);
  }
  for (const [botId, queue] of queues) {
    if (queue.running) leaks.push(`Bot ${botId} never finished run ${queue.running}`);
    for (const runId of queue.queued.keys())
      leaks.push(`run ${runId} was queued and never started`);
  }

  const byTrigger: SoakReport['byTrigger'] = {};
  const byStatus: SoakReport['byStatus'] = {};
  for (const run of runs) {
    byTrigger[run.trigger] = (byTrigger[run.trigger] ?? 0) + 1;
    byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
  }
  const report: SoakReport = {
    backend: { db: t.testDb.kind, infra: infra.kind },
    durationMs: Date.now() - started,
    runs: runs.length,
    byTrigger,
    byStatus,
    approvals: approvals.length,
    peakInFlight,
    violations,
    leaks,
  };

  unhook();
  await t.close();
  return report;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A small seeded PRNG, so a soak run can be replayed with its seed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
