import type { WebSocketLike } from '@openbots/api-client';
import { wsEvent } from '@openbots/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingApproval } from './approvals.js';
import { createConnection, wsUrlFor } from './connection.js';
import type { Notice } from './notices.js';

const BOT = '0b3f8a52-1c1e-4b9a-9d55-3f2a8c6e7d10';
const DM = '11111111-2222-4333-8444-555555555555';
const GROUP = '7f0c1d2e-3a4b-4c5d-8e6f-708192a3b4c5';
const APPROVAL = '22222222-3333-4444-8555-666666666666';
const RUN = '33333333-4444-4555-8666-777777777777';
const OTHER = '44444444-5555-4666-8777-888888888888';
const PAIR = '55555555-6666-4777-8888-999999999999';
const token = { name: 'better-auth.session_token', value: 'tok.sig' };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: unknown[] = [];
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(
  overrides: { decideStatus?: number; meStatus?: number; pending?: () => unknown[] } = {},
) {
  const sockets: FakeSocket[] = [];
  const requests: Request[] = [];
  const notices: Notice[] = [];
  const approvalLists: PendingApproval[][] = [];
  const onUnauthorized = vi.fn();
  const fetch = vi.fn(async (input: Request) => {
    requests.push(input);
    const { pathname } = new URL(input.url);
    if (pathname === '/api/v1/me') {
      return json(
        { user: { id: 'u1', name: 'Dana Pang', email: 'dana@example.com' } },
        overrides.meStatus,
      );
    }
    if (pathname === '/api/v1/bots') return json({ items: [{ id: BOT, name: 'Ada' }] });
    if (pathname === '/api/v1/chats') {
      return json({
        items: [
          { id: GROUP, type: 'group' },
          { id: PAIR, type: 'bot_to_bot', botId: BOT, peerBotId: OTHER },
        ],
      });
    }
    if (pathname === `/api/v1/bots/${BOT}/chat`) return json({ id: DM });
    if (pathname === `/api/v1/bots/${BOT}/avatar.png`) {
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    }
    if (pathname === `/api/v1/bots/${OTHER}/avatar.png`) {
      // An uploaded avatar in a format nativeImage cannot read.
      return new Response(PNG, { headers: { 'content-type': 'image/webp' } });
    }
    if (pathname === `/api/v1/chats/${DM}/messages`) return json({ id: 'm1', seq: 31 }, 201);
    if (pathname === '/api/v1/approvals' && overrides.pending) {
      return json({ items: overrides.pending() });
    }
    if (pathname === `/api/v1/approvals/${APPROVAL}/decide`) {
      return json({ approval: {}, resumedRunId: null }, overrides.decideStatus ?? 200);
    }
    return json({ title: 'Not found' }, 404);
  });
  const connection = createConnection({
    baseUrl: 'https://openbots.example.com',
    token,
    fetch: fetch as unknown as typeof globalThis.fetch,
    createSocket: (url, headers) => {
      const socket = new FakeSocket(url, headers);
      sockets.push(socket);
      return socket;
    },
    onNotice: (notice) => notices.push(notice),
    onApprovals: (list) => approvalLists.push(list),
    onUnauthorized,
  });
  return { connection, sockets, requests, notices, approvalLists, onUnauthorized };
}

const requested = wsEvent(
  'approval.requested',
  {
    approval: {
      id: APPROVAL,
      runId: RUN,
      toolName: 'email__send',
      args: {},
      reason: null,
      status: 'pending',
      summary: 'Send it',
    },
  },
  { bot_id: BOT, chat_id: DM, seq: 8 },
);

/** An item of `GET /approvals?status=pending`. */
const pendingItem = (id: string, chatId: string, seq: number) => ({
  ...requested.payload.approval,
  id,
  messageId: null,
  note: null,
  decidedBy: null,
  decidedAt: null,
  expiresAt: null,
  createdAt: '2026-10-24T10:00:00.000Z',
  botId: BOT,
  chatId,
  seq,
});

