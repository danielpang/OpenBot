import { describe, expect, it } from 'vitest';
import { collectChatHistory, pendingWidgets } from './inbox-model';
import type { Message } from './model';
const message = (id: string, seq: number, parts: Message['parts'] = []): Message =>
  ({ id, seq, createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`, parts }) as Message;
describe('pending owner input', () => {
  it('excludes answered, expired and failed requests while including missing initial state', () => {
    const rows = [
      message('a', 1, [{ type: 'widget', kind: 'question', props: { question: 'Initial' } }]),
      message('b', 2, [
        { type: 'widget', kind: 'question', props: {}, state: { status: 'answered' } },
      ]),
      message('c', 3, [
        { type: 'widget', kind: 'login_request', props: {}, state: { status: 'pending' } },
      ]),
      message('d', 4, [
        { type: 'widget', kind: 'login_request', props: {}, state: { status: 'expired' } },
      ]),
      message('e', 5, [
        { type: 'widget', kind: 'login_request', props: {}, state: { status: 'failed' } },
      ]),
    ];
    expect(pendingWidgets(rows).map((item) => item.message.id)).toEqual(['c', 'a']);
  });
  it('reads past the first page to retain old unanswered widgets', async () => {
    const cursors: (number | undefined)[] = [];
    const pages = [
      { messages: [message('new', 100)], hasMore: true },
      {
        messages: [
          message('old', 1, [
            { type: 'widget', kind: 'question', props: { question: 'Still waiting' } },
          ]),
        ],
        hasMore: false,
      },
    ];
    const rows = await collectChatHistory(async (before) => {
      cursors.push(before);
      return pages.shift()!;
    });
    expect(cursors).toEqual([undefined, 100]);
    expect(pendingWidgets(rows).map((item) => item.message.id)).toEqual(['old']);
  });
  it('fails a broken pagination cursor instead of looping forever', async () => {
    await expect(
      collectChatHistory(async () => ({ messages: [message('same', 3)], hasMore: true })),
    ).rejects.toThrow('without progress');
  });
});

describe('incremental owner-input resync', () => {
  it('finds a question in an old thread and removes it when answered', async () => {
    const { syncPendingInput } = await import('./inbox-model');
    const pending = {
      ...message('thread-question', 2, [
        {
          type: 'widget',
          kind: 'question',
          props: { question: 'Still here?' },
          state: { status: 'pending' },
        },
      ]),
      updatedSeq: 10,
      threadRootId: 'root',
    };
    const first = await syncPendingInput(async () => ({
      messages: [pending],
      deleted: [],
      hasMore: false,
    }));
    expect(first.cursor).toBe(10);
    expect(pendingWidgets(first.messages)).toHaveLength(1);
    const seen: number[] = [];
    const next = await syncPendingInput(async (since) => {
      seen.push(since);
      return {
        messages: [
          {
            ...pending,
            updatedSeq: 14,
            parts: [{ type: 'widget', kind: 'question', props: {}, state: { status: 'answered' } }],
          },
        ],
        deleted: [],
        hasMore: false,
      };
    }, first);
    expect(seen).toEqual([10]);
    expect(next).toEqual({ cursor: 14, messages: [] });
  });
});
