import {
  createClient,
  createWsClient,
  unwrap,
  type WebSocketFactory,
  type WsClient,
  type WsStatus,
} from '@openbots/api-client';
import type { WsEvent } from '@openbots/shared';
import type { PairCode, QuickAskBot, QuickAskResult } from '../ipc.js';
import { createApprovalTracker, type PendingApproval } from './approvals.js';
import { createNoticeWatcher, ownerHandles, type ChatKind, type Notice } from './notices.js';
import { clockSkew } from './pairing.js';
import { cookieHeader, type SessionToken } from './tokens.js';

// The main process's own connection to the active server: a realtime socket
// and REST calls authenticated with the profile's session token. It feeds
// native notifications and the tray while the window is closed, decides
// approvals from the tray, and sends quick-ask messages. Not a browser, so
// the gateway's Origin check does not apply and the cookie goes in a header.

export interface ConnectionOptions {
  /** The server's origin. */
  baseUrl: string;
  token: SessionToken;
  /** A WebSocket that can send the Cookie header (the `ws` package in the app). */
  createSocket: (url: string, headers: Record<string, string>) => ReturnType<WebSocketFactory>;
  fetch?: typeof fetch;
  onNotice(notice: Notice): void;
  onApprovals(approvals: PendingApproval[]): void;
  /** A phone paired with the server (`device.paired`), for the pairing window. */
  onDevicePaired?(device: { name: string; createdAt: string }): void;
  onStatus?(status: WsStatus): void;
  /** The token was refused: the owner has to sign in again. */
  onUnauthorized?(): void;
}

export interface Connection {
  /**
   * Loads the owner, Bots, chats and pending approvals and subscribes to the
   * Bots and chats; call on every (re)connect and again when they change.
   */
  refresh(): Promise<void>;
  decide(approvalId: string, decision: 'approve' | 'deny'): Promise<void>;
  bots(): Promise<QuickAskBot[]>;
  ask(botId: string, text: string): Promise<QuickAskResult>;
  /**
   * The Bot's avatar as an image a notification can show (plan 13, the
   * server-rendered PNG), or null when there is none to be had. Kept until
   * the next refresh.
   */
  avatar(botId: string): Promise<Uint8Array | null>;
  /** The relay the server runs with (`GET /api/v1/relay`); null for none. */
  relayUrl(): Promise<string | null>;
  /** A new pairing code for the phone, good for 5 minutes, once. */
  createPairing(): Promise<PairCode & { id: string }>;
  /** Cancels a pairing nobody used; a failure is only logged by the caller. */
  cancelPairing(id: string): Promise<void>;
  /** Revokes every phone paired with the owner; returns how many. */
  revokeDevices(): Promise<number>;
  close(): void;
}

/** Pixels a side: macOS shows the notification image at 64 points and less. */
export const AVATAR_SIZE = 128;
const AVATAR_TIMEOUT_MS = 5000;
const MAX_AVATAR_BYTES = 1_048_576;