describe('server connection', () => {
  afterEach(() => vi.useRealTimers());

  it('connects the socket to /ws with the session cookie', () => {
    const { sockets, connection } = setup();
    expect(sockets[0]?.url).toBe('wss://openbots.example.com/ws');
    expect(sockets[0]?.headers).toEqual({ cookie: 'better-auth.session_token=tok.sig' });
    connection.close();
  });

  it('sends the cookie on REST calls and subscribes to every Bot and chat', async () => {
    const { connection, sockets, requests } = setup();
    sockets[0]!.open();
    await connection.refresh();
    expect(
      requests.every((r) => r.headers.get('cookie') === 'better-auth.session_token=tok.sig'),
    ).toBe(true);
    expect(sockets[0]!.sent).toContainEqual({
      type: 'subscribe',
      chats: [GROUP, PAIR],
      bots: [BOT],
    });
    // A second refresh with nothing new subscribes to nothing more.
    await connection.refresh();
    expect(
      sockets[0]!.sent.filter((f) => (f as { type: string }).type === 'subscribe'),
    ).toHaveLength(1);
    connection.close();
  });

  it('turns events into notices and the tray list', async () => {
    const { connection, sockets, notices, approvalLists } = setup();
    sockets[0]!.open();
    await connection.refresh();
    sockets[0]!.receive(requested);
    expect(notices).toEqual([
      {
        kind: 'approval',
        tag: `approval:${APPROVAL}`,
        title: 'Ada needs your approval',
        body: 'Send it',
        target: { botId: BOT, chatId: expect.any(String), seq: 8, threadRootId: undefined },
        link: { kind: 'bot', botId: BOT, seq: 8 },
      },
    ]);
    expect(approvalLists.at(-1)?.map((a) => a.id)).toEqual([APPROVAL]);
    connection.close();
  });

  it('opens a Bot to Bot chat request under the Bot, where the web app shows that chat', async () => {
    const { connection, sockets, notices, approvalLists } = setup();
    sockets[0]!.open();
    await connection.refresh();
    sockets[0]!.receive({ ...requested, chat_id: PAIR, seq: 3 });
    const link = { kind: 'bot', botId: BOT, chat: PAIR, seq: 3 };
    expect(notices[0]?.link).toEqual(link);
    expect(approvalLists.at(-1)?.[0]?.link).toEqual(link);
    connection.close();
  });

  it("fetches a Bot's avatar PNG for its notifications once, with the session", async () => {
    const { connection, requests } = setup();
    const avatarRequests = () => requests.filter((r) => r.url.includes('/avatar.png'));
    expect(await connection.avatar(BOT)).toEqual(PNG);
    expect(await connection.avatar(BOT)).toEqual(PNG);
    expect(avatarRequests()).toHaveLength(1);
    expect(new URL(avatarRequests()[0]!.url).searchParams.get('size')).toBe('128');
    expect(avatarRequests()[0]!.headers.get('cookie')).toBe('better-auth.session_token=tok.sig');
    // No icon rather than one Electron cannot read, and none for a missing Bot.
    expect(await connection.avatar(OTHER)).toBeNull();
    expect(await connection.avatar(RUN)).toBeNull();
    connection.close();
  });

  it('loads the pending approvals on every refresh and merges them with events', async () => {
    let items = [pendingItem(APPROVAL, GROUP, 12)];
    const { connection, sockets, requests, approvalLists } = setup({ pending: () => items });
    sockets[0]!.open();
    await connection.refresh();
    const list = requests.find((r) => new URL(r.url).pathname === '/api/v1/approvals')!;
    expect(new URL(list.url).searchParams.get('status')).toBe('pending');
    expect(approvalLists.at(-1)).toEqual([
      {
        id: APPROVAL,
        botId: BOT,
        botName: 'Ada',
        summary: 'Send it',
        link: { kind: 'chat', chatId: GROUP, seq: 12 },
      },
    ]);
    // A live request joins the loaded one; a decision drops it.
    sockets[0]!.receive(
      wsEvent(
        'approval.requested',
        { approval: { ...requested.payload.approval, id: OTHER } },
        {
          bot_id: BOT,
          chat_id: DM,
          seq: 9,
        },
      ),
    );
    expect(approvalLists.at(-1)?.map((a) => a.id)).toEqual([APPROVAL, OTHER]);
    sockets[0]!.receive(
      wsEvent(
        'approval.resolved',
        { approval: { ...requested.payload.approval, id: OTHER } },
        {
          bot_id: BOT,
        },
      ),
    );
    expect(approvalLists.at(-1)?.map((a) => a.id)).toEqual([APPROVAL]);
    // Decided elsewhere while the socket was down: the next load drops it.
    items = [];
    await connection.refresh();
    expect(approvalLists.at(-1)).toEqual([]);
    connection.close();
  });

  it('decides an approval from the tray and drops it from the list', async () => {
    const { connection, sockets, requests, approvalLists } = setup();
    sockets[0]!.open();
    sockets[0]!.receive(requested);
    await connection.decide(APPROVAL, 'approve');
    const decide = requests.at(-1)!;
    expect(decide.method).toBe('POST');
    expect(await decide.json()).toEqual({ decision: 'approve' });
    expect(approvalLists.at(-1)).toEqual([]);
    connection.close();
  });

  it('drops an approval the server says is already decided, and reports the error', async () => {
    const { connection, sockets, approvalLists } = setup({ decideStatus: 409 });
    sockets[0]!.open();
    sockets[0]!.receive(requested);
    await expect(connection.decide(APPROVAL, 'deny')).rejects.toThrow();
    expect(approvalLists.at(-1)).toEqual([]);
    connection.close();
  });

  it('quick ask posts into the Bot’s transcript', async () => {
    const { connection, requests } = setup();
    await expect(connection.ask(BOT, 'What is on today?')).resolves.toEqual({
      botId: BOT,
      seq: 31,
    });
    const post = requests.at(-1)!;
    expect(new URL(post.url).pathname).toBe(`/api/v1/chats/${DM}/messages`);
    expect(await post.json()).toEqual({ text: 'What is on today?' });
    await expect(connection.bots()).resolves.toEqual([{ id: BOT, name: 'Ada' }]);
    connection.close();
  });

  it('reports a refused token', async () => {
    const { connection, onUnauthorized } = setup({ meStatus: 401 });
    await expect(connection.refresh()).rejects.toThrow();
    expect(onUnauthorized).toHaveBeenCalled();
    connection.close();
  });

  it('builds ws and wss URLs', () => {
    expect(wsUrlFor('http://localhost:3000')).toBe('ws://localhost:3000/ws');
    expect(wsUrlFor('https://openbots.example.com')).toBe('wss://openbots.example.com/ws');
  });
});
