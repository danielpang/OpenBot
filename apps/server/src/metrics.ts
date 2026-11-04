import { count, inArray } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { routePath } from 'hono/route';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { schema, type Db } from './db/client.js';

// One registry per process: default Node metrics, an HTTP request histogram,
// and the OpenBots metrics below (plan 16.3), served at `GET /metrics`.
// `docs/grafana-dashboard.json` charts them.

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpMetrics = createMiddleware(async (c, next) => {
  const end = httpDuration.startTimer();
  try {
    await next();
  } finally {
    // The matched route pattern, not the raw path, keeps label cardinality low.
    end({ method: c.req.method, route: routePath(c, -1), status: String(c.res.status) });
  }
});

const runsFinished = new Counter({
  name: 'openbots_runs_finished_total',
  help: 'Runs that reached completed, failed or cancelled, by trigger',
  labelNames: ['status', 'trigger'] as const,
  registers: [registry],
});

const runDuration = new Histogram({
  name: 'openbots_run_duration_seconds',
  help: 'Wall time from a run starting to it finishing, waits included',
  labelNames: ['status'] as const,
  buckets: [1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [registry],
});

const FINISHED = new Set(['completed', 'failed', 'cancelled']);

/** Counts a run once it finishes; called with every status change (`publishRunStatus`). */
export function observeRun(run: {
  status: string;
  trigger: string;
  startedAt: Date | null;
  finishedAt: Date | null;
}) {
  if (!FINISHED.has(run.status)) return;
  runsFinished.inc({ status: run.status, trigger: run.trigger });
  if (run.startedAt && run.finishedAt) {
    const seconds = (run.finishedAt.getTime() - run.startedAt.getTime()) / 1000;
    runDuration.observe({ status: run.status }, Math.max(0, seconds));
  }
}

// Read from the database at scrape time, so every process reports the whole
// install whichever queue backend it runs on; chart it with max(), not sum().
const runsActive = new Gauge({
  name: 'openbots_runs',
  help: 'Runs queued (the run queue depth), running, or waiting on an approval or answer',
  labelNames: ['status'] as const,
  registers: [registry],
});

const ACTIVE = ['queued', 'running', 'waiting'] as const;

/** Refreshes the run gauges; `GET /metrics` calls it before rendering. */
export async function collectRunGauges(db: Db) {
  const rows = await db
    .select({ status: schema.runs.status, n: count() })
    .from(schema.runs)
    .where(inArray(schema.runs.status, [...ACTIVE]))
    .groupBy(schema.runs.status);
  for (const status of ACTIVE) {
    runsActive.set({ status }, rows.find((r) => r.status === status)?.n ?? 0);
  }
}

const webhookDeliveries = new Counter({
  name: 'openbots_webhook_deliveries_total',
  help: 'Inbound webhook requests by outcome, and outbound event delivery attempts by result',
  labelNames: ['direction', 'outcome'] as const,
  registers: [registry],
});

export type InboundOutcome = 'rejected' | 'rate_limited' | 'duplicate' | 'unmatched' | 'started';
export type OutboundOutcome = 'delivered' | 'retrying' | 'failed';

export function observeWebhook(direction: 'inbound', outcome: InboundOutcome): void;
export function observeWebhook(direction: 'outbound', outcome: OutboundOutcome): void;
export function observeWebhook(direction: string, outcome: string) {
  webhookDeliveries.inc({ direction, outcome });
}

const providerLatency = new Histogram({
  name: 'openbots_provider_step_duration_seconds',
  help: 'Duration of one model step (request to finished response) by provider and model',
  labelNames: ['provider', 'model'] as const,
  buckets: [0.25, 0.5, 1, 2, 4, 8, 15, 30, 60, 120, 300],
  registers: [registry],
});

export function observeProviderStep(provider: string, model: string, durationMs: number) {
  providerLatency.observe({ provider, model }, durationMs / 1000);
}

// The relay link (src/relay): whether this process is linked, and how many
// client streams it carries now.
const relayLinked = new Gauge({
  name: 'openbots_relay_linked',
  help: 'Whether this process holds a linked relay host link (1) or not (0)',
  registers: [registry],
});

const relayStreams = new Gauge({
  name: 'openbots_relay_streams',
  help: "Client streams open on this process's relay host link",
  registers: [registry],
});

export function setRelayLinked(linked: boolean) {
  relayLinked.set(linked ? 1 : 0);
}

export function setRelayStreams(streams: number) {
  relayStreams.set(streams);
}

// The data disk, as the standalone image's watcher reports it (readiness.ts).
const diskLow = new Gauge({
  name: 'openbots_disk_low',
  help: 'Whether the data disk is reported nearly full (1) or not (0)',
  registers: [registry],
});

export function setDiskLow(low: boolean) {
  diskLow.set(low ? 1 : 0);
}
