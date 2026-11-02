import { randomUUID } from 'node:crypto';
import {
  PRIORITY,
  type EnqueueOptions,
  type Job,
  type JobHandler,
  type JobQueue,
  type ProcessOptions,
} from '@openbots/shared';

// The in-process JobQueue, used by tests and by `pnpm dev` without Redis. It
// mirrors queue-bullmq.ts step for step: a grouped job waits in its group
// until the group is free, then joins the shared ready list; the ready list
// starts jobs by priority, then by the order they became ready.

interface Entry<T> {
  job: Job<T>;
  /** Enqueue order; breaks priority ties inside a group. */
  order: number;
  /** Order the job became ready; breaks priority ties in the ready list. */
  readyOrder: number;
}

interface Group<T> {
  /** The job holding the group, from the moment it becomes ready until it finishes. */
  active?: string;
  pending: Entry<T>[];
}

export class MemoryJobQueue<T = unknown> implements JobQueue<T> {
  private counter = 0;
  private readonly ready: Entry<T>[] = [];
  private readonly groups = new Map<string, Group<T>>();
  private readonly delayed = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();
  private handler?: JobHandler<T>;
  private options: ProcessOptions = {};
  private closed = false;

  async enqueue(name: string, data: T, options: EnqueueOptions = {}): Promise<string> {
    const { priority = PRIORITY.normal, groupKey, delayMs = 0 } = options;
    const job: Job<T> = { id: randomUUID(), name, data, priority, groupKey };
    const entry: Entry<T> = { job, order: this.counter++, readyOrder: 0 };
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        this.delayed.delete(job.id);
        this.admit(entry);
      }, delayMs);
      timer.unref();
      this.delayed.set(job.id, timer);
    } else {
      this.admit(entry);
    }
    return job.id;
  }

  async process(handler: JobHandler<T>, options: ProcessOptions = {}): Promise<void> {
    if (this.handler) throw new Error('process() was already called on this queue');
    this.handler = handler;
    this.options = options;
    this.drain();
  }

  async cancel(jobId: string): Promise<boolean> {
    const timer = this.delayed.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.delayed.delete(jobId);
      return true;
    }
    const index = this.ready.findIndex((e) => e.job.id === jobId);
    if (index >= 0) {
      const [entry] = this.ready.splice(index, 1);
      if (entry?.job.groupKey) this.release(entry.job.groupKey, jobId);
      return true;
    }
    for (const group of this.groups.values()) {
      const at = group.pending.findIndex((e) => e.job.id === jobId);
      if (at >= 0) {
        group.pending.splice(at, 1);
        return true;
      }
    }
    return false;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.delayed.values()) clearTimeout(timer);
    this.delayed.clear();
    await Promise.allSettled(this.running.values());
  }

  private admit(entry: Entry<T>) {
    const { groupKey } = entry.job;
    if (!groupKey) {
      this.makeReady(entry);
      return;
    }
    let group = this.groups.get(groupKey);
    if (!group) {
      group = { pending: [] };
      this.groups.set(groupKey, group);
    }
    insertSorted(group.pending, entry, (e) => [e.job.priority, e.order]);
    this.pump(groupKey);
  }

  /** Moves the group's next job to the ready list if nothing in the group is active. */
  private pump(groupKey: string) {
    const group = this.groups.get(groupKey);
    if (!group || group.active) return;
    const next = group.pending.shift();
    if (!next) {
      this.groups.delete(groupKey);
      return;
    }
    group.active = next.job.id;
    this.makeReady(next);
  }

  private release(groupKey: string, jobId: string) {
    const group = this.groups.get(groupKey);
    if (group?.active === jobId) group.active = undefined;
    this.pump(groupKey);
  }

  private makeReady(entry: Entry<T>) {
    entry.readyOrder = this.counter++;
    insertSorted(this.ready, entry, (e) => [e.job.priority, e.readyOrder]);
    this.drain();
  }

  private drain() {
    const handler = this.handler;
    if (!handler || this.closed) return;
    const concurrency = this.options.concurrency ?? 1;
    while (this.running.size < concurrency) {
      const entry = this.ready.shift();
      if (!entry) return;
      const { job } = entry;
      const run = Promise.resolve()
        .then(() => handler(job))
        .catch((error: unknown) => this.options.onError?.(error, job as Job))
        .finally(() => {
          this.running.delete(job.id);
          if (job.groupKey) this.release(job.groupKey, job.id);
          this.drain();
        });
      this.running.set(job.id, run);
    }
  }
}

function insertSorted<E>(list: E[], item: E, key: (e: E) => [number, number]) {
  const [a, b] = key(item);
  const at = list.findIndex((other) => {
    const [x, y] = key(other);
    return x > a || (x === a && y > b);
  });
  if (at < 0) list.push(item);
  else list.splice(at, 0, item);
}
