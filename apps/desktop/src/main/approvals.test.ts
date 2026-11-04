import { wsEvent } from '@openbots/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createApprovalTracker,
  trayMenu,
  type PendingApproval,
  type TrayActions,
} from './approvals.js';

const BOT = '0b3f8a52-1c1e-4b9a-9d55-3f2a8c6e7d10';
const approval = (id: string, status: 'pending' | 'approved' = 'pending') => ({
  id,
  runId: 'r1',
  toolName: 'email__send',
  args: {},
  reason: null,
  status,
  summary: `Send mail ${id}`,
});
const GROUP = '7f0c1d2e-3a4b-4c5d-8e6f-708192a3b4c5';
/** An item of `GET /approvals?status=pending`. */
const listed = (
  id: string,
  extra: { chatId?: string; seq?: number | null; summary?: string } = {},
) => ({
  ...approval(id),
  messageId: null,
  note: null,
  decidedBy: null,
  decidedAt: null,
  expiresAt: null,
  createdAt: '2026-10-24T10:00:00.000Z',
  botId: BOT,
  chatId: extra.chatId ?? null,
  seq: extra.seq === undefined ? 5 : extra.seq,
  ...(extra.summary != null ? { summary: extra.summary } : {}),
});

describe('approval tracker', () => {
  it('follows requested and resolved events', () => {
    const tracker = createApprovalTracker((id) => (id === BOT ? 'Ada' : undefined));
    expect(
      tracker.onEvent(
        wsEvent('approval.requested', { approval: approval('a1') }, { bot_id: BOT, seq: 4 }),
      ),
    ).toBe(true);
    expect(
      tracker.onEvent(wsEvent('approval.requested', { approval: approval('a2') }, { bot_id: BOT })),
    ).toBe(true);
    expect(tracker.list()).toEqual([
      {
        id: 'a1',
        botId: BOT,
        botName: 'Ada',
        summary: 'Send mail a1',
        link: { kind: 'bot', botId: BOT, seq: 4 },
      },
      {
        id: 'a2',
        botId: BOT,
        botName: 'Ada',
        summary: 'Send mail a2',
        link: { kind: 'bot', botId: BOT },
      },
    ]);
    expect(
      tracker.onEvent(
        wsEvent('approval.resolved', { approval: approval('a1', 'approved') }, { bot_id: BOT }),
      ),
    ).toBe(true);
    expect(tracker.list().map((a) => a.id)).toEqual(['a2']);
    expect(tracker.remove('a2')).toBe(true);
    expect(tracker.remove('a2')).toBe(false);
  });

  it('links a group chat request to the group message', () => {
    const tracker = createApprovalTracker(
      () => 'Ada',
      (id) => (id === GROUP ? 'group' : undefined),
    );
    tracker.onEvent(
      wsEvent(
        'approval.requested',
        { approval: approval('a1') },
        {
          bot_id: BOT,
          chat_id: GROUP,
          seq: 6,
        },
      ),
    );
    expect(tracker.list()[0]?.link).toEqual({ kind: 'chat', chatId: GROUP, seq: 6 });
  });

  it('opens a Bot to Bot request in that chat under the Bot', () => {
    const PAIR = '33333333-4444-4555-8666-777777777777';
    const tracker = createApprovalTracker(
      () => 'Ada',
      (id) => (id === PAIR ? 'bot_to_bot' : undefined),
    );
    tracker.onEvent(
      wsEvent(
        'approval.requested',
        { approval: approval('a1') },
        { bot_id: BOT, chat_id: PAIR, seq: 2 },
      ),
    );
    expect(tracker.list()[0]?.link).toEqual({ kind: 'bot', botId: BOT, chat: PAIR, seq: 2 });
  });

  it('replaces the list with a load, keeping what events said meanwhile', () => {
    const tracker = createApprovalTracker(
      (id) => (id === BOT ? 'Ada' : undefined),
      (id) => (id === GROUP ? 'group' : undefined),
    );
    // Known before the reconnect, decided while the app was away.
    tracker.onEvent(wsEvent('approval.requested', { approval: approval('old') }, { bot_id: BOT }));
    const load = tracker.beginLoad();
    // While the list is in flight: one request decided, one new.
    tracker.onEvent(
      wsEvent('approval.resolved', { approval: approval('a2', 'approved') }, { bot_id: BOT }),
    );
    tracker.onEvent(wsEvent('approval.requested', { approval: approval('a4') }, { bot_id: BOT }));
    expect(
      tracker.load(load, [
        listed('a1', { chatId: GROUP, seq: 3 }),
        listed('a2'),
        listed('a3', { seq: null, summary: '' }),
      ]),
    ).toBe(true);
    expect(tracker.list()).toEqual([
      {
        id: 'a1',
        botId: BOT,
        botName: 'Ada',
        summary: 'Send mail a1',
        link: { kind: 'chat', chatId: GROUP, seq: 3 },
      },
      {
        id: 'a3',
        botId: BOT,
        botName: 'Ada',
        summary: 'email__send',
        link: { kind: 'bot', botId: BOT },
      },
      {
        id: 'a4',
        botId: BOT,
        botName: 'Ada',
        summary: 'Send mail a4',
        link: { kind: 'bot', botId: BOT },
      },
    ]);
    // Once loaded, events apply as before.
    tracker.onEvent(
      wsEvent('approval.resolved', { approval: approval('a1', 'approved') }, { bot_id: BOT }),
    );
    expect(tracker.list().map((a) => a.id)).toEqual(['a3', 'a4']);
  });

  it('keeps the live list when a load fails or comes too late', () => {
    const tracker = createApprovalTracker(() => 'Ada');
    tracker.onEvent(wsEvent('approval.requested', { approval: approval('a1') }, { bot_id: BOT }));
    expect(tracker.load(tracker.beginLoad(), null)).toBe(false);
    expect(tracker.list().map((a) => a.id)).toEqual(['a1']);
    // Nor does a load that finishes after `clear` (the connection closed).
    const late = tracker.beginLoad();
    tracker.clear();
    expect(tracker.load(late, [listed('a2')])).toBe(false);
    expect(tracker.list()).toEqual([]);
  });

  it('ignores requests without a Bot or not pending', () => {
    const tracker = createApprovalTracker(() => undefined);
    expect(tracker.onEvent(wsEvent('approval.requested', { approval: approval('a1') }))).toBe(
      false,
    );
    expect(
      tracker.onEvent(
        wsEvent('approval.requested', { approval: approval('a2', 'approved') }, { bot_id: BOT }),
      ),
    ).toBe(false);
    expect(tracker.list()).toEqual([]);
  });
});

