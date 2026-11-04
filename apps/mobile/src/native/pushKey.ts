import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

interface PushKeyModule {
  setPushKey(host: string, key: string): Promise<void>;
  removePushKey(host: string): Promise<void>;
  cacheNotificationAvatar(host: string, bot: string, base64Image: string): Promise<void>;
}

function moduleForDevice(): PushKeyModule | null {
  if (Platform.OS !== 'ios') return null;
  const module = requireOptionalNativeModule<PushKeyModule>('OpenBotsNative');
  if (!module) throw new Error('Push keys require an OpenBots development or release build.');
  return module;
}

/** Share only the push key with the Notification Service Extension. */
export async function setSharedPushKey(hostId: string, base64urlKey: string): Promise<void> {
  if (!hostId || !/^[A-Za-z0-9_-]{43}$/.test(base64urlKey)) {
    throw new Error('Expected a host ID and a 32-byte base64url push key.');
  }
  await moduleForDevice()?.setPushKey(hostId, base64urlKey);
}

export async function removeSharedPushKey(hostId: string): Promise<void> {
  await moduleForDevice()?.removePushKey(hostId);
}

/** The extension uses this local PNG or JPEG; no unauthenticated avatar URL leaves the host. */
export async function cacheNotificationAvatar(hostId: string, botId: string, base64Image: string) {
  await moduleForDevice()?.cacheNotificationAvatar(hostId, botId, base64Image);
}
