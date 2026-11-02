import { randomUUID } from 'node:crypto';
import type { EventBus } from '@openbots/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from './bus-memory.js';
import { RedisEventBus } from './bus-redis.js';

const redisUrl = process.env.REDIS_URL;

const backends: [string, (() => EventBus) | undefined][] = [
  ['memory', () => new MemoryEventBus()],
  ['redis', redisUrl ? () => new RedisEventBus(redisUrl) : undefined],
];

describe.each(backends)('%s event bus', (_, make) => {
  const open: EventBus[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((bus) => bus.close()));
  });

  it.skipIf(!make)('delivers JSON copies to subscribers of the channel only', async () => {
    const bus = make!();
    open.push(bus);
    const channel = `test:${randomUUID()}`;
    const got: unknown[] = [];
    const other: unknown[] = [];
    await bus.subscribe(channel, (event) => got.push(event));
    await bus.subscribe(`${channel}:other`, (event) => other.push(event));

    const event = { type: 'bot.state', at: new Date(0) };
    await bus.publish(channel, event);
    await waitFor(() => got.length === 1);
    expect(got[0]).toEqual({ type: 'bot.state', at: '1970-01-01T00:00:00.000Z' });
    expect(other).toEqual([]);
  });

  it.skipIf(!make)('stops delivering after unsubscribe', async () => {
    const bus = make!();
    open.push(bus);
    const channel = `test:${randomUUID()}`;
    const got: unknown[] = [];
    const unsubscribe = await bus.subscribe(channel, (event) => got.push(event));
    await bus.publish(channel, 1);
    await waitFor(() => got.length === 1);
    await unsubscribe();
    await bus.publish(channel, 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(got).toEqual([1]);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
