import { randomUUID } from 'node:crypto';
import type { Job, JobQueue } from '@openbots/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { BullJobQueue } from './queue-bullmq.js';
import { MemoryJobQueue } from './queue-memory.js';

// One behaviour, two backends. The BullMQ suite needs a Redis server and runs
// only when REDIS_URL is set (`scripts/dev-setup.sh --services`).

const redisUrl = process.env.REDIS_URL;

interface Backend {
  make(): JobQueue<string>;
  dispose(queue: JobQueue<string>): Promise<void>;
}

const backends: [string, Backend | undefined][] = [
  [
    'memory',
    {
      make: () => new MemoryJobQueue<string>(),
      dispose: (queue) => queue.close(),
    },
  ],
  [
    'bullmq',
    redisUrl
      ? {
          make: () => new BullJobQueue<string>(`test-${randomUUID()}`, redisUrl),
          async dispose(queue) {
            await (queue as BullJobQueue<string>).obliterate();
            await queue.close();
          },
        }
      : undefined,
  ],
];

describe.each(backends)('%s job queue', (_, backend) => {
  const open: JobQueue<string>[] = [];
  const make = () => {
    const queue = backend!.make();
    open.push(queue);
    return queue;
  };

  afterEach(async () => {
    await Promise.all(open.splice(0).map((q) => backend!.dispose(q)));
  });

  it.skipIf(!backend)('starts jobs by priority, then age', async () => {
    const queue = make();
    for (const [data, priority] of [
      ['a', 3],
      ['b', 1],
      ['c', 2],
      ['d', 1],
      ['e', 3],
    ] as const) {
      await queue.enqueue('job', data, { priority });
    }
    const seen: string[] = [];
    await queue.process(async (job) => {
      seen.push(job.data);
    });
    await waitFor(() => seen.length === 5);
    expect(seen).toEqual(['b', 'd', 'c', 'a', 'e']);
  });

  it.skipIf(!backend)('runs one job per group at a time, by priority then age', async () => {
    const queue = make();
    const log: string[] = [];
    const active = new Map<string, number>();
    let overlap = false;
    await queue.enqueue('run', 'x1', { groupKey: 'bot-x', priority: 2 });
    await queue.enqueue('run', 'x2', { groupKey: 'bot-x', priority: 2 });
    await queue.enqueue('run', 'x3', { groupKey: 'bot-x', priority: 1 });
    await queue.enqueue('run', 'y1', { groupKey: 'bot-y', priority: 3 });
    await queue.process(
      async (job: Job<string>) => {
        const group = job.groupKey!;
        if (active.get(group)) overlap = true;
        active.set(group, (active.get(group) ?? 0) + 1);
        log.push(`start ${job.data}`);
        await sleep(40);
        log.push(`end ${job.data}`);
        active.set(group, active.get(group)! - 1);
      },
      { concurrency: 4 },
    );
    await waitFor(() => log.length === 8);
    expect(overlap).toBe(false);
    const starts = log.filter((l) => l.startsWith('start x'));
    // x1 took the free group on enqueue; then x3 outranks the older x2.
    expect(starts).toEqual(['start x1', 'start x3', 'start x2']);
    // Different groups run side by side.
    expect(log.indexOf('start y1')).toBeLessThan(log.indexOf('end x1'));
  });

  it.skipIf(!backend)('holds delayed jobs back', async () => {
    const queue = make();
    const seen: string[] = [];
    const startedAt = Date.now();
    let laterAt = 0;
    await queue.process(async (job) => {
      seen.push(job.data);
      if (job.data === 'later' || job.data === 'later-grouped') laterAt = Date.now();
    });
    await queue.enqueue('job', 'later', { delayMs: 300, priority: 1 });
    await queue.enqueue('job', 'later-grouped', { delayMs: 300, groupKey: 'g', priority: 1 });
    await queue.enqueue('job', 'now', { priority: 3 });
    await waitFor(() => seen.length === 3);
    expect(seen[0]).toBe('now');
    expect(new Set(seen.slice(1))).toEqual(new Set(['later', 'later-grouped']));
    expect(laterAt - startedAt).toBeGreaterThanOrEqual(250);
  });

  it.skipIf(!backend)('cancels jobs that have not started', async () => {
    const queue = make();
    const kept = await queue.enqueue('job', 'kept', { groupKey: 'g' });
    const waitingInGroup = await queue.enqueue('job', 'grouped', { groupKey: 'g' });
    const ungrouped = await queue.enqueue('job', 'plain');
    const delayed = await queue.enqueue('job', 'delayed', { delayMs: 60_000 });
    expect(await queue.cancel(waitingInGroup)).toBe(true);
    expect(await queue.cancel(ungrouped)).toBe(true);
    expect(await queue.cancel(delayed)).toBe(true);
    expect(await queue.cancel(randomUUID())).toBe(false);

    const seen: string[] = [];
    await queue.process(async (job) => {
      seen.push(job.data);
    });
    await waitFor(() => seen.length === 1);
    await sleep(100);
    expect(seen).toEqual(['kept']);
    expect(await queue.cancel(kept)).toBe(false);
  });

  it.skipIf(!backend)('frees the group when a handler throws', async () => {
    const queue = make();
    const seen: string[] = [];
    const errors: string[] = [];
    await queue.enqueue('job', 'boom', { groupKey: 'g' });
    await queue.enqueue('job', 'after', { groupKey: 'g' });
    await queue.process(
      async (job) => {
        seen.push(job.data);
        if (job.data === 'boom') throw new Error('boom');
      },
      { onError: (error, job) => errors.push(`${job.data}: ${(error as Error).message}`) },
    );
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual(['boom', 'after']);
    expect(errors).toEqual(['boom: boom']);
  });
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(5);
  }
}
