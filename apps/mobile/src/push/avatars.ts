import { base64urlEncode } from '@openbots/tunnel';
import { cacheNotificationAvatar } from '../native/pushKey';
import type { DeviceFetch } from './notifications';

interface BotAvatar {
  id: string;
  avatar: { kind: 'generated'; [key: string]: unknown } | { kind: 'upload'; file_id: string };
}
const cached = new Map<string, string>();

/** Cache authenticated image bytes locally; the extension never fetches owner URLs. */
export async function cacheBotNotificationAvatars(
  fetch: DeviceFetch,
  hostId: string,
  bots: readonly BotAvatar[],
): Promise<void> {
  // Sequential downloads avoid competing with a streaming transcript on a relay.
  for (const bot of bots) {
    const key = `${hostId}:${bot.id}`;
    const version = JSON.stringify(bot.avatar);
    if (cached.get(key) === version) continue;
    try {
      const path =
        bot.avatar.kind === 'upload'
          ? `/api/v1/files/${encodeURIComponent(bot.avatar.file_id)}`
          : `/api/v1/bots/${encodeURIComponent(bot.id)}/avatar.png?size=128`;
      const result = await fetch(path);
      if (!result.ok) continue;
      const length = Number(result.headers.get('content-length'));
      if (length > 1_048_576) continue;
      const bytes = new Uint8Array(await result.arrayBuffer());
      if (bytes.byteLength > 1_048_576) continue;
      const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (!png && !jpeg) continue;
      let base64 = base64urlEncode(bytes).replace(/-/g, '+').replace(/_/g, '/');
      base64 += '='.repeat((4 - (base64.length % 4)) % 4);
      await cacheNotificationAvatar(hostId, bot.id, base64);
      cached.set(key, version);
      if (cached.size > 512) cached.delete(cached.keys().next().value!);
    } catch {
      // An avatar is optional; connectivity and notices still work without it.
    }
  }
}

export function forgetNotificationAvatars(hostId: string): void {
  for (const key of cached.keys()) if (key.startsWith(`${hostId}:`)) cached.delete(key);
}
