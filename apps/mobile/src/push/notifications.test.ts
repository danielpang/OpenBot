import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

vi.mock('expo-notifications', () => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getDevicePushTokenAsync: vi.fn(),
  setNotificationHandler: vi.fn(),
  setNotificationCategoryAsync: vi.fn(() => Promise.resolve()),
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
  getLastNotificationResponseAsync: vi.fn(() => Promise.resolve(null)),
  clearLastNotificationResponseAsync: vi.fn(),
}));

import * as Notifications from 'expo-notifications';
import { registerDevicePush } from './notifications';

describe('registerDevicePush', () => {
  afterEach(() => {
    Platform.OS = 'ios';
    vi.clearAllMocks();
  });

  it('returns unsupported on Android without requesting an APNs token', async () => {
    Platform.OS = 'android';
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(registerDevicePush(fetchImpl, 'device-1', 'production')).resolves.toBe(
      'unsupported',
    );
    expect(Notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
