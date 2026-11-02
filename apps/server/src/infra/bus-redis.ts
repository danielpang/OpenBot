import type { EventBus, Unsubscribe } from '@openbots/shared';
import { Redis } from 'ioredis';

// The EventBus on Redis pub/sub: workers publish, every API instance receives
// and forwards to its sockets (plan 14.2). A subscribed connection cannot
// publish, so there are two.

type Handler = (event: unknown) => void;

export class RedisEventBus implements EventBus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly channels = new Map<string, Set<Handler>>();

  constructor(
    url: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.pub = new Redis(url);
    this.sub = new Redis(url);
    this.sub.on('message', (channel: string, message: string) => {
      const handlers = this.channels.get(channel);
      if (!handlers) return;
      let event: unknown;
      try {
        event = JSON.parse(message);
      } catch (error) {
        this.onError(error);
        return;
      }
      for (const handler of [...handlers]) handler(event);
    });
    this.pub.on('error', onError);
    this.sub.on('error', onError);
  }

  async publish<E>(channel: string, event: E): Promise<void> {
    await this.pub.publish(channel, JSON.stringify(event));
  }

  async subscribe<E>(channel: string, handler: (event: E) => void): Promise<Unsubscribe> {
    const h = handler as Handler;
    let handlers = this.channels.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.channels.set(channel, handlers);
      await this.sub.subscribe(channel);
    }
    handlers.add(h);
    return async () => {
      handlers.delete(h);
      if (!handlers.size && this.channels.get(channel) === handlers) {
        this.channels.delete(channel);
        await this.sub.unsubscribe(channel);
      }
    };
  }

  async close(): Promise<void> {
    this.channels.clear();
    this.pub.disconnect();
    this.sub.disconnect();
  }
}
