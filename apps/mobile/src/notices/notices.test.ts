import { describe, expect, it, vi } from 'vitest';
import type { WsEvent } from '@openbots/shared';
import { MobileNotices } from './index';

const requested = (id: string, chatId = 'chat'): WsEvent =>
  ({
    type: 'approval.requested',
    bot_id: 'bot',
    chat_id: chatId,
    payload: {
      approval: { id, runId: 'run', toolName: 'shell', args: {}, reason: null, status: 'pending' },
    },
  }) as WsEvent;

describe('MobileNotices', () => {
  it('shares deduplication policy, suppresses banners for the visible chat, and removes resolved approvals', () => {
    const banner = vi.fn();
    const notices = new MobileNotices(
      () => ({ botName: () => 'Ada', ownerHandles: ['owner'] }),
      banner,
    );
    notices.setForegroundChat('chat');
    notices.onEvent(requested('one'));
    notices.onEvent(requested('one'));
    expect(notices.getSnapshot().badge).toBe(1);
    expect(banner).not.toHaveBeenCalled();
    notices.onEvent(requested('two', 'other'));
    expect(banner).toHaveBeenCalledOnce();
    notices.onEvent({
      type: 'approval.resolved',
      payload: {
        approval: {
          id: 'one',
          runId: 'run',
          toolName: 'shell',
          args: {},
          reason: null,
          status: 'approved',
        },
      },
    } as WsEvent);
    expect(notices.getSnapshot().items.map((notice) => notice.tag)).toEqual(['approval:two']);
    notices.markChatRead('other');
    expect(notices.getSnapshot().badge).toBe(0);
  });

  it('honors disabled notice kinds', () => {
    const notices = new MobileNotices(() => ({ botName: () => 'Ada', ownerHandles: [] }));
    notices.setPreferences({ approval: false });
    expect(notices.onEvent(requested('one'))).toBeNull();
    expect(notices.getSnapshot().badge).toBe(0);
  });
});
