import { wsEvent } from '@openbots/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWsClient, type WebSocketLike, type WsClientOptions } from './ws.js';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  sent: unknown[] = [];

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.drop();
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const chat = '7a1c1d6e-6a36-4c39-9f5e-0d0f0b7d5d01';
const bot = '0b3e9a52-2a8d-4e0c-bc1e-5f1c4a2b9e02';

describe('createWsClient', () => {
  let sockets: FakeSocket[];
  const latest = () => sockets.at(-1)!;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = (extra: Partial<WsClientOptions>) =>
    createWsClient({
      url: 'ws://test/ws',
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      ...extra,
    });

  it('subscribes once open and dispatches typed events', () => {
    const client = make({});
    client.subscribe({ chats: [chat], bots: [bot] });
    latest().open();
    expect(latest().sent).toEqual([{ type: 'subscribe', chats: [chat], bots: [bot] }]);

    const states: string[] = [];
    const all: string[] = [];
    client.on('bot.state', (e) => states.push(e.payload.state));
    client.onEvent((e) => all.push(e.type));
    latest().receive(
      wsEvent('bot.state', { botId: bot, state: 'working', currentAction: null, runId: null }),
    );
    latest().receive(wsEvent('artifact.created', { artifactId: bot, title: 'Plan' }));
    latest().receive({ type: 'garbage' });
    expect(states).toEqual(['working']);
    expect(all).toEqual(['bot.state', 'artifact.created']);
    client.close();
  });

  it('reconnects with backoff and asks to resync from the last seq seen', async () => {
    const resyncs: [string, number][] = [];
    const client = make({ onResync: (id, since) => void resyncs.push([id, since]) });
    client.subscribe({ chats: [chat] });
    latest().open();
    latest().receive(
      wsEvent(
        'reaction.added',
        { messageId: bot, emoji: '👍', reactorType: 'user', reactorId: bot },
        { chat_id: chat, seq: 4 },
      ),
    );
    expect(resyncs).toEqual([]);

    latest().drop();
    expect(client.status).toBe('closed');
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    latest().open();
    expect(latest().sent).toEqual([{ type: 'subscribe', chats: [chat], bots: [] }]);
    expect(resyncs).toEqual([[chat, 4]]);
    client.close();
  });

  it('pings and reconnects a silent socket', async () => {
    const client = make({ pingMs: 1000 });
    latest().open();
    await vi.advanceTimersByTimeAsync(1000);
    expect(latest().sent).toEqual([{ type: 'ping' }]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets[0]!.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    client.close();
  });

  it('stops for good on close', async () => {
    const client = make({});
    latest().open();
    client.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(client.status).toBe('closed');
  });
});
