import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64urlEncode, base64urlDecode, type BinaryWebSocketLike } from '@openbots/tunnel';
import {
  createPreviewBridge,
  previewSocketPath,
  PREVIEW_CHUNK_BYTES,
  PREVIEW_MAX_QUEUE_BYTES,
  type BrowserEvent,
} from './bridge';
const botId = '12345678-1234-1234-1234-123456789abc';
const session = 'test-session-secret';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.useRealTimers();
});
function setup() {
  const socket: BinaryWebSocketLike = {
    readyState: 1,
    binaryType: 'arraybuffer',
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send: vi.fn(),
    close: vi.fn(),
  };
  const createSocket = vi.fn(() => socket);
  const sendToBrowser = vi.fn<(event: BrowserEvent) => void>();
  const onStatus = vi.fn();
  const bridge = createPreviewBridge({ botId, session, createSocket, sendToBrowser, onStatus });
  cleanup.push(() => bridge.dispose());
  const message = (value: Record<string, unknown>) =>
    bridge.handleMessage(JSON.stringify({ session, ...value }));
  const open = () => {
    message({ type: 'open', path: previewSocketPath(botId) });
    socket.onopen?.({});
  };
  return { socket, createSocket, sendToBrowser, onStatus, bridge, message, open };
}

describe('view-only WebView tunnel bridge', () => {
  it('pins the UUID Bot path and rejects arbitrary origins, control query, malformed JSON and wrong sessions', () => {
    const test = setup();
    for (const path of [
      previewSocketPath(botId) + '?control=1',
      '/api/v1/computer/pty',
      'wss://elsewhere.invalid',
      '//evil',
    ])
      test.message({ type: 'open', path });
    test.bridge.handleMessage('{');
    test.message({ session: 'wrong-session', type: 'open', path: previewSocketPath(botId) });
    expect(test.createSocket).not.toHaveBeenCalled();
    expect(() => previewSocketPath('../bot')).toThrow();
    test.open();
    test.open();
    expect(test.createSocket).toHaveBeenCalledExactlyOnceWith(previewSocketPath(botId));
  });
  it('preserves binary bytes in both directions without any credentials in browser events', () => {
    const test = setup();
    test.open();
    const bytes = Uint8Array.of(0, 255, 128, 10, 0);
    test.message({ type: 'send', bytes: base64urlEncode(bytes) });
    expect(test.socket.send).toHaveBeenCalledExactlyOnceWith(bytes);
    test.socket.onmessage?.({ data: bytes.buffer });
    const event = test.sendToBrowser.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'data');
    expect(event?.type).toBe('data');
    if (event?.type === 'data') expect(base64urlDecode(event.bytes)).toEqual(bytes);
    expect(JSON.stringify(test.sendToBrowser.mock.calls)).not.toMatch(
      /Bearer|apiKey|authorization/,
    );
  });
  it('chunks incoming frames and waits for consumption acknowledgements before sending more', () => {
    const test = setup();
    test.open();
    test.socket.onmessage?.({ data: new Uint8Array(PREVIEW_CHUNK_BYTES * 6).buffer });
    expect(test.sendToBrowser.mock.calls.filter(([event]) => event.type === 'data')).toHaveLength(
      4,
    );
    test.message({ type: 'ack', seq: 0 });
    expect(test.sendToBrowser.mock.calls.filter(([event]) => event.type === 'data')).toHaveLength(
      5,
    );
    test.message({ type: 'ack', seq: 0 }); // replayed acknowledgements release no further credit
    expect(test.sendToBrowser.mock.calls.filter(([event]) => event.type === 'data')).toHaveLength(
      5,
    );
  });
  it('closes a sender that exceeds the bounded queue', () => {
    const test = setup();
    test.open();
    test.socket.onmessage?.({ data: new Uint8Array(PREVIEW_MAX_QUEUE_BYTES + 1).buffer });
    expect(test.socket.close).toHaveBeenCalledTimes(1);
    expect(test.onStatus).toHaveBeenCalledWith('error');
  });
  it('detaches callbacks and closes once on cleanup, ignoring late messages', () => {
    const test = setup();
    test.open();
    test.bridge.dispose();
    test.bridge.dispose();
    const count = test.sendToBrowser.mock.calls.length;
    test.message({ type: 'send', bytes: 'AA' });
    test.message({ type: 'open', path: previewSocketPath(botId) });
    expect(test.socket.close).toHaveBeenCalledTimes(1);
    expect(test.socket.onmessage).toBeNull();
    expect(test.socket.onclose).toBeNull();
    expect(test.socket.send).not.toHaveBeenCalled();
    expect(test.sendToBrowser).toHaveBeenCalledTimes(count);
  });
  it('closes a connection whose RFB handshake stalls', () => {
    vi.useFakeTimers();
    const test = setup();
    test.open();
    vi.advanceTimersByTime(20_000);
    expect(test.socket.close).toHaveBeenCalledTimes(1);
    expect(test.onStatus).toHaveBeenCalledWith('error');
  });
});