export function wsUrlFor(baseUrl: string): string {
  const url = new URL('/ws', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function createConnection(options: ConnectionOptions): Connection {
  const headers = { cookie: cookieHeader(options.token) };
  const baseFetch = options.fetch ?? fetch;
  const authedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    request.headers.set('cookie', headers.cookie);
    const response = await baseFetch(request);
    if (response.status === 401) options.onUnauthorized?.();
    return response;
  };
  const api = createClient(options.baseUrl, authedFetch);

  const names = new Map<string, string>();
  const avatars = new Map<string, Promise<Uint8Array | null>>();
  // Group and Bot to Bot chats, which notices and the tray open where the web app shows them.
  const chatKinds = new Map<string, ChatKind>();
  const chatKind = (id: string) => chatKinds.get(id);
  let handles: string[] = [];
  const subscribed = { bots: new Set<string>(), chats: new Set<string>() };

  const approvals = createApprovalTracker((id) => names.get(id), chatKind);
  const notices = createNoticeWatcher(() => ({
    botName: (id) => names.get(id),
    chatKind,
    ownerHandles: handles,
  }));

  const ws: WsClient = createWsClient({
    url: wsUrlFor(options.baseUrl),
    createSocket: (url) => options.createSocket(url, headers),
    onStatus: options.onStatus,
  });
  const offEvent = ws.onEvent((event: WsEvent) => {
    const notice = notices.onEvent(event);
    if (notice) options.onNotice(notice);
    if (approvals.onEvent(event)) options.onApprovals(approvals.list());
    if (event.type === 'device.paired') options.onDevicePaired?.(event.payload.device);
  });

  async function refresh() {
    const load = approvals.beginLoad();
    const [me, bots, chats, pending] = await Promise.all([
      unwrap(api.GET('/api/v1/me')),
      unwrap(api.GET('/api/v1/bots')),
      unwrap(api.GET('/api/v1/chats')),
      // A server without the route still gets the live events.
      unwrap(api.GET('/api/v1/approvals', { params: { query: { status: 'pending' } } })).catch(
        () => null,
      ),
    ]).catch((error: unknown) => {
      approvals.load(load, null);
      throw error;
    });
    handles = ownerHandles(me.user);
    names.clear();
    // A Bot's avatar may have changed.
    avatars.clear();
    for (const bot of bots.items) names.set(bot.id, bot.name);
    chatKinds.clear();
    for (const chat of chats.items) {
      if (chat.type === 'group' || chat.type === 'bot_to_bot') chatKinds.set(chat.id, chat.type);
    }
    const botIds = bots.items.map((b) => b.id).filter((id) => !subscribed.bots.has(id));
    const chatIds = chats.items.map((c) => c.id).filter((id) => !subscribed.chats.has(id));
    if (botIds.length > 0 || chatIds.length > 0) {
      ws.subscribe({ bots: botIds, chats: chatIds });
      for (const id of botIds) subscribed.bots.add(id);
      for (const id of chatIds) subscribed.chats.add(id);
    }
    if (approvals.load(load, pending?.items ?? null)) options.onApprovals(approvals.list());
  }

  async function loadAvatar(botId: string): Promise<Uint8Array | null> {
    const url = new URL(
      `/api/v1/bots/${encodeURIComponent(botId)}/avatar.png?size=${AVATAR_SIZE}`,
      options.baseUrl,
    );
    try {
      // An uploaded avatar redirects to its file, on the same server.
      const response = await authedFetch(url, { signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS) });
      // Electron's nativeImage reads PNG and JPEG only.
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || !/^image\/(png|jpeg)\b/.test(type)) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.byteLength > 0 && bytes.byteLength <= MAX_AVATAR_BYTES ? bytes : null;
    } catch {
      return null;
    }
  }

  return {
    refresh,

    avatar(botId) {
      let avatar = avatars.get(botId);
      if (!avatar) {
        avatar = loadAvatar(botId);
        avatars.set(botId, avatar);
      }
      return avatar;
    },

    async decide(approvalId, decision) {
      try {
        await unwrap(
          api.POST('/api/v1/approvals/{id}/decide', {
            params: { path: { id: approvalId } },
            body: { decision },
          }),
        );
      } finally {
        // Decided, expired or gone: either way it is not pending any more.
        if (approvals.remove(approvalId)) options.onApprovals(approvals.list());
      }
    },

    async bots() {
      const { items } = await unwrap(api.GET('/api/v1/bots'));
      for (const bot of items) names.set(bot.id, bot.name);
      return items.map((bot) => ({ id: bot.id, name: bot.name }));
    },

    async ask(botId, text) {
      const chat = await unwrap(
        api.GET('/api/v1/bots/{id}/chat', { params: { path: { id: botId } } }),
      );
      const message = await unwrap(
        api.POST('/api/v1/chats/{id}/messages', {
          params: { path: { id: chat.id } },
          body: { text },
        }),
      );
      return { botId, seq: message.seq };
    },

    async relayUrl() {
      return (await unwrap(api.GET('/api/v1/relay'))).relayUrl;
    },

    async createPairing() {
      const result = await api.POST('/api/v1/devices/pairings', { body: {} });
      const { id, link, expiresAt } = await unwrap(Promise.resolve(result));
      return { id, link, expiresAt, skewMs: clockSkew(result.response.headers.get('date')) };
    },

    async cancelPairing(id) {
      await unwrap(api.DELETE('/api/v1/devices/pairings/{id}', { params: { path: { id } } }));
    },

    async revokeDevices() {
      const { items } = await unwrap(api.GET('/api/v1/devices'));
      for (const device of items) {
        await unwrap(api.DELETE('/api/v1/devices/{id}', { params: { path: { id: device.id } } }));
      }
      return items.length;
    },

    close() {
      offEvent();
      ws.close();
      approvals.clear();
      avatars.clear();
    },
  };
}
