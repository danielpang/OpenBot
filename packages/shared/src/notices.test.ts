import { describe, expect, it } from 'vitest';
import { wsEvent } from './events.js';
import {
  createNoticeWatcher,
  formatDuration,
  LONG_TASK_MS,
  OWNER_INPUT_WIDGETS,
  ownerHandles,
  type NoticeContext,
} from './notices.js';

const BOT = '0b3f8a52-1c1e-4b9a-9d55-3f2a8c6e7d10';
const GROUP = '7f0c1d2e-3a4b-4c5d-8e6f-708192a3b4c5';
const DM = '11111111-2222-4333-8444-555555555555';
const ROUTINE = '99999999-2222-4333-8444-555555555555';

const context: NoticeContext = {
  botName: (id) => (id === BOT ? 'Ada' : undefined),
  ownerHandles: ['dana'],
};

const at = (chatId: string | undefined, seq: number | undefined, threadRootId?: string) => ({
  botId: BOT,
  chatId,
  seq,
  threadRootId,
});

const approval = {
  id: 'a1',
  runId: 'r1',
  toolName: 'github__create_issue',
  args: {},
  reason: null,
  status: 'pending' as const,
  summary: 'Create issue "Bug"',
};

function message(overrides: Record<string, unknown>) {
  return {
    id: 'm1',
    chatId: DM,
    seq: 5,
    authorType: 'bot' as const,
    authorId: BOT,
    parts: [] as unknown[],
    status: 'complete' as const,
    createdAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('notices', () => {
  it('notifies once per approval request, linked to its message', () => {
    const watcher = createNoticeWatcher(() => context);
    const event = wsEvent('approval.requested', { approval }, { bot_id: BOT, chat_id: DM, seq: 7 });
    expect(watcher.onEvent(event)).toEqual({
      kind: 'approval',
      tag: 'approval:a1',
      title: 'Ada needs your approval',
      body: 'Create issue "Bug"',
      target: at(DM, 7),
    });
    expect(watcher.onEvent(event)).toBeNull();
  });

  it('notifies for a question, whole or streamed', () => {
    const question = { type: 'widget', kind: 'question', props: { question: 'Which repo?' } };
    const created = createNoticeWatcher(() => context).onEvent(
      wsEvent(
        'message.created',
        { message: message({ parts: [question] }) },
        { bot_id: BOT, chat_id: DM, seq: 5 },
      ),
    );
    expect(created).toMatchObject({
      kind: 'question',
      title: 'Ada has a question',
      body: 'Which repo?',
    });

    const streamed = createNoticeWatcher(() => context).onEvent(
      wsEvent(
        'message.delta',
        {
          messageId: 'm2',
          deltaSeq: 2,
          deltas: [{ partIndex: 1, type: 'widget', text: '', part: question }],
        },
        { bot_id: BOT, chat_id: GROUP, seq: 9 },
      ),
    );
    expect(streamed).toMatchObject({
      kind: 'question',
      target: at(GROUP, 9),
    });
  });

  it('notifies for a sign-in request, naming the Bot that needs it (K8)', () => {
    const request = {
      type: 'widget',
      kind: 'login_request',
      props: {
        site: 'github.com',
        reason: 'Read the private repo',
        requester: { bot_id: 'b9', handle: 'scout', name: 'Scout' },
      },
    };
    // Posted in the main Bot's transcript: the title names the asker.
    expect(
      createNoticeWatcher(() => context).onEvent(
        wsEvent(
          'message.created',
          { message: message({ parts: [request] }) },
          { bot_id: BOT, chat_id: DM, seq: 5 },
        ),
      ),
    ).toMatchObject({
      kind: 'question',
      title: 'Scout needs you to sign in to github.com',
      body: 'Read the private repo',
      target: at(DM, 5),
    });
    // Streamed into the asker's own transcript, with no requester or reason.
    expect(
      createNoticeWatcher(() => context).onEvent(
        wsEvent(
          'message.delta',
          {
            messageId: 'm2',
            deltaSeq: 2,
            deltas: [
              {
                partIndex: 1,
                type: 'widget',
                text: '',
                part: { type: 'widget', kind: 'login_request', props: { site: 'github.com' } },
              },
            ],
          },
          { bot_id: BOT, chat_id: DM, seq: 6 },
        ),
      ),
    ).toMatchObject({ title: 'Ada needs you to sign in', body: 'Sign in to github.com' });
  });

  it('notifies when a streamed Bot message mentions the owner', () => {
    const watcher = createNoticeWatcher(() => context);
    const scope = { bot_id: BOT, chat_id: GROUP };
    expect(
      watcher.onEvent(
        wsEvent(
          'message.created',
          { message: message({ id: 'm3', chatId: GROUP, seq: 11, status: 'streaming' }) },
          { ...scope, seq: 11 },
        ),
      ),
    ).toBeNull();
    for (const [deltaSeq, text] of [
      [1, 'Done. @da'],
      [2, 'na, can you check?'],
    ] as const) {
      expect(
        watcher.onEvent(
          wsEvent(
            'message.delta',
            { messageId: 'm3', deltaSeq, deltas: [{ partIndex: 0, type: 'text', text }] },
            scope,
          ),
        ),
      ).toBeNull();
    }
    expect(
      watcher.onEvent(wsEvent('message.completed', { messageId: 'm3', status: 'complete' }, scope)),
    ).toEqual({
      kind: 'mention',
      tag: 'mention:m3',
      title: 'Ada mentioned you',
      body: 'Done. @dana, can you check?',
      target: at(GROUP, 11),
    });
  });

  it('does not notify for a message mentioning someone else, or a failed one', () => {
    const watcher = createNoticeWatcher(() => context);
    const other = message({ parts: [{ type: 'text', text: '@bob look' }] });
    expect(
      watcher.onEvent(wsEvent('message.created', { message: other }, { bot_id: BOT })),
    ).toBeNull();
    watcher.onEvent(
      wsEvent(
        'message.created',
        { message: message({ id: 'm4', status: 'streaming' }) },
        { bot_id: BOT },
      ),
    );
    watcher.onEvent(
      wsEvent(
        'message.delta',
        { messageId: 'm4', deltaSeq: 1, deltas: [{ partIndex: 0, type: 'text', text: '@dana' }] },
        { bot_id: BOT },
      ),
    );
    expect(
      watcher.onEvent(
        wsEvent('message.completed', { messageId: 'm4', status: 'failed' }, { bot_id: BOT }),
      ),
    ).toBeNull();
  });

  it('forgets a streamed message once it is deleted', () => {
    const watcher = createNoticeWatcher(() => context);
    const scope = { bot_id: BOT, chat_id: DM };
    watcher.onEvent(
      wsEvent('message.created', { message: message({ id: 'm5', status: 'streaming' }) }, scope),
    );
    watcher.onEvent(
      wsEvent(
        'message.delta',
        { messageId: 'm5', deltaSeq: 1, deltas: [{ partIndex: 0, type: 'text', text: '@dana' }] },
        scope,
      ),
    );
    expect(
      watcher.onEvent(wsEvent('message.deleted', { messageId: 'm5', chatId: DM }, scope)),
    ).toBeNull();
    expect(
      watcher.onEvent(wsEvent('message.completed', { messageId: 'm5', status: 'complete' }, scope)),
    ).toBeNull();
  });

  it('notifies for a failed or cancelled Routine run, not a completed one', () => {
    const watcher = createNoticeWatcher(() => context);
    const run = (outcome: string, id: string) =>
      wsEvent(
        'message.created',
        {
          message: message({
            id,
            authorType: 'routine',
            authorId: ROUTINE,
            parts: [
              {
                type: 'widget',
                kind: 'routine_run',
                props: { bot_id: BOT, name: 'Morning brief', outcome, exception: 'Rate limited' },
              },
            ],
          }),
        },
        { bot_id: BOT, chat_id: DM, seq: 5 },
      );
    expect(watcher.onEvent(run('completed', 'r1'))).toBeNull();
    expect(watcher.onEvent(run('failed', 'r2'))).toEqual({
      kind: 'routine',
      tag: 'routine:r2',
      title: 'Morning brief failed',
      body: 'Rate limited',
      target: at(DM, 5),
    });
    expect(watcher.onEvent(run('cancelled', 'r3'))).toMatchObject({
      title: 'Morning brief was cancelled',
    });
  });

  it('ignores the owner’s own messages and other events', () => {
    const watcher = createNoticeWatcher(() => context);
    const own = message({
      authorType: 'user',
      authorId: 'u1',
      parts: [{ type: 'text', text: '@dana' }],
    });
    expect(
      watcher.onEvent(wsEvent('message.created', { message: own }, { bot_id: BOT })),
    ).toBeNull();
    expect(watcher.onEvent(wsEvent('approval.resolved', { approval }, { bot_id: BOT }))).toBeNull();
  });
});

describe('notices in threads', () => {
  const ROOT = '22222222-3333-4444-8555-666666666666';

  it('opens a question, a mention and an approval in their thread', () => {
    const watcher = createNoticeWatcher(() => context);
    const question = { type: 'widget', kind: 'question', props: { question: 'Which one?' } };
    expect(
      watcher.onEvent(
        wsEvent(
          'message.created',
          { message: message({ id: 't1', seq: 8, threadRootId: ROOT, parts: [question] }) },
          { bot_id: BOT, chat_id: DM, seq: 8 },
        ),
      ),
    ).toMatchObject({ kind: 'question', target: at(DM, 8, ROOT) });

    const text = [{ type: 'text', text: '@dana done' }];
    expect(
      watcher.onEvent(
        wsEvent(
          'message.created',
          { message: message({ id: 't2', seq: 9, threadRootId: ROOT, parts: text }) },
          { bot_id: BOT, chat_id: DM, seq: 9 },
        ),
      ),
    ).toMatchObject({ kind: 'mention', target: at(DM, 9, ROOT) });

    expect(
      watcher.onEvent(
        wsEvent(
          'approval.requested',
          { approval: { ...approval, id: 'a9' }, threadRootId: ROOT },
          { bot_id: BOT, chat_id: DM, seq: 10 },
        ),
      ),
    ).toMatchObject({ kind: 'approval', target: at(DM, 10, ROOT) });
  });

  it('keeps the thread of a streamed message for its question delta', () => {
    const watcher = createNoticeWatcher(() => context);
    watcher.onEvent(
      wsEvent(
        'message.created',
        { message: message({ id: 't3', seq: 12, threadRootId: ROOT, status: 'streaming' }) },
        { bot_id: BOT, chat_id: DM, seq: 12 },
      ),
    );
    const part = { type: 'widget', kind: 'question', props: { question: 'Ok?' } };
    expect(
      watcher.onEvent(
        wsEvent(
          'message.delta',
          {
            messageId: 't3',
            deltaSeq: 1,
            deltas: [{ partIndex: 0, type: 'widget', text: '', part }],
          },
          { bot_id: BOT, chat_id: DM },
        ),
      ),
    ).toMatchObject({ kind: 'question', target: at(DM, 12, ROOT) });
  });
});

describe('long task notices', () => {
  const started = '2026-10-24T10:00:00.000Z';
  const after = (ms: number) => new Date(Date.parse(started) + ms).toISOString();
  const status = (payload: Record<string, unknown>, scope: Record<string, unknown> = {}) =>
    wsEvent(
      'run.status',
      {
        runId: 'run1',
        status: 'completed',
        trigger: 'message',
        startedAt: started,
        finishedAt: after(LONG_TASK_MS + 60_000),
        messageId: 'm9',
        threadRootId: null,
        ...payload,
      } as never,
      { bot_id: BOT, chat_id: DM, seq: 21, ...scope },
    );

  it('notifies once when a run finishes after the threshold, at its last message', () => {
    const watcher = createNoticeWatcher(() => context);
    expect(watcher.onEvent(status({}))).toEqual({
      kind: 'long_task',
      tag: 'run:run1',
      title: 'Ada finished a long task',
      body: 'Done after 3 minutes. Open to see the result.',
      target: at(DM, 21),
    });
    expect(watcher.onEvent(status({}))).toBeNull();
  });

  it('says when a long task failed, with the error', () => {
    const watcher = createNoticeWatcher(() => context);
    expect(
      watcher.onEvent(status({ runId: 'run2', status: 'failed', error: 'The model timed out' })),
    ).toMatchObject({
      title: 'Ada could not finish a long task',
      body: 'The model timed out (after 3 minutes)',
    });
    expect(watcher.onEvent(status({ runId: 'run3', status: 'failed' }))).toMatchObject({
      body: 'Stopped after 3 minutes.',
    });
  });

  it('opens the thread the run answered in', () => {
    const root = '33333333-4444-4555-8666-777777777777';
    expect(
      createNoticeWatcher(() => context).onEvent(status({ threadRootId: root })),
    ).toMatchObject({ target: at(DM, 21, root) });
  });

  it('stays quiet for short, unfinished, cancelled, Routine and Bot to Bot runs', () => {
    const watcher = createNoticeWatcher(() => context);
    for (const [i, payload] of [
      { finishedAt: after(LONG_TASK_MS - 1_000) },
      { status: 'running', finishedAt: null },
      { status: 'waiting', finishedAt: null },
      { status: 'cancelled' },
      { trigger: 'routine' },
      { trigger: 'bot_message' },
      { trigger: 'bot_dm' },
      { startedAt: null },
    ].entries()) {
      expect(watcher.onEvent(status({ runId: `quiet${i}`, ...payload })), String(i)).toBeNull();
    }
    expect(watcher.onEvent(status({ runId: 'nobot' }, { bot_id: undefined }))).toBeNull();
  });

  it('notifies for exactly the threshold and for webhook runs', () => {
    const watcher = createNoticeWatcher(() => context);
    expect(
      watcher.onEvent(status({ runId: 'edge', finishedAt: after(LONG_TASK_MS) })),
    ).toMatchObject({
      body: 'Done after 2 minutes. Open to see the result.',
    });
    expect(watcher.onEvent(status({ runId: 'hook', trigger: 'webhook' }))).not.toBeNull();
  });
});

describe('owner input widgets', () => {
  it('notifies for every kind in the table like a question', () => {
    for (const kind of Object.keys(OWNER_INPUT_WIDGETS)) {
      const notice = createNoticeWatcher(() => context).onEvent(
        wsEvent(
          'message.created',
          { message: message({ id: `w-${kind}`, parts: [{ type: 'widget', kind, props: {} }] }) },
          { bot_id: BOT, chat_id: DM, seq: 5 },
        ),
      );
      expect(notice, kind).toMatchObject({ kind: 'question', tag: `question:w-${kind}` });
    }
  });

  it('ignores widgets that do not wait on the owner', () => {
    const notice = createNoticeWatcher(() => context).onEvent(
      wsEvent(
        'message.created',
        { message: message({ parts: [{ type: 'widget', kind: 'table', props: {} }] }) },
        { bot_id: BOT, chat_id: DM, seq: 5 },
      ),
    );
    expect(notice).toBeNull();
  });
});

describe('formatDuration', () => {
  it('reads as minutes, then hours and minutes', () => {
    expect(formatDuration(20_000)).toBe('1 minute');
    expect(formatDuration(150_000)).toBe('3 minutes');
    expect(formatDuration(60 * 60_000)).toBe('1 hour');
    expect(formatDuration(125 * 60_000)).toBe('2 hours 5 minutes');
    expect(formatDuration(61 * 60_000)).toBe('1 hour 1 minute');
  });
});

describe('ownerHandles', () => {
  it('derives handles from the name and email', () => {
    expect(ownerHandles({ name: 'Dana Pang', email: 'd.pang@example.com' })).toEqual([
      'danapang',
      'dana-pang',
      'dana_pang',
      'dana',
      'dpang',
    ]);
  });
});
