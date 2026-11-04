import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { base64urlDecode } from '@openbots/tunnel';

export interface PushPayload {
  v: 1;
  kind: 'approval' | 'question' | 'mention' | 'routine' | 'long_task';
  tag: string;
  title: string;
  body: string;
  host: string;
  target: { botId: string; chatId: string | null; seq: number | null; threadRootId: string | null };
}

const kinds = new Set(['approval', 'question', 'mention', 'routine', 'long_task']);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
const nullableId = (value: unknown) => value === null || identifier(value);

/** Reject unknown versions and malformed targets before routing or issuing an action. */
export function parsePushPayload(value: unknown): PushPayload | null {
  if (!record(value) || value.v !== 1 || !kinds.has(String(value.kind))) return null;
  if (!identifier(value.host) || !identifier(value.tag)) return null;
  if (typeof value.title !== 'string' || value.title.length > 4096) return null;
  if (typeof value.body !== 'string' || value.body.length > 16384) return null;
  const target = value.target;
  if (!record(target) || !identifier(target.botId)) return null;
  if (!nullableId(target.chatId) || !nullableId(target.threadRootId)) return null;
  if (target.seq !== null && (!Number.isSafeInteger(target.seq) || Number(target.seq) < 1))
    return null;
  return value as unknown as PushPayload;
}

export const PUSH_AAD = new TextEncoder().encode('openbots-push-v1');

/** Same framing and AAD as the Swift extension and server's encryptPush. */
export function decryptPushPayload(encoded: string, base64urlKey: string): PushPayload | null {
  try {
    const sealed = base64urlDecode(encoded);
    const key = base64urlDecode(base64urlKey);
    if (key.length !== 32 || sealed.length < 28 || sealed.length > 65536) return null;
    const plain = chacha20poly1305(key, sealed.subarray(0, 12), PUSH_AAD).decrypt(
      sealed.subarray(12),
    );
    return parsePushPayload(JSON.parse(new TextDecoder().decode(plain)));
  } catch {
    return null;
  }
}

export function approvalId(payload: PushPayload): string | null {
  if (payload.kind !== 'approval' || !payload.tag.startsWith('approval:')) return null;
  const id = payload.tag.slice('approval:'.length);
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : null;
}

export function notificationRoute(payload: PushPayload): string {
  const query = new URLSearchParams({ host: payload.host, botId: payload.target.botId });
  if (payload.target.seq !== null) query.set('seq', String(payload.target.seq));
  if (payload.target.threadRootId !== null) query.set('threadRootId', payload.target.threadRootId);
  return payload.target.chatId
    ? `/chat/${encodeURIComponent(payload.target.chatId)}?${query}`
    : `/bot/${encodeURIComponent(payload.target.botId)}?${query}`;
}

/** Compare both host and chat: equal chat IDs on another host must still notify. */
export function suppressForFocusedChat(
  payload: PushPayload,
  focused: { hostId: string; chatId?: string | null; botId?: string | null } | null,
): boolean {
  if (!focused || payload.host !== focused.hostId) return false;
  return payload.target.chatId !== null
    ? payload.target.chatId === focused.chatId
    : payload.target.botId === focused.botId;
}
