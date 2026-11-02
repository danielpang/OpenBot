import { wsEvent } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import { formatDeepLink } from './deep-links.js';
import { createNoticeWatcher, isWatching, linkFor, type NoticeContext } from './notices.js';

// Which events notify is tested with the shared watcher (packages/shared
// notices.test.ts); here, the deep link each notice opens.

const BOT = '0b3f8a52-1c1e-4b9a-9d55-3f2a8c6e7d10';
const GROUP = '7f0c1d2e-3a4b-4c5d-8e6f-708192a3b4c5';
const DM = '11111111-2222-4333-8444-555555555555';
const ROOT = '22222222-3333-4444-8555-666666666666';
const PAIR = '33333333-4444-4555-8666-777777777777';

const context: NoticeContext = {
  botName: (id) => (id === BOT ? 'Ada' : undefined),
  chatKind: (id) => (id === GROUP ? 'group' : id === PAIR ? 'bot_to_bot' : undefined),
  ownerHandles: ['dana'],
};

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
  it('links an approval to its message in the Bot transcript', () => {
    const watcher = createNoticeWatcher(() => context);
    const event = wsEvent('approval.requested', { approval }, { bot_id: BOT, chat_id: DM, seq: 7 });
    expect(watcher.onEvent(event)).toEqual({
      kind: 'approval',
      tag: 'approval:a1',
      title: 'Ada needs your approval',
      body: 'Create issue "Bug"',
      target: { botId: BOT, chatId: DM, seq: 7, threadRootId: undefined },
      link: { kind: 'bot', botId: BOT, seq: 7 },
    });
    expect(watcher.onEvent(event)).toBeNull();
  });

  it('links a group message to the group, and a thread reply to its thread', () => {
    const watcher = createNoticeWatcher(() => context);
    const question = { type: 'widget', kind: 'question', props: { question: 'Which repo?' } };
    expect(
      watcher.onEvent(
        wsEvent(
          'message.created',
          { message: message({ chatId: GROUP, seq: 9, parts: [question] }) },
          { bot_id: BOT, chat_id: GROUP, seq: 9 },
        ),
      )?.link,
    ).toEqual({ kind: 'chat', chatId: GROUP, seq: 9 });
    const reply = watcher.onEvent(
      wsEvent(
        'message.created',
        {
          message: message({
            id: 'm2',
            chatId: GROUP,
            seq: 10,
            threadRootId: ROOT,
            parts: [{ type: 'text', text: '@dana it is merged' }],
          }),
        },
        { bot_id: BOT, chat_id: GROUP, seq: 10 },
      ),
    );
    expect(reply).toMatchObject({ kind: 'mention', title: 'Ada mentioned you' });
    expect(reply!.link).toEqual({ kind: 'chat', chatId: GROUP, seq: 10, thread: ROOT });
    expect(formatDeepLink(reply!.link)).toBe(`openbots://chat/${GROUP}/message/10?thread=${ROOT}`);
  });

  it('links a Bot to Bot request to that chat under the Bot, not to a group', () => {
    const watcher = createNoticeWatcher(() => context);
    const notice = watcher.onEvent(
      wsEvent('approval.requested', { approval }, { bot_id: BOT, chat_id: PAIR, seq: 4 }),
    );
    expect(notice!.link).toEqual({ kind: 'bot', botId: BOT, chat: PAIR, seq: 4 });
    expect(formatDeepLink(notice!.link)).toBe(`openbots://bot/${BOT}/message/4?chat=${PAIR}`);
  });

  it('links a finished long task to the run’s last message', () => {
    const notice = createNoticeWatcher(() => context).onEvent(
      wsEvent(
        'run.status',
        {
          runId: 'r9',
          status: 'completed',
          trigger: 'message',
          startedAt: '2026-10-24T10:00:00.000Z',
          finishedAt: '2026-10-24T10:05:00.000Z',
          messageId: 'm9',
          threadRootId: ROOT,
        },
        { bot_id: BOT, chat_id: DM, seq: 30 },
      ),
    );
    expect(notice).toMatchObject({
      kind: 'long_task',
      title: 'Ada finished a long task',
      body: 'Done after 5 minutes. Open to see the result.',
      link: { kind: 'bot', botId: BOT, seq: 30, thread: ROOT },
    });
  });
});

describe('linkFor', () => {
  it('leaves out what the target does not have', () => {
    const target = { botId: BOT, chatId: undefined, seq: undefined, threadRootId: undefined };
    expect(linkFor(target, () => 'group')).toEqual({ kind: 'bot', botId: BOT });
  });
});

describe('isWatching', () => {
  const notice = { link: { kind: 'bot' as const, botId: BOT, seq: 3, thread: ROOT } };
  const group = { link: { kind: 'chat' as const, chatId: GROUP, seq: 3 } };

  it('is true only when the focused window shows that chat', () => {
    expect(isWatching(notice, { focused: true, path: `/bots/${BOT}?seq=1` })).toBe(true);
    expect(isWatching(notice, { focused: true, path: `/bots/${BOT}` })).toBe(true);
    expect(isWatching(notice, { focused: false, path: `/bots/${BOT}` })).toBe(false);
    expect(isWatching(notice, { focused: true, path: '/bots/other' })).toBe(false);
    expect(isWatching(notice, { focused: true, path: `/bots/${BOT}/settings` })).toBe(false);
    expect(isWatching(notice, { focused: true, path: null })).toBe(false);
    expect(isWatching(group, { focused: true, path: `/groups/${GROUP}` })).toBe(true);
    expect(isWatching(group, { focused: true, path: `/bots/${BOT}` })).toBe(false);
  });

  it('counts a Bot to Bot chat as watched only when the view was opened at it', () => {
    const pair = { link: { kind: 'bot' as const, botId: BOT, chat: PAIR, seq: 3 } };
    expect(isWatching(pair, { focused: true, path: `/bots/${BOT}` })).toBe(false);
    expect(isWatching(pair, { focused: true, path: `/bots/${BOT}?chat=${PAIR}&seq=2` })).toBe(true);
    // The transcript itself is not watched while a Bot to Bot chat is open.
    expect(isWatching(notice, { focused: true, path: `/bots/${BOT}?chat=${PAIR}` })).toBe(false);
  });
});
