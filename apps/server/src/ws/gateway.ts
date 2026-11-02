import { STATUS_CODES, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  ClientFrameSchema,
  EVENTS_CHANNEL,
  type ControlFrame,
  type Unsubscribe,
  type WsEvent,
} from '@openbots/shared';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { AppDeps, CurrentUser } from '../context.js';
import { DomainError } from '../errors.js';
import { authenticateHeaders } from '../middleware/auth.js';
import { ownedBotIds, ownedChatIds } from '../ownership.js';
import { MEMBERSHIP_ENDED_CHANNEL, type MembershipEnded } from '../membership.js';
import { inWorkspace } from '../db/scope.js';

// The realtime gateway on `/ws` (plan 14.2). A socket authenticates on upgrade
// with the session cookie or an API key, subscribes to chats and Bots it owns,
// and receives every bus event scoped to one of them. A reconnecting client
// catches up through `GET /api/v1/chats/:id/resync`. A socket works in the
// organization it authenticated in (plan 21.3): user-scoped events reach it
// only when they carry that organization, and when a member's access to the
// organization ends every instance closes their sockets there (policy
// violation, 1008).

export const WS_PATH = '/ws';

const MAX_FRAME_BYTES = 64 * 1024;
/** A socket this far behind is dropped; it resyncs when it reconnects. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** The part of an HTTP server the gateway needs. */
export interface UpgradeSource {
  on(event: 'upgrade', listener: UpgradeListener): unknown;
  off(event: 'upgrade', listener: UpgradeListener): unknown;
}

type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

export interface GatewayOptions {
  /** How often sockets are pinged; one missed pong closes the socket. */
  heartbeatMs?: number;
  /** Upgrade paths another listener serves (the computer's terminal and screen proxies). */
  ignore?(pathname: string): boolean;
}

export interface Gateway {
  /** Open sockets. */
  readonly size: number;
  close(): Promise<void>;
}

interface Client {
  socket: WebSocket;
  user: CurrentUser;
  chats: Set<string>;
  bots: Set<string>;
  alive: boolean;
  /** Frames are handled one at a time, in order. */
  queue: Promise<void>;
}

export async function attachGateway(
  server: UpgradeSource,
  deps: AppDeps,
  { heartbeatMs = 30_000, ignore = () => false }: GatewayOptions = {},
): Promise<Gateway> {
  const { db, logger, config } = deps;
  const origin = new URL(config.publicUrl).origin;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const clients = new Set<Client>();

  const onUpgrade: UpgradeListener = (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    void upgrade(req, socket, head);
  };

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== WS_PATH) {
      if (ignore(pathname)) return;
      return reject(socket, 404);
    }
    // Browsers always send Origin on a WebSocket upgrade, so a cookie-carrying
    // socket from another site is refused here (P3). Clients that are not
    // browsers send none and authenticate like any API caller.
    if (req.headers.origin !== undefined && req.headers.origin !== origin) {
      return reject(socket, 403);
    }
    let user: CurrentUser;
    try {
      user = await authenticateHeaders(deps, toHeaders(req.headers));
    } catch (error) {
      if (!(error instanceof DomainError)) logger.error({ err: error }, 'ws auth failed');
      return reject(socket, error instanceof DomainError ? error.status : 500);
    }
    wss.handleUpgrade(req, socket, head, (ws) => connect(ws, user));
  }

  function connect(socket: WebSocket, user: CurrentUser) {
    const client: Client = {
      socket,
      user,
      chats: new Set(),
      bots: new Set(),
      alive: true,
      queue: Promise.resolve(),
    };
    clients.add(client);
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (raw) => {
      client.queue = client.queue.then(() =>
        handle(client, raw).catch((error: unknown) => {
          logger.error({ err: error, userId: user.id }, 'ws frame failed');
          send(client, { type: 'error', code: 'INTERNAL', message: 'Internal server error' });
        }),
      );
    });
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => socket.terminate());
  }

  async function handle(client: Client, raw: RawData) {
    let data: unknown;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return send(client, { type: 'error', code: 'BAD_FRAME', message: 'Frames are JSON' });
    }
    const parsed = ClientFrameSchema.safeParse(data);
    if (!parsed.success) {
      return send(client, { type: 'error', code: 'BAD_FRAME', message: parsed.error.message });
    }
    const frame = parsed.data;
    if (frame.type === 'ping') return send(client, { type: 'pong', ts: Date.now() });

    if (frame.type === 'unsubscribe') {
      for (const id of frame.chats) client.chats.delete(id);
      for (const id of frame.bots) client.bots.delete(id);
      return send(client, subscribed(client, [], []));
    }

    // In the socket's organization (db/scope.ts).
    const [chats, bots] = await inWorkspace(client.user.workspaceId, () =>
      Promise.all([
        ownedChatIds(db, client.user, frame.chats),
        ownedBotIds(db, client.user, frame.bots),
      ]),
    );
    for (const id of chats) client.chats.add(id);
    for (const id of bots) client.bots.add(id);
    send(
      client,
      subscribed(
        client,
        frame.chats.filter((id) => !chats.has(id)),
        frame.bots.filter((id) => !bots.has(id)),
      ),
    );
  }

  function forward(event: WsEvent) {
    let data: string | undefined;
    for (const client of clients) {
      // An event names its organization; a socket gets only its own's.
      if (event.workspace_id !== undefined && event.workspace_id !== client.user.workspaceId) {
        continue;
      }
      const wanted =
        (event.chat_id !== undefined && client.chats.has(event.chat_id)) ||
        (event.bot_id !== undefined && client.bots.has(event.bot_id)) ||
        (event.user_id !== undefined &&
          client.user.id === event.user_id &&
          event.workspace_id === client.user.workspaceId);
      if (!wanted || client.socket.readyState !== WebSocket.OPEN) continue;
      if (client.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        client.socket.terminate();
        continue;
      }
      data ??= JSON.stringify(event);
      client.socket.send(data);
    }
  }

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  const unsubscribeEvents: Unsubscribe = await deps.infra.bus.subscribe<WsEvent>(
    EVENTS_CHANNEL,
    forward,
  );
  const unsubscribeDisabled: Unsubscribe = await deps.infra.bus.subscribe<MembershipEnded>(
    MEMBERSHIP_ENDED_CHANNEL,
    ({ userId, workspaceId }) => {
      for (const client of clients) {
        if (client.user.id === userId && client.user.workspaceId === workspaceId) {
          client.socket.close(1008, 'membership ended');
        }
      }
    },
  );
  server.on('upgrade', onUpgrade);

  return {
    get size() {
      return clients.size;
    },
    async close() {
      server.off('upgrade', onUpgrade);
      clearInterval(heartbeat);
      await unsubscribeEvents();
      await unsubscribeDisabled();
      for (const client of clients) client.socket.close(1001, 'server shutting down');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function subscribed(client: Client, deniedChats: string[], deniedBots: string[]): ControlFrame {
  return {
    type: 'subscribed',
    chats: [...client.chats],
    bots: [...client.bots],
    denied: { chats: deniedChats, bots: deniedBots },
  };
}

function send(client: Client, frame: ControlFrame) {
  if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(frame));
}

export function reject(socket: Duplex, status: number) {
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

export function toHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}
