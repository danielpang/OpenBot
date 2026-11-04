import { base64urlDecode, base64urlEncode, type BinaryWebSocketLike } from '@openbots/tunnel';

export const PREVIEW_CHUNK_BYTES = 48 * 1024;
export const PREVIEW_MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type PreviewStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
export type BrowserEvent =
  | { type: 'open' }
  | { type: 'data'; bytes: string; seq: number }
  | { type: 'close'; code: number; reason: string }
  | { type: 'error' };
export interface PreviewBridgeOptions {
  botId: string;
  session: string;
  createSocket(path: string): BinaryWebSocketLike;
  sendToBrowser(event: BrowserEvent): void;
  onStatus(status: PreviewStatus): void;
}

export function previewSocketPath(botId: string): string {
  if (!UUID.test(botId)) throw new Error('Invalid Bot ID for screen preview.');
  return `/api/v1/bots/${botId}/screen/vnc`;
}

/** A single credential-free WebView channel, pinned to one view-only Bot socket. */
export function createPreviewBridge(options: PreviewBridgeOptions) {
  const path = previewSocketPath(options.botId);
  let socket: BinaryWebSocketLike | null = null;
  let disposed = false;
  let used = false;
  let nextSequence = 0;
  let queuedBytes = 0;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  const pending: { bytes: Uint8Array; seq: number }[] = [];
  const inFlight = new Map<number, number>();
  const emit = (event: BrowserEvent) => {
    if (!disposed) options.sendToBrowser(event);
  };
  const cleanupSocket = () => {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    if (!socket) return;
    const previous = socket;
    socket = null;
    previous.onopen = null;
    previous.onmessage = null;
    previous.onclose = null;
    previous.onerror = null;
    previous.close(1000, 'preview closed');
    pending.length = 0;
    inFlight.clear();
    queuedBytes = 0;
  };
  const fail = () => {
    cleanupSocket();
    if (!disposed) {
      options.onStatus('error');
      emit({ type: 'error' });
      emit({ type: 'close', code: 1008, reason: 'Screen preview disconnected' });
    }
  };
  const flush = () => {
    while (!disposed && inFlight.size < 4 && pending.length) {
      const item = pending.shift()!;
      inFlight.set(item.seq, item.bytes.byteLength);
      emit({ type: 'data', seq: item.seq, bytes: base64urlEncode(item.bytes) });
    }
  };
  return {
    handleMessage(raw: string) {
      if (disposed || raw.length > PREVIEW_CHUNK_BYTES * 2) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (
        !message ||
        typeof message !== 'object' ||
        Array.isArray(message) ||
        message.session !== options.session
      )
        return;
      if (message.type === 'open') {
        if (used || message.path !== path) return;
        used = true;
        options.onStatus('connecting');
        try {
          socket = options.createSocket(path);
        } catch {
          fail();
          return;
        }
        handshakeTimer = setTimeout(fail, 20_000);
        socket.binaryType = 'arraybuffer';
        socket.onopen = () => {
          emit({ type: 'open' });
        };
        socket.onmessage = ({ data }) => {
          const bytes =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : null;
          if (!bytes || queuedBytes + bytes.byteLength > PREVIEW_MAX_QUEUE_BYTES) {
            fail();
            return;
          }
          queuedBytes += bytes.byteLength;
          for (let index = 0; index < bytes.length; index += PREVIEW_CHUNK_BYTES) {
            pending.push({
              bytes: bytes.slice(index, index + PREVIEW_CHUNK_BYTES),
              seq: nextSequence++,
            });
          }
          flush();
        };
        socket.onclose = ({ code }) => {
          cleanupSocket();
          options.onStatus('disconnected');
          emit({
            type: 'close',
            code: code === 1000 ? 1000 : 1006,
            reason: 'Screen preview disconnected',
          });
        };
        socket.onerror = fail;
      } else if (message.type === 'send' && socket?.readyState === 1) {
        if (
          typeof message.bytes !== 'string' ||
          message.bytes.length > (PREVIEW_CHUNK_BYTES * 4) / 3 + 4
        ) {
          fail();
          return;
        }
        try {
          const bytes = base64urlDecode(message.bytes);
          if (bytes.byteLength > PREVIEW_CHUNK_BYTES) {
            fail();
            return;
          }
          socket.send(bytes);
        } catch {
          fail();
        }
      } else if (message.type === 'ack' && Number.isSafeInteger(message.seq)) {
        const size = inFlight.get(Number(message.seq));
        if (size !== undefined) {
          inFlight.delete(Number(message.seq));
          queuedBytes -= size;
          flush();
        }
      } else if (message.type === 'close') {
        cleanupSocket();
        options.onStatus('disconnected');
      } else if (
        message.type === 'status' &&
        (message.status === 'connected' || message.status === 'error')
      ) {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        options.onStatus(message.status);
      }
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        cleanupSocket();
      }
    },
  };
}
