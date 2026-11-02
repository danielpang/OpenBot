import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { screenNumber } from '@openbots/computer';
import { COMPUTER_OFF, COMPUTER_OFF_CLOSE_CODE, type Unsubscribe } from '@openbots/shared';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { WebSocket, WebSocketServer } from 'ws';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema } from '../db/client.js';
import { DomainError } from '../errors.js';
import { authenticateHeaders } from '../middleware/auth.js';
import { assertBotOwner } from '../ownership.js';
import { SYSTEM_ACTOR } from '../services/audit.js';
import {
  agentFor,
  ensureScreen,
  releaseScreens,
  runningComputer,
  syncCookies,
  touchComputer,
} from '../services/computer.js';
import { MEMBERSHIP_ENDED_CHANNEL, type MembershipEnded } from '../membership.js';
import { reject, toHeaders, type UpgradeSource } from './gateway.js';
import { inWorkspace } from '../db/scope.js';

// WebSocket proxies to the computer's control agent (plan 9.3, 9.4, 14.1):
// `/api/v1/computer/pty` is the Computer page's terminal (xterm.js to the
// agent's node-pty), `/api/v1/bots/:id/screen/vnc` the Bot's screen (noVNC to
// websockify on its display) for the preview panel and takeover. The browser
// authenticates like on `/ws` (session cookie or API key, same Origin rule);
// the agent's token never leaves the server. Frames pass through unchanged.
// Neither starts the computer: while it is off the socket opens and closes at
// once with COMPUTER_OFF_CLOSE_CODE, which a browser can read (a refused
// upgrade only shows as 1006), so a stale Preview tab does not boot it.
// While frames flow either way the computer counts as used, at most once a
// minute, so the idle sweep does not stop it under a terminal or a screen
// session (plan 9.5); a socket left open on a still screen does not keep it on.
//
// Takeover opens its screen with `?control=1`. When the last such socket of
// the owner for a Bot closes (a closed tab, a crash) and none comes back
// within `takeoverGraceMs`, the screen is handed back as Hand back would, so
// the Bot goes on (K3). Disabling a member closes their sockets here as on
// `/ws`, and hands back any screen they hold (U3).

export const PTY_PATH = '/api/v1/computer/pty';
const VNC_PATH =
  /^\/api\/v1\/bots\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/screen\/vnc$/i;

export function isComputerSocketPath(pathname: string) {
  return pathname === PTY_PATH || VNC_PATH.test(pathname);
}

export interface ComputerProxies {
  close(): Promise<void>;
}

export interface ComputerProxyOptions {
  /** How long a takeover's closed screen waits for its tab to come back; `TAKEOVER_GRACE_MS`. */
  takeoverGraceMs?: number;
}

/** How often frames on an open socket mark the computer used. */
export const SOCKET_TOUCH_MS = 60_000;
/** A takeover whose screen socket closed is handed back after this, unless it reconnects. */
export const TAKEOVER_GRACE_MS = 30_000;

/** Where an accepted socket goes, and whose computer it is. */
interface Upstream {
  url: string;
  headers: Record<string, string>;
  computerId: string;
  user: CurrentUser;
  /** A Takeover's screen: the Bot whose screen it is. */
  control?: string;
}

