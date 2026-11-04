// This module is bundled for WKWebView, never imported by React Native.
import RFB from '@novnc/novnc';

declare global {
  interface Window {
    ReactNativeWebView: { postMessage(message: string): void };
    __previewConfig: { session: string; path: string };
    __openbotsPreviewReceive: (message: {
      type: string;
      seq?: number;
      bytes?: string;
      code?: number;
      reason?: string;
    }) => void;
  }
}
const config = window.__previewConfig;
const post = (message: Record<string, unknown>) =>
  window.ReactNativeWebView.postMessage(JSON.stringify({ ...message, session: config.session }));
const encode = (data: Uint8Array) => {
  let text = '';
  for (const byte of data) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const decode = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
class BridgedSocket {
  readyState = 0;
  binaryType = 'arraybuffer';
  protocol = '';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send(value: ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== 1) throw new Error('Preview channel is not open');
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    for (let index = 0; index < bytes.length; index += 48 * 1024)
      post({ type: 'send', bytes: encode(bytes.subarray(index, index + 48 * 1024)) });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    post({ type: 'close' });
  }
}
const channel = new BridgedSocket();
window.__openbotsPreviewReceive = (message) => {
  if (message.type === 'open' && channel.readyState === 0) {
    channel.readyState = 1;
    channel.onopen?.(new Event('open'));
  } else if (
    message.type === 'data' &&
    channel.readyState === 1 &&
    typeof message.bytes === 'string'
  ) {
    try {
      channel.onmessage?.(new MessageEvent('message', { data: decode(message.bytes).buffer }));
    } finally {
      post({ type: 'ack', seq: message.seq });
    }
  } else if (message.type === 'close') {
    channel.readyState = 3;
    channel.onclose?.(
      new CloseEvent('close', {
        code: message.code,
        reason: message.reason,
        wasClean: message.code === 1000,
      }),
    );
  } else if (message.type === 'error') channel.onerror?.(new Event('error'));
};
const screen = document.getElementById('screen')!;
try {
  const viewer = new RFB(screen, channel);
  viewer.viewOnly = true;
  viewer.scaleViewport = true;
  viewer.resizeSession = false;
  viewer.showDotCursor = false;
  viewer.addEventListener('connect', () => post({ type: 'status', status: 'connected' }));
  viewer.addEventListener('disconnect', () => post({ type: 'close' }));
  viewer.addEventListener('securityfailure', () => post({ type: 'status', status: 'error' }));
  window.addEventListener('pagehide', () => {
    viewer.disconnect();
    channel.close();
  });
  // RFB attaches handlers on its next task; the native socket may open at once.
  setTimeout(() => post({ type: 'open', path: config.path }), 0);
} catch {
  post({ type: 'status', status: 'error' });
}