function actions(): TrayActions {
  return {
    open: vi.fn(),
    decide: vi.fn(),
    quickAsk: vi.fn(),
    pairPhone: vi.fn(),
    changeConnection: vi.fn(),
    checkForUpdates: vi.fn(),
    quit: vi.fn(),
  };
}

const pending = (n: number): PendingApproval[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    botId: BOT,
    botName: 'Ada',
    summary: `Send mail ${i}`,
    link: { kind: 'bot', botId: BOT, seq: i + 1 },
  }));

describe('tray menu', () => {
  it('says when nothing is pending', () => {
    const menu = trayMenu({
      approvals: [],
      profileName: 'This Mac',
      connected: false,
      actions: actions(),
    });
    expect(menu[0]).toEqual({ label: 'No pending approvals', enabled: false });
    expect(menu.find((i) => i.label === 'Quick Ask…')?.enabled).toBe(false);
    expect(menu.some((i) => i.label === 'Open OpenBots (This Mac)')).toBe(true);
  });

  it('offers a quick Approve per pending approval', () => {
    const a = actions();
    const menu = trayMenu({
      approvals: pending(2),
      profileName: 'Work',
      connected: true,
      actions: a,
    });
    expect(menu[0]?.label).toBe('2 pending approvals');
    const first = menu[1]!;
    expect(first.label).toBe('Ada: Send mail 0');
    const [approve, deny, , open] = first.submenu!;
    approve!.click!();
    deny!.click!();
    open!.click!();
    expect(a.decide).toHaveBeenNthCalledWith(1, 'a0', 'approve');
    expect(a.decide).toHaveBeenNthCalledWith(2, 'a0', 'deny');
    expect(a.open).toHaveBeenCalledWith({ kind: 'bot', botId: BOT, seq: 1 });
  });

  it('caps the list and links the rest to the app', () => {
    const a = actions();
    const menu = trayMenu({
      approvals: pending(12),
      profileName: 'Work',
      connected: true,
      actions: a,
    });
    expect(menu.filter((i) => i.type === 'submenu')).toHaveLength(10);
    const more = menu.find((i) => i.label === '2 more…')!;
    more.click!();
    expect(a.open).toHaveBeenCalledWith();
  });

  it('heads the menu with the connection, and offers Change connection', () => {
    const a = actions();
    const menu = trayMenu({
      approvals: [],
      profileName: 'Work',
      connection: 'Self-hosted (openbots.example.com)',
      connected: true,
      actions: a,
    });
    expect(menu[0]).toEqual({ label: 'Self-hosted (openbots.example.com)', enabled: false });
    expect(menu[1]).toEqual({ type: 'separator' });
    expect(menu[2]).toEqual({ label: 'No pending approvals', enabled: false });
    menu.find((i) => i.label === 'Change connection…')!.click!();
    expect(a.changeConnection).toHaveBeenCalled();
    // A thin client's tray has nothing about Docker or the local stack.
    expect(menu.some((i) => /docker|stack|start|stop/i.test(i.label ?? ''))).toBe(false);
  });

  it('offers Pair your phone beside Quick Ask and Change connection', () => {
    const a = actions();
    const menu = trayMenu({ approvals: [], profileName: 'This Mac', connected: false, actions: a });
    const labels = menu.map((i) => i.label);
    const pair = labels.indexOf('Pair your phone…');
    expect(labels[pair - 1]).toBe('Quick Ask…');
    expect(labels[pair + 1]).toBe('Change connection…');
    // It opens the window on whatever connection is active, so it works while disconnected too.
    expect(menu[pair]!.enabled).toBeUndefined();
    menu[pair]!.click!();
    expect(a.pairPhone).toHaveBeenCalledOnce();
  });

  it('shortens long summaries', () => {
    const [long] = pending(1);
    const menu = trayMenu({
      approvals: [{ ...long!, summary: 'x'.repeat(200) }],
      profileName: 'Work',
      connected: true,
      actions: actions(),
    });
    expect(menu[1]!.label!.length).toBeLessThanOrEqual(60);
    expect(menu[1]!.label!.endsWith('…')).toBe(true);
  });
});