export async function attachComputerProxies(
  server: UpgradeSource,
  deps: AppDeps,
  options: ComputerProxyOptions = {},
): Promise<ComputerProxies> {
  const graceMs = options.takeoverGraceMs ?? TAKEOVER_GRACE_MS;
  const origin = new URL(deps.config.publicUrl).origin;
  const wss = new WebSocketServer({
    noServer: true,
    // Offer the browser whatever the agent picked (noVNC asks for `binary`).
    handleProtocols: (_protocols, req) =>
      (req as IncomingMessage & { upstreamProtocol?: string }).upstreamProtocol || false,
  });
  const open = new Map<WebSocket, Upstream>();
  const graces = new Set<ReturnType<typeof setTimeout>>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!isComputerSocketPath(url.pathname)) return;
    socket.on('error', () => socket.destroy());
    void proxy(req, socket, head, url);
  };

  async function proxy(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
    if (req.headers.origin !== undefined && req.headers.origin !== origin) {
      return reject(socket, 403);
    }
    let target: Upstream;
    try {
      const user = await authenticateHeaders(deps, toHeaders(req.headers));
      // The socket's work is its organization's (db/scope.ts).
      target = await inWorkspace(user.workspaceId, () => upstreamFor(user, url));
    } catch (error) {
      if (error instanceof DomainError && error.code === COMPUTER_OFF) {
        return closeAtOnce(req, socket, head, COMPUTER_OFF_CLOSE_CODE, COMPUTER_OFF);
      }
      if (!(error instanceof DomainError))
        deps.logger.error({ err: error }, 'computer socket failed');
      return reject(socket, error instanceof DomainError ? error.status : 502);
    }
    const protocols = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const upstream = new WebSocket(target.url, protocols, { headers: target.headers });
    upstream.once('error', (error) => {
      deps.logger.warn({ err: error }, 'computer agent socket failed');
      if (!socket.destroyed) reject(socket, 502);
    });
    upstream.once('open', () => {
      (req as IncomingMessage & { upstreamProtocol?: string }).upstreamProtocol = upstream.protocol;
      wss.handleUpgrade(req, socket, head, (client) => pipe(client, upstream, target));
    });
  }

  /** Completes the upgrade only to close with `code`, so the browser can tell why. */
  function closeAtOnce(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    code: number,
    reason: string,
  ) {
    // A browser that asked for a subprotocol fails a handshake that picks none.
    const asked = (req.headers['sec-websocket-protocol'] ?? '').split(',')[0]?.trim();
    (req as IncomingMessage & { upstreamProtocol?: string }).upstreamProtocol = asked;
    wss.handleUpgrade(req, socket, head, (client) => client.close(code, reason));
  }

  async function upstreamFor(user: CurrentUser, url: URL): Promise<Upstream> {
    // Another user's Bot is refused before anything is looked up (S-18 G4).
    const botId = VNC_PATH.exec(url.pathname)?.[1];
    if (botId) await assertBotOwner(deps.db, user, botId);
    const computer = await runningComputer(deps, user);
    const agent = agentFor(deps, computer);
    if (url.pathname === PTY_PATH) {
      const size = new URLSearchParams();
      for (const key of ['cols', 'rows']) {
        const value = Number(url.searchParams.get(key));
        if (Number.isInteger(value) && value > 0 && value < 1000) size.set(key, String(value));
      }
      return {
        ...agent.socket(`/pty${size.size ? `?${size}` : ''}`),
        computerId: computer.id,
        user,
      };
    }
    const screen = await ensureScreen(
      deps,
      { id: botId!, ownerId: user.id, workspaceId: user.workspaceId },
      computer,
      agent,
    );
    return {
      ...agent.socket(`/vnc/${screenNumber(screen.displayNumber)}`),
      computerId: computer.id,
      user,
      ...(url.searchParams.get('control') === '1' ? { control: botId! } : {}),
    };
  }

  const controlling = (userId: string, botId: string) =>
    [...open.values()].some((t) => t.user.id === userId && t.control === botId);

  /** The takeover's tab went away: hand the screen back unless it returns in time. */
  function afterControlClosed({ user, control: botId }: Upstream) {
    if (!botId || controlling(user.id, botId)) return;
    const closedAt = new Date();
    const timer = setTimeout(() => {
      graces.delete(timer);
      if (controlling(user.id, botId)) return;
      void inWorkspace(user.workspaceId, () => handBack(user, botId, closedAt)).catch(
        (error: unknown) =>
          deps.logger.warn({ err: error, botId }, 'handing back a left takeover failed'),
      );
    }, graceMs);
    timer.unref();
    graces.add(timer);
  }

  async function handBack(user: CurrentUser, botId: string, closedAt: Date) {
    // Only the takeover that was open then: one taken again since is the owner's.
    const released = await releaseScreens(
      deps,
      { type: 'user', id: user.id },
      and(
        eq(schema.botScreens.botId, botId),
        eq(schema.botScreens.controlledByUserId, user.id),
        lte(schema.botScreens.controlledSince, closedAt),
      )!,
    );
    for (const screen of released) {
      if (screen.status === 'running') await syncCookies(deps, user, screen);
    }
  }

  function pipe(client: WebSocket, upstream: WebSocket, target: Upstream) {
    open.set(client, target);
    // Opening it marked the computer used already.
    let touched = Date.now();
    const used = () => {
      if (Date.now() - touched < SOCKET_TOUCH_MS) return;
      touched = Date.now();
      inWorkspace(target.user.workspaceId, () => touchComputer(deps, target.computerId)).catch(
        (error: unknown) => deps.logger.warn({ err: error }, 'marking the computer used failed'),
      );
    };
    client.on('message', (data, isBinary) => {
      used();
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    });
    upstream.on('message', (data, isBinary) => {
      used();
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    const closeBoth = () => {
      if (open.delete(client)) afterControlClosed(target);
      if (client.readyState === WebSocket.OPEN) client.close();
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    };
    client.on('close', closeBoth);
    upstream.on('close', closeBoth);
    client.on('error', () => client.terminate());
    upstream.on('error', () => upstream.terminate());
  }

  // A suspended or removed member's shell and screens in that organization
  // close now, not when they next connect.
  const unsubscribeDisabled: Unsubscribe = await deps.infra.bus.subscribe<MembershipEnded>(
    MEMBERSHIP_ENDED_CHANNEL,
    async ({ userId, workspaceId }) => {
      for (const [client, target] of open) {
        if (target.user.id !== userId || target.user.workspaceId !== workspaceId) continue;
        // No grace: they are not coming back.
        open.delete(client);
        client.close(1008, 'membership ended');
      }
      await inWorkspace(workspaceId, () =>
        releaseScreens(
          deps,
          SYSTEM_ACTOR,
          and(
            eq(schema.botScreens.controlledByUserId, userId),
            inArray(
              schema.botScreens.botId,
              deps.db
                .select({ id: schema.bots.id })
                .from(schema.bots)
                .where(eq(schema.bots.workspaceId, workspaceId)),
            ),
          )!,
        ),
      ).catch((error: unknown) =>
        deps.logger.warn(
          { err: error, userId },
          'handing back the screens of a disabled member failed',
        ),
      );
    },
  );

  server.on('upgrade', onUpgrade);
  return {
    async close() {
      server.off('upgrade', onUpgrade);
      await unsubscribeDisabled();
      for (const timer of graces) clearTimeout(timer);
      graces.clear();
      for (const client of open.keys()) client.close(1001, 'server shutting down');
      open.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
