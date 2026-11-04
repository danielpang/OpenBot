import { describe, expect, it, vi } from 'vitest';
import type { WsClient } from '@openbots/api-client';
import { withSubscriptionCounts } from './subscriptions';

describe('shared chat subscriptions', () => {
  it('retains the roster subscription when a transcript closes, then releases the last consumer', () => {
    const underlying: WsClient = {
      status: 'open',
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      on: vi.fn(),
      onEvent: vi.fn(),
      noteSeq: vi.fn(),
      close: vi.fn(),
    };
    const client = withSubscriptionCounts(underlying);
    client.subscribe({ chats: ['chat'], bots: ['bot'] }); // roster
    client.subscribe({ chats: ['chat'] }); // transcript
    client.unsubscribe({ chats: ['chat'] });
    expect(underlying.unsubscribe).not.toHaveBeenCalled();
    expect(underlying.subscribe).toHaveBeenCalledTimes(1);
    client.unsubscribe({ chats: ['chat'], bots: ['bot'] });
    expect(underlying.unsubscribe).toHaveBeenCalledWith({ chats: ['chat'], bots: ['bot'] });
    client.unsubscribe({ chats: ['chat'] });
    expect(underlying.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
