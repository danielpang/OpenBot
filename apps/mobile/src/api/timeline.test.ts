import { describe, expect, it, vi } from 'vitest';
import { wsEvent } from '@openbots/shared';
import { applyEvent, mergeMessages, readResync, type Message } from './timeline';
const message = (id = 'a', seq = 1): Message => ({
  id,
  seq,
  chatId: 'chat',
  threadRootId: null,
  authorType: 'bot',
  authorId: 'bot',
  parts: [{ type: 'text', text: 'Hello' }],
  mentions: [],
  mentionEveryone: false,
  runId: null,
  status: 'streaming',
  deltaSeq: 0,
  updatedSeq: seq,
  createdAt: '2026-01-01T00:00:00Z',
});
describe('mobile streaming transcript', () => {
  it('deduplicates REST/events and does not overwrite completed streamed content with a stale page', () => {
    const completed = { ...message(), status: 'complete' as const, deltaSeq: 2 };
    expect(mergeMessages([completed], [message(), message('b', 2)])).toEqual([
      completed,
      message('b', 2),
    ]);
  });
  it('applies only contiguous deltas and preserves unrelated row references', () => {
    const other = message('b', 2);
    const event = wsEvent(
      'message.delta',
      { messageId: 'a', deltaSeq: 1, deltas: [{ partIndex: 0, type: 'text', text: ' world' }] },
      { chat_id: 'chat', seq: 1 },
    );
    const first = applyEvent([message(), other], event);
    expect(first.messages[0]?.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(first.messages[1]).toBe(other);
    expect(applyEvent(first.messages, event).messages).toBe(first.messages);
    expect(
      applyEvent(first.messages, { ...event, payload: { ...event.payload, deltaSeq: 3 } }).gap,
    ).toBe(true);
  });
  it('resyncs missing completion content and applies deletions', () => {
    const event = wsEvent('message.completed', { messageId: 'a', status: 'complete', deltaSeq: 2 });
    expect(applyEvent([message()], event).gap).toBe(true);
    const deleted = wsEvent('message.deleted', { messageId: 'a', chatId: 'chat' });
    expect(applyEvent([message()], deleted).messages).toEqual([]);
  });
  it('paginates by updatedSeq rather than message creation order', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ ...message('old', 1), updatedSeq: 20 }],
        deleted: [],
        hasMore: true,
      })
      .mockResolvedValueOnce({ messages: [message('new', 22)], deleted: [], hasMore: false });
    const apply = vi.fn();
    await readResync(read, 0, apply);
    expect(read.mock.calls).toEqual([[0], [20]]);
    expect(apply).toHaveBeenCalledTimes(2);
  });
  it('refuses an endless broken server cursor', async () => {
    await expect(
      readResync(
        async () => ({ messages: [], deleted: [], hasMore: true }),
        5,
        () => {},
      ),
    ).rejects.toThrow('without progress');
  });
});
