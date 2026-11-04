import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  approvalId,
  decryptPushPayload,
  notificationRoute,
  parsePushPayload,
  suppressForFocusedChat,
  type PushPayload,
} from './payload';

const payload: PushPayload = {
  v: 1,
  kind: 'approval',
  tag: 'approval:approval-1',
  title: 'Bot needs approval',
  body: 'Run a tool?',
  host: 'saved-host',
  target: { botId: 'bot-1', chatId: 'chat-1', seq: 42, threadRootId: 'message-1' },
};
const key = Buffer.alloc(32, 7);
function serverEncrypt(value: unknown, aad = 'openbots-push-v1') {
  const nonce = Buffer.alloc(12, 3);
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad), { plaintextLength: Buffer.byteLength(JSON.stringify(value)) });
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([nonce, bytes, cipher.getAuthTag()]).toString('base64url');
}

describe('encrypted APNs payload', () => {
  it('opens the exact server nonce/ciphertext/tag framing and AAD', () => {
    expect(decryptPushPayload(serverEncrypt(payload), key.toString('base64url'))).toEqual(payload);
  });
  it('rejects wrong keys, modified ciphertext, short input and wrong protocol AAD', () => {
    const enc = serverEncrypt(payload);
    const bytes = Buffer.from(enc, 'base64url');
    bytes[15] = bytes[15]! ^ 1;
    expect(decryptPushPayload(enc, Buffer.alloc(32, 8).toString('base64url'))).toBeNull();
    expect(decryptPushPayload(bytes.toString('base64url'), key.toString('base64url'))).toBeNull();
    expect(decryptPushPayload('abc', key.toString('base64url'))).toBeNull();
    expect(
      decryptPushPayload(serverEncrypt(payload, 'another-app'), key.toString('base64url')),
    ).toBeNull();
  });
  it('rejects unsupported versions and malformed authenticated targets', () => {
    for (const value of [
      { ...payload, v: 2 },
      { ...payload, host: '' },
      { ...payload, kind: 'unknown' },
      { ...payload, target: { ...payload.target, seq: -1 } },
      { ...payload, target: { ...payload.target, chatId: 7 } },
    ])
      expect(decryptPushPayload(serverEncrypt(value), key.toString('base64url'))).toBeNull();
    expect(parsePushPayload(null)).toBeNull();
  });
});

describe('notification navigation and actions', () => {
  it('opens the exact host, chat, sequence and thread', () => {
    const route = notificationRoute(payload);
    expect(route).toBe('/chat/chat-1?host=saved-host&botId=bot-1&seq=42&threadRootId=message-1');
    expect(
      notificationRoute({
        ...payload,
        target: { botId: 'a/b', chatId: null, seq: null, threadRootId: null },
      }),
    ).toBe('/bot/a%2Fb?host=saved-host&botId=a%2Fb');
  });
  it('derives approval IDs only from approval tags', () => {
    expect(approvalId(payload)).toBe('approval-1');
    expect(approvalId({ ...payload, kind: 'question' })).toBeNull();
    expect(approvalId({ ...payload, tag: 'approval:../wrong' })).toBeNull();
  });
  it('suppresses only the focused chat on the same host', () => {
    expect(suppressForFocusedChat(payload, { hostId: 'saved-host', chatId: 'chat-1' })).toBe(true);
    expect(suppressForFocusedChat(payload, { hostId: 'other-host', chatId: 'chat-1' })).toBe(false);
    expect(suppressForFocusedChat(payload, { hostId: 'saved-host', chatId: 'chat-2' })).toBe(false);
    expect(suppressForFocusedChat(payload, null)).toBe(false);
  });
});
