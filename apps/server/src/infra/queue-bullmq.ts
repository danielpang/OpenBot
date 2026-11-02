import { randomUUID } from 'node:crypto';
import {
  PRIORITY,
  type EnqueueOptions,
  type Job,
  type JobHandler,
  type JobQueue,
  type ProcessOptions,
} from '@openbots/shared';
import { Queue, Worker, type Job as BullJob } from 'bullmq';
import { Redis } from 'ioredis';

// The production JobQueue on BullMQ. BullMQ orders waiting jobs by priority
// (1 highest), then insertion, but has no per-group lock in its open-source
// edition, so groups (a Bot's run lock, plan 5.1) are kept here in Redis:
//
//   <prefix>:jobs              hash  job id -> stored job, while it waits in a group
//   <prefix>:g:<key>:pending   zset  job ids scored by priority, then enqueue order
//   <prefix>:g:<key>:lock      string "<job id>|<ms>" of the job holding the group
//
// A grouped job waits in its zset until the group is free, then is added to
// BullMQ and holds the lock until its handler returns. queue-memory.ts mirrors
// this exactly; change both together.

const PREFIX = 'openbots';
const DELAYED = '__openbots_delayed';
/** A lock older than this whose job is missing from BullMQ is taken back. */
const STALE_LOCK_MS = 30_000;
/** Score = priority * ORDER_SPAN + enqueue order. */
const ORDER_SPAN = 1e12;

interface StoredJob<T> {
  id: string;
  name: string;
  data: T;
  priority: number;
  groupKey?: string;
  order: number;
}

/** What a BullMQ job carries. */
interface Wrapped<T> {
  data: T;
  priority: number;
  groupKey?: string;
}

const PUMP = `
if redis.call('exists', KEYS[2]) == 1 then return false end
local head = redis.call('zrange', KEYS[1], 0, 0)
if #head == 0 then return false end
redis.call('zrem', KEYS[1], head[1])
redis.call('set', KEYS[2], head[1] .. '|' .. ARGV[1])
return redis.call('hget', KEYS[3], head[1])
`;

const RELEASE = `
local v = redis.call('get', KEYS[1])
if v and string.sub(v, 1, #ARGV[1] + 1) == ARGV[1] .. '|' then
  redis.call('del', KEYS[1])
  return 1
end
return 0
`;

const CANCEL_PENDING = `
if redis.call('zrem', KEYS[1], ARGV[1]) == 1 then
  redis.call('hdel', KEYS[2], ARGV[1])
  return 1
end
return 0
`;

export class BullJobQueue<T = unknown> implements JobQueue<T> {
  private readonly redis: Redis;
  private readonly queue: Queue;
  private worker?: Worker;
  private workerConnection?: Redis;
  private readonly keys: string;

