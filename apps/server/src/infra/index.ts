import { EVENTS_CHANNEL, type EventBus, type JobQueue, type WsEvent } from '@openbots/shared';
import type { Config } from '../config.js';
import { currentWorkspace, inWorkspace } from '../db/scope.js';
import { RedisEventBus } from './bus-redis.js';
import { MemoryEventBus } from './bus-memory.js';
import { BullJobQueue } from './queue-bullmq.js';
import { MemoryJobQueue } from './queue-memory.js';
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from './rate-limit.js';

// Queues, the event bus and the rate limiter: Redis-backed when REDIS_URL is
// set, in-process otherwise. In-process only works when the API and the
// workers share one process (OPENBOTS_ROLE=all).

export interface Infra {
  kind: 'redis' | 'memory';
  bus: EventBus;
  /** Token buckets for auth and webhook ingress (rate-limit.ts). */
  limiter: RateLimiter;
  /** The named queue, created on first use. */
  queue<T = unknown>(name: string): JobQueue<T>;
  close(): Promise<void>;
}

export function createInfra(
  config: Pick<Config, 'redisUrl'>,
  onError: (error: unknown) => void = () => {},
): Infra {
  const url = config.redisUrl;
  const queues = new Map<string, JobQueue<unknown>>();
  const bus: EventBus = url ? new RedisEventBus(url, onError) : new MemoryEventBus();
  const limiter: RateLimiter = url ? new RedisRateLimiter(url, onError) : new MemoryRateLimiter();
  return {
    kind: url ? 'redis' : 'memory',
    bus,
    limiter,
    queue<T>(name: string) {
      let queue = queues.get(name);
      if (!queue) {
        queue = scopedQueue(url ? new BullJobQueue(name, url) : new MemoryJobQueue());
        queues.set(name, queue);
      }
      return queue as JobQueue<T>;
    },
    async close() {
      await Promise.allSettled([...queues.values()].map((q) => q.close()));
      await bus.close();
      await limiter.close();
    },
  };
}

/**
 * Publishes a realtime event for the WS gateway to forward (plan 14.2),
 * with the organization of the work that made it, so whoever handles it
 * works there (db/scope.ts).
 */
export function publishEvent(bus: EventBus, event: WsEvent): Promise<void> {
  const workspaceId = event.workspace_id ?? currentWorkspace();
  return bus.publish(EVENTS_CHANNEL, workspaceId ? { ...event, workspace_id: workspaceId } : event);
}

/** A job's organization, kept beside its own data. */
export interface ScopedJobData {
  workspaceId?: string;
}

/**
 * Every job belongs to an organization and runs there (db/scope.ts). The
 * queuing code names it in `workspaceId`, from the row the job is for, or it
 * is the scope's; a job for another organization than the scope's, or for
 * none, is refused. `process` runs the handler in the job's organization.
 */
export function scopedQueue<T>(queue: JobQueue<T>): JobQueue<T> {
  return {
    enqueue(name, data, options) {
      const named = (data as ScopedJobData).workspaceId;
      const scope = currentWorkspace();
      if (named && scope && named !== scope) {
        return Promise.reject(new Error(`job ${name} is for another organization than its scope`));
      }
      const workspaceId = named ?? scope;
      if (!workspaceId) {
        return Promise.reject(new Error(`job ${name} was queued outside an organization`));
      }
      return queue.enqueue(name, { ...(data as object), workspaceId } as T, options);
    },
    process(handler, options) {
      return queue.process(async (job) => {
        const { workspaceId } = job.data as ScopedJobData;
        if (typeof workspaceId !== 'string') throw new Error(`job ${job.id} has no organization`);
        await inWorkspace(workspaceId, () => handler(job));
      }, options);
    },
    cancel: (jobId) => queue.cancel(jobId),
    close: () => queue.close(),
  };
}
