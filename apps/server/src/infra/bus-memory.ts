import type { EventBus, Unsubscribe } from '@openbots/shared';

// The in-process EventBus. Events are delivered asynchronously and as JSON
// copies, the way they arrive through Redis, so code that works here works
// across processes.

type Handler = (event: unknown) => void;

export class MemoryEventBus implements EventBus {
  private readonly channels = new Map<string, Set<Handler>>();

  async publish<E>(channel: string, event: E): Promise<void> {
    const handlers = this.channels.get(channel);
    if (!handlers?.size) return;
    const json = JSON.stringify(event);
    for (const handler of [...handlers]) {
      queueMicrotask(() => handler(JSON.parse(json)));
    }
  }

  async subscribe<E>(channel: string, handler: (event: E) => void): Promise<Unsubscribe> {
    const h = handler as Handler;
    let handlers = this.channels.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.channels.set(channel, handlers);
    }
    handlers.add(h);
    return async () => {
      handlers.delete(h);
      if (!handlers.size) this.channels.delete(channel);
    };
  }

  async close(): Promise<void> {
    this.channels.clear();
  }
}