  constructor(
    readonly name: string,
    private readonly url: string,
  ) {
    this.redis = new Redis(url, { maxRetriesPerRequest: null });
    this.queue = new Queue(name, {
      connection: this.redis,
      prefix: PREFIX,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: { count: 1000 } },
    });
    this.keys = `${PREFIX}:${name}:groups`;
  }

  async enqueue(name: string, data: T, options: EnqueueOptions = {}): Promise<string> {
    const { priority = PRIORITY.normal, groupKey, delayMs = 0 } = options;
    const id = randomUUID();
    if (!groupKey) {
      await this.queue.add(name, { data, priority } satisfies Wrapped<T>, {
        jobId: id,
        priority,
        delay: delayMs > 0 ? delayMs : undefined,
      });
      return id;
    }
    const order = await this.redis.incr(`${this.keys}:order`);
    const stored: StoredJob<T> = { id, name, data, priority, groupKey, order };
    if (delayMs > 0) {
      await this.queue.add(DELAYED, stored, {
        jobId: delayedId(id),
        priority: PRIORITY.interactive,
        delay: delayMs,
      });
    } else {
      await this.admit(stored);
    }
    return id;
  }

  async process(handler: JobHandler<T>, options: ProcessOptions = {}): Promise<void> {
    if (this.worker) throw new Error('process() was already called on this queue');
    this.workerConnection = new Redis(this.url, { maxRetriesPerRequest: null });
    this.worker = new Worker(
      this.name,
      async (bull: BullJob) => {
        if (bull.name === DELAYED) {
          await this.admit(bull.data as StoredJob<T>);
          return;
        }
        const wrapped = bull.data as Wrapped<T>;
        const job: Job<T> = {
          id: bull.id!,
          name: bull.name,
          data: wrapped.data,
          priority: wrapped.priority,
          groupKey: wrapped.groupKey,
        };
        try {
          await handler(job);
        } catch (error) {
          options.onError?.(error, job as Job);
          throw error;
        } finally {
          if (job.groupKey) await this.release(job.groupKey, job.id);
        }
      },
      { connection: this.workerConnection, prefix: PREFIX, concurrency: options.concurrency ?? 1 },
    );
    // Errors are reported through onError; keep BullMQ's own from being unhandled.
    this.worker.on('error', () => {});
    await this.worker.waitUntilReady();
  }

  async cancel(jobId: string): Promise<boolean> {
    const stored = await this.redis.hget(`${this.keys}:jobs`, jobId);
    if (stored) {
      const { groupKey } = JSON.parse(stored) as StoredJob<T>;
      const removed = await this.redis.eval(
        CANCEL_PENDING,
        2,
        this.groupKey(groupKey!, 'pending'),
        `${this.keys}:jobs`,
        jobId,
      );
      if (removed === 1) return true;
    }
    for (const id of [delayedId(jobId), jobId]) {
      const job = await this.queue.getJob(id);
      if (!job) continue;
      const state = await job.getState();
      if (state !== 'waiting' && state !== 'prioritized' && state !== 'delayed') return false;
      try {
        await job.remove();
      } catch {
        return false; // picked up by a worker in the meantime
      }
      const groupKey = (job.data as Wrapped<T>).groupKey;
      if (id === jobId && groupKey) await this.release(groupKey, jobId);
      return true;
    }
    return false;
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    this.workerConnection?.disconnect();
    this.redis.disconnect();
  }

  /** Removes everything this queue stored. Tests only. */
  async obliterate(): Promise<void> {
    await this.queue.obliterate({ force: true });
    const keys = await this.redis.keys(`${this.keys}:*`);
    if (keys.length) await this.redis.del(...keys);
  }

  private groupKey(groupKey: string, part: 'pending' | 'lock') {
    return `${this.keys}:g:${groupKey}:${part}`;
  }

  /** Puts a grouped job in its group and starts it if the group is free. */
  private async admit(stored: StoredJob<T>) {
    const groupKey = stored.groupKey!;
    await this.redis
      .multi()
      .hset(`${this.keys}:jobs`, stored.id, JSON.stringify(stored))
      .zadd(
        this.groupKey(groupKey, 'pending'),
        stored.priority * ORDER_SPAN + stored.order,
        stored.id,
      )
      .exec();
    await this.pump(groupKey);
  }

  /** Hands the group's next job to BullMQ when nothing in the group holds the lock. */
  private async pump(groupKey: string) {
    await this.healLock(groupKey);
    const raw = (await this.redis.eval(
      PUMP,
      3,
      this.groupKey(groupKey, 'pending'),
      this.groupKey(groupKey, 'lock'),
      `${this.keys}:jobs`,
      String(Date.now()),
    )) as string | null;
    if (!raw) return;
    await this.start(JSON.parse(raw) as StoredJob<T>);
  }

  private async start(stored: StoredJob<T>) {
    const { id, name, data, priority, groupKey } = stored;
    await this.queue.add(name, { data, priority, groupKey } satisfies Wrapped<T>, {
      jobId: id,
      priority,
    });
    await this.redis.hdel(`${this.keys}:jobs`, id);
  }

  private async release(groupKey: string, jobId: string) {
    await this.redis.eval(RELEASE, 1, this.groupKey(groupKey, 'lock'), jobId);
    await this.pump(groupKey);
  }

  /**
   * Recovers a group whose lock holder never reached BullMQ (the process died
   * between taking the lock and adding the job): re-adds the job if it is
   * still stored, or frees the group.
   */
  private async healLock(groupKey: string) {
    const lock = await this.redis.get(this.groupKey(groupKey, 'lock'));
    if (!lock) return;
    const [jobId, since] = lock.split('|');
    if (!jobId || Date.now() - Number(since) < STALE_LOCK_MS) return;
    if (await this.queue.getJob(jobId)) return;
    const stored = await this.redis.hget(`${this.keys}:jobs`, jobId);
    if (stored) {
      await this.redis.set(this.groupKey(groupKey, 'lock'), `${jobId}|${Date.now()}`);
      await this.start(JSON.parse(stored) as StoredJob<T>);
    } else {
      await this.redis.eval(RELEASE, 1, this.groupKey(groupKey, 'lock'), jobId);
    }
  }
}

function delayedId(jobId: string) {
  return `${jobId}.delayed`;
}
