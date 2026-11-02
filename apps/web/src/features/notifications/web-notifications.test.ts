import { createNoticeWatcher, wsEvent, type NoticeContext } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import type { Chat } from '../chats/api.js';
import {
  isShowing,
  NOTICE_EVENTS,
  noticeTarget,
  notificationOptions,
} from './web-notifications.js';

// The browser fallback uses the shared watcher (packages/shared notices.ts,
// tested there); here, that it listens to every kind the Mac app shows and
// where a click goes.

const context: NoticeContext = {
  botName: (id) => (id === 'b1' ? 'Ada' : undefined),
  ownerHandles: ['dana'],
};
const watcher = () => createNoticeWatcher(() => context);
const approval = {
  id: 'a1',
  runId: 'r1',
  toolName: 'github__create_issue',
  args: {},
  reason: null,
  status: 'pending' as const,
  summary: 'Create issue "Bug"',
};
const ROOT = '00000000-0000-4000-8000-0000000000aa';

function message(overrides: Record<string, unknown>) {
  return {
    id: 'm1',
    chatId: 'g1',
    seq: 5,
    authorType: 'bot' as const,
    authorId: 'b1',
    parts: [] as unknown[],
    status: 'complete' as const,
    createdAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('web notifications', () => {
  it('listens to the events behind every kind the Mac app shows', () => {
    expect([...NOTICE_EVENTS].sort()).toEqual([
      'approval.requested',
      'message.completed',
      'message.created',
      'message.deleted',
      'message.delta',
      'run.status',
    ]);
  });

  it('notifies for mentions, Routine exceptions and long tasks as well as approvals', () => {
    const w = watcher();
    expect(
      w.onEvent(wsEvent('approval.requested', { approval }, { bot_id: 'b1', seq: 7 })),
    ).toMatchObject({ kind: 'approval', title: 'Ada needs your approval' });
    expect(
      w.onEvent(
        wsEvent(
          'message.created',
          { message: message({ parts: [{ type: 'text', text: '@dana look' }] }) },
          { bot_id: 'b1', chat_id: 'g1', seq: 5 },
        ),
      ),
    ).toMatchObject({ kind: 'mention', title: 'Ada mentioned you' });
    expect(
      w.onEvent(
        wsEvent(
          'message.created',
          {
            message: message({
              id: 'm2',
              authorType: 'routine',
              parts: [
                {
                  type: 'widget',
                  kind: 'routine_run',
                  props: { bot_id: 'b1', name: 'Brief', outcome: 'failed', exception: 'Timeout' },
                },
              ],
            }),
          },
          { bot_id: 'b1', chat_id: 'dm1', seq: 6 },
        ),
      ),
    ).toMatchObject({ kind: 'routine', title: 'Brief failed', body: 'Timeout' });
    expect(
      w.onEvent(
        wsEvent(
          'run.status',
          {
            runId: 'r9',
            status: 'completed',
            trigger: 'message',
            startedAt: '2026-10-24T10:00:00.000Z',
            finishedAt: '2026-10-24T10:10:00.000Z',
            threadRootId: ROOT,
          },
          { bot_id: 'b1', chat_id: 'dm1', seq: 12 },
        ),
      ),
    ).toMatchObject({
      kind: 'long_task',
      title: 'Ada finished a long task',
      target: { botId: 'b1', chatId: 'dm1', seq: 12, threadRootId: ROOT },
    });
  });
});

describe('a web notification', () => {
  it("shows the Bot's avatar PNG as its icon", () => {
    expect(
      notificationOptions({
        body: 'Create issue',
        tag: 'approval:a1',
        target: { botId: 'b1', chatId: undefined, seq: 7, threadRootId: undefined },
      }),
    ).toEqual({
      body: 'Create issue',
      tag: 'approval:a1',
      icon: '/api/v1/bots/b1/avatar.png?size=128',
    });
  });
});

describe('web notification clicks', () => {
  const chat = (id: string, type: Chat['type']): Chat => ({
    id,
    type,
    title: null,
    botId: null,
    peerBotId: null,
    botIds: ['b1'],
    lastSeq: 9,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });
  const chats = [chat('g1', 'group'), chat('bb1', 'bot_to_bot')];
  const notice = (chatId: string | undefined, threadRootId?: string) => ({
    target: { botId: 'b1', chatId, seq: 7, threadRootId },
  });

  it('opens a group chat event in the group, at its seq', () => {
    expect(noticeTarget(notice('g1'), chats)).toEqual({
      to: '/groups/$chatId',
      params: { chatId: 'g1' },
      search: { seq: 7 },
    });
  });

  it("opens a Bot's direct chat event in the Bot, at its seq", () => {
    const bot = { to: '/bots/$botId', params: { botId: 'b1' }, search: { seq: 7 } };
    expect(noticeTarget(notice('dm1'), chats)).toEqual(bot);
    expect(noticeTarget(notice(undefined), chats)).toEqual(bot);
    expect(noticeTarget(notice('g1'), undefined)).toEqual(bot);
  });

  it('opens a Bot to Bot chat event in that chat under the Bot, since the seq is that chat’s', () => {
    expect(noticeTarget(notice('bb1'), chats)).toEqual({
      to: '/bots/$botId',
      params: { botId: 'b1' },
      search: { chat: 'bb1', seq: 7 },
    });
  });

  it('counts as watched only on the chat a click would open', () => {
    const bot = noticeTarget(notice('dm1'), chats);
    const pair = noticeTarget(notice('bb1'), chats);
    const group = noticeTarget(notice('g1'), chats);
    expect(isShowing(bot, { pathname: '/bots/b1', search: { seq: 3 } })).toBe(true);
    expect(isShowing(bot, { pathname: '/bots/b1', search: { chat: 'bb1' } })).toBe(false);
    expect(isShowing(pair, { pathname: '/bots/b1', search: {} })).toBe(false);
    expect(isShowing(pair, { pathname: '/bots/b1', search: { chat: 'bb1' } })).toBe(true);
    expect(isShowing(group, { pathname: '/groups/g1', search: {} })).toBe(true);
    expect(isShowing(group, { pathname: '/bots/b1', search: {} })).toBe(false);
  });

  it('opens a reply in its thread, in a group or a Bot', () => {
    expect(noticeTarget(notice('g1', ROOT), chats)).toEqual({
      to: '/groups/$chatId',
      params: { chatId: 'g1' },
      search: { seq: 7, thread: ROOT },
    });
    expect(noticeTarget(notice('dm1', ROOT), chats).search).toEqual({ seq: 7, thread: ROOT });
  });
});
