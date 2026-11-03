import type { Context } from 'hono';
import { positiveIntFromEnv } from './budget.js';

// `GET /ready` (docs/MOBILE_AND_VM_PLAN.md 5.8). `/healthz` says the process
// is up; `/ready` says this machine should get new connections. Fly's proxy
// routes only to machines whose checks pass, so a machine that is draining,
// sees fewer machines than the minimum, or is at its socket ceiling answers
// 503 and is skipped until that changes.
//
// A registry that cannot be reached does not make the machine unready: every
// machine would lose it at once, and Fly would then route to none of them.
// The machine serves on without it (ownership.ts, single-machine mode), and
// `/ready` reports the degradation in its body.
//
// The relay supplies the conditions; this module asks them all, each with a
// time limit, and answers 200 `{"status":"ready"}` (with `"degraded":[...]`
// when a degradation holds) or 503 `{"status":"unready","reasons":[...]}`. A
// condition that throws, rejects or does not answer in time counts as holding,
// under its own reason.

/** The reasons of plan 5.8. A relay may add conditions of its own with other reasons. */
export type UnreadyReason =
  'draining' | 'registry_unreachable' | 'cluster_too_small' | 'at_capacity';

/** One thing that can make the machine unready. */
export interface ReadinessCondition {
  reason: UnreadyReason | (string & NonNullable<unknown>);
  /** True while this condition holds. */
  unready(): boolean | Promise<boolean>;
  /** A degradation: reported in the body, but the machine stays ready. */
  degradesOnly?: boolean;
}

export type ReadinessResult =
  { ready: true; degraded: string[] } | { ready: false; reasons: string[]; degraded: string[] };

export interface ReadinessOptions {
  /** How long one condition may take to answer. Default 1 second. */
  timeoutMs: number;
}

export const DEFAULT_READINESS: ReadinessOptions = { timeoutMs: 1_000 };

export interface RelayReadinessInputs {
  /** The drain controller's `draining`. */
  draining(): boolean;
  /** Whether the registry (Redis) answers. Leave it out for a single machine without Redis. */
  registryReachable?(): boolean | Promise<boolean>;
  /** Live machines in the cluster, this one included. Leave it out for a single machine. */
  clusterSize?(): number | Promise<number>;
  /** `RELAY_MIN_CLUSTER_SIZE`. Default 1. */
  minClusterSize?: number;
  /** The budget's `full`: at the socket ceiling. */
  atCapacity(): boolean;
}

/** The conditions of plan 5.8, in the order their reasons are reported. */
export function relayConditions(inputs: RelayReadinessInputs): ReadinessCondition[] {
  const conditions: ReadinessCondition[] = [
    { reason: 'draining', unready: () => inputs.draining() },
  ];
  const { registryReachable, clusterSize } = inputs;
  if (registryReachable) {
    conditions.push({
      reason: 'registry_unreachable',
      unready: async () => !(await registryReachable()),
      degradesOnly: true,
    });
  }
  const minimum = inputs.minClusterSize ?? 1;
  if (clusterSize && minimum > 1) {
    conditions.push({
      reason: 'cluster_too_small',
      unready: async () => (await clusterSize()) < minimum,
    });
  }
  conditions.push({ reason: 'at_capacity', unready: () => inputs.atCapacity() });
  return conditions;
}

/** Asks every condition at once. */
export async function checkReadiness(
  conditions: readonly ReadinessCondition[],
  options: Partial<ReadinessOptions> = {},
): Promise<ReadinessResult> {
  const { timeoutMs } = { ...DEFAULT_READINESS, ...options };
  const verdicts = await Promise.all(
    conditions.map((condition) => askWithin(condition, timeoutMs)),
  );
  const holding = conditions.filter((_, index) => verdicts[index]);
  const reasons = holding.filter((c) => !c.degradesOnly).map((c) => c.reason);
  const degraded = holding.filter((c) => c.degradesOnly).map((c) => c.reason);
  return reasons.length === 0 ? { ready: true, degraded } : { ready: false, reasons, degraded };
}

/** The Hono handler for `GET /ready`. */
export function readyHandler(
  conditions: readonly ReadinessCondition[],
  options: Partial<ReadinessOptions> = {},
) {
  return async (c: Context) => {
    const result = await checkReadiness(conditions, options);
    c.header('cache-control', 'no-store');
    const degraded = result.degraded.length > 0 ? { degraded: result.degraded } : {};
    if (result.ready) return c.json({ status: 'ready' as const, ...degraded }, 200);
    return c.json({ status: 'unready' as const, reasons: result.reasons, ...degraded }, 503);
  };
}

/** True when the condition says unready, throws, or takes too long. */
async function askWithin(condition: ReadinessCondition, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => condition.unready()), late]);
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/** `RELAY_MIN_CLUSTER_SIZE`, default 1. */
export function minClusterSizeFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv(env, 'RELAY_MIN_CLUSTER_SIZE', 1);
}
