import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import type { CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { assertBotOwner } from '../ownership.js';

// A Bot's usage over recent days (plan 5.8), for its Settings page: the sums
// of `runs.usage` (tokens, model calls and the estimated cost the worker
// stored with each run), in total, by UTC day and by model.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;

export const USAGE_DAYS = { default: 30, max: 365 } as const;

export interface UsageSums {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  steps: number;
  /** The sum of the runs' estimates; null when no run had one (its model has no pricing). */
  costUsd: number | null;
  /** Runs whose model had no pricing, so the estimate leaves them out. */
  unpricedRuns: number;
}

export interface BotUsage {
  days: number;
  /** The window's start: midnight UTC, `days - 1` days before today. */
  since: Date;
  totals: UsageSums;
  /** Days with runs, oldest first, as `YYYY-MM-DD` in UTC. */
  daily: (UsageSums & { date: string })[];
  /** Most expensive first, then most tokens. */
  models: (UsageSums & { model: string | null })[];
}

const field = (name: string) =>
  sql`coalesce(sum((${schema.runs.usage} ->> ${name})::bigint), 0)`.mapWith(Number);

const sums = {
  runs: sql`count(*)`.mapWith(Number),
  inputTokens: field('inputTokens'),
  outputTokens: field('outputTokens'),
  cachedInputTokens: field('cachedInputTokens'),
  steps: field('steps'),
  costUsd: sql<number | null>`sum((${schema.runs.usage} ->> 'costUsd')::double precision)`.mapWith(
    (v) => (v === null ? null : Number(v)),
  ),
  unpricedRuns: sql`count(*) filter (where ${schema.runs.usage} ->> 'costUsd' is null)`.mapWith(
    Number,
  ),
};

export async function botUsage(
  db: Db,
  owner: Owner,
  botId: string,
  days: number = USAGE_DAYS.default,
  now: Date = new Date(),
): Promise<BotUsage> {
  await assertBotOwner(db, owner, botId);
  const since = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)),
  );
  const where = and(
    eq(schema.runs.botId, botId),
    gte(schema.runs.createdAt, since),
    // Runs that called a model; one paused before its first step has nothing to count.
    sql`coalesce((${schema.runs.usage} ->> 'steps')::int, 0) > 0`,
  );
  const day: SQL<string> = sql<string>`to_char(${schema.runs.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const [totals] = await db.select(sums).from(schema.runs).where(where);
  const daily = await db
    .select({ date: day, ...sums })
    .from(schema.runs)
    .where(where)
    .groupBy(day)
    .orderBy(day);
  const models = await db
    .select({ model: schema.runs.model, ...sums })
    .from(schema.runs)
    .where(where)
    .groupBy(schema.runs.model)
    .orderBy(desc(sql`coalesce(${sums.costUsd}, 0)`), desc(sums.inputTokens));
  return { days, since, totals: totals!, daily, models };
}
