import {
  parseServerFrame,
  type ClientFrame,
  type ControlFrame,
  type WsEvent,
  type WsEventOf,
  type WsEventType,
} from '@openbots/shared';

// The realtime client for `/ws` (plan 14.2): typed event handlers, automatic
// reconnect with backoff, and a resync callback per chat so the app can fetch
// what it missed (`GET /api/v1/chats/:id/resync?since=<seq>`).

/** The subset of the browser WebSocket this client uses. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface WsClientOptions {
  /** e.g. `wss://openbots.example.com/ws`. */
  url: string;
  /**
   * Called after every reconnect for each subscribed chat, with the highest
   * seq seen in it (0 if none). Fetch the resync route and merge the result.
   */
  onResync?: (chatId: string, sinceSeq: number) => void | Promise<void>;
  onStatus?: (status: WsStatus) => void;
  /** `subscribed`, `pong` and `error` frames from the server. */
  onControl?: (frame: ControlFrame) => void;
  /** Defaults to the global WebSocket (browsers, Node 22). */
  createSocket?: WebSocketFactory;
  /** First reconnect delay; doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** How often to ping; a socket silent for twice this is reconnected. */
  pingMs?: number;
}

export interface WsClient {
  readonly status: WsStatus;
  subscribe(target: { chats?: string[]; bots?: string[] }): void;
  unsubscribe(target: { chats?: string[]; bots?: string[] }): void;
  on<T extends WsEventType>(type: T, handler: (event: WsEventOf<T>) => void): () => void;
  /** Every event, whatever its type. */
  onEvent(handler: (event: WsEvent) => void): () => void;
  /** Records a seq the app already holds, e.g. after loading a transcript page. */
  noteSeq(chatId: string, seq: number): void;
  close(): void;
}

const OPEN = 1;

export function createWsClient(options: WsClientOptions): WsClient {
  const {
    url,
    onResync,
    onStatus,
    onControl,
    createSocket = (u) => new WebSocket(u) as unknown as WebSocketLike,
    backoffMs = 500,
    maxBackoffMs = 30_000,
    pingMs = 25_000,
  } = options;

  const chats = new Set<string>();
  const bots = new Set<string>();
  const lastSeq = new Map<string, number>();
  const handlers = new Map<string, Set<(event: WsEvent) => void>>();
  const anyHandlers = new Set<(event: WsEvent) => void>();

  let socket: WebSocketLike | undefined;
  let status: WsStatus = 'closed';
  let closed = false;
  let attempts = 0;
  let connectedBefore = false;
  let lastHeard = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const setStatus = (next: WsStatus) => {
    status = next;
    onStatus?.(next);
  };

  const send = (frame: ClientFrame) => {
    if (socket?.readyState === OPEN) socket.send(JSON.stringify(frame));
  };

  const noteSeq = (chatId: string, seq: number) => {
    if (seq > (lastSeq.get(chatId) ?? 0)) lastSeq.set(chatId, seq);
  };

  function connect() {
    setStatus('connecting');
    const ws = createSocket(url);
    socket = ws;
    ws.onopen = () => {
      attempts = 0;
      lastHeard = Date.now();
      setStatus('open');
      if (chats.size || bots.size) send({ type: 'subscribe', chats: [...chats], bots: [...bots] });
      if (connectedBefore && onResync) {
        for (const chatId of chats) void onResync(chatId, lastSeq.get(chatId) ?? 0);
      }
      connectedBefore = true;
      pingTimer = setInterval(() => {
        if (Date.now() - lastHeard > pingMs * 2) ws.close(4000, 'no answer');
        else send({ type: 'ping' });
      }, pingMs);
    };
    ws.onmessage = ({ data }) => {
      lastHeard = Date.now();
      let json: unknown;
      try {
        json = JSON.parse(String(data));
      } catch {
        return;
      }
      const frame = parseServerFrame(json);
      if (!frame) return;
      if (frame.type === 'subscribed' || frame.type === 'pong' || frame.type === 'error') {
        onControl?.(frame);
        return;
      }
      if (frame.chat_id !== undefined && frame.seq !== undefined) noteSeq(frame.chat_id, frame.seq);
      for (const handler of handlers.get(frame.type) ?? []) handler(frame);
      for (const handler of anyHandlers) handler(frame);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearInterval(pingTimer);
      if (socket !== ws) return;
      socket = undefined;
      setStatus('closed');
      if (closed) return;
      const delay = Math.min(maxBackoffMs, backoffMs * 2 ** attempts++);
      retryTimer = setTimeout(connect, delay * (0.75 + Math.random() * 0.5));
    };
  }

  connect();

  return {
    get status() {
      return status;
    },
    subscribe(target) {
      const add = { chats: target.chats ?? [], bots: target.bots ?? [] };
      for (const id of add.chats) chats.add(id);
      for (const id of add.bots) bots.add(id);
      send({ type: 'subscribe', ...add });
    },
    unsubscribe(target) {
      const remove = { chats: target.chats ?? [], bots: target.bots ?? [] };
      for (const id of remove.chats) chats.delete(id);
      for (const id of remove.bots) bots.delete(id);
      send({ type: 'unsubscribe', ...remove });
    },
    on(type, handler) {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      const h = handler as (event: WsEvent) => void;
      set.add(h);
      return () => set.delete(h);
    },
    onEvent(handler) {
      anyHandlers.add(handler);
      return () => anyHandlers.delete(handler);
    },
    noteSeq,
    close() {
      closed = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      const ws = socket;
      socket = undefined;
      ws?.close(1000, 'client closed');
      setStatus('closed');
    },
  };
}
