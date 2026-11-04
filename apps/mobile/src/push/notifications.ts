import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  approvalId,
  decryptPushPayload,
  notificationRoute,
  parsePushPayload,
  suppressForFocusedChat,
  type PushPayload,
} from './payload';

export const APPROVAL_CATEGORY = 'openbots.approval';
export const APPROVE_ACTION = 'openbots.approve';
export const DENY_ACTION = 'openbots.deny';
export type PushEnvironment = 'sandbox' | 'production';
export type DeviceFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Registers the APNs token directly, never an Expo gateway token. */
export async function registerDevicePush(
  fetch: DeviceFetch,
  deviceId: string,
  environment: PushEnvironment,
): Promise<'registered' | 'denied' | 'unsupported'> {
  if (Platform.OS !== 'ios') return 'unsupported';
  let permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted) permissions = await Notifications.requestPermissionsAsync();
  if (!permissions.granted) return 'denied';
  const token = await Notifications.getDevicePushTokenAsync();
  if (token.type !== 'ios' || typeof token.data !== 'string' || !/^[0-9a-f]+$/i.test(token.data)) {
    throw new Error('APNs did not return a valid device token. Use a signed device build.');
  }
  await uploadDevicePushToken(fetch, deviceId, environment, token.data);
  return 'registered';
}

export async function uploadDevicePushToken(
  fetch: DeviceFetch,
  deviceId: string,
  environment: PushEnvironment,
  token: string,
): Promise<void> {
  const result = await fetch(`/api/v1/devices/${encodeURIComponent(deviceId)}/push`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token.toLowerCase(), environment }),
  });
  if (!result.ok) throw new Error(`Could not register notifications (${result.status}).`);
}

export interface PushHandlers {
  /** A saved host's push key, never the owner API key. */
  pushKeys(): Promise<readonly { hostId: string; pushKey: string }[]>;
  focusedChat(): { hostId: string; chatId?: string | null; botId?: string | null } | null;
  /** Must restore/switch the saved host and wait for app unlock before returning. */
  activateHost(hostId: string): Promise<boolean>;
  fetchForHost(hostId: string): Promise<DeviceFetch>;
  navigate(route: string): void;
  onError(error: unknown): void;
  /** Called on token rotation; update all paired hosts with their own credentials. */
  tokenChanged?(token: string): Promise<void>;
}

/** Install early in the app provider. Cleanup is returned for provider teardown. */
export function installPushHandlers(options: PushHandlers): () => void {
  let disposed = false;
  const handled = new Set<string>();
  const payloadFor = async (
    data: Record<string, unknown> | undefined,
  ): Promise<PushPayload | null> => {
    // Always authenticate ciphertext again in the app. A custom-scheme URL or
    // arbitrary notification data must never authorize an approval action.
    if (typeof data?.enc !== 'string') return null;
    for (const entry of await options.pushKeys()) {
      const payload = decryptPushPayload(data.enc, entry.pushKey);
      if (payload?.host === entry.hostId) return payload;
    }
    return null;
  };
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      let payload: PushPayload | null = null;
      try {
        payload = await payloadFor(notification.request.content.data);
      } catch (error) {
        options.onError(error);
      }
      const show =
        !disposed && (!payload || !suppressForFocusedChat(payload, options.focusedChat()));
      return {
        shouldShowBanner: show,
        shouldShowList: show,
        shouldPlaySound: show,
        shouldSetBadge: false,
      };
    },
    handleError: (_id, error) => options.onError(error),
  });
  void Notifications.setNotificationCategoryAsync(APPROVAL_CATEGORY, [
    {
      identifier: APPROVE_ACTION,
      buttonTitle: 'Approve',
      options: { opensAppToForeground: true, isAuthenticationRequired: true },
    },
    {
      identifier: DENY_ACTION,
      buttonTitle: 'Deny',
      options: { opensAppToForeground: true, isAuthenticationRequired: true, isDestructive: true },
    },
  ]).catch(options.onError);

  const respond = async (response: Notifications.NotificationResponse) => {
    const dedupe = `${response.notification.request.identifier}:${response.actionIdentifier}`;
    if (disposed || handled.has(dedupe)) return;
    handled.add(dedupe);
    // Bound memory without making one consumed response replay on foreground.
    if (handled.size > 256) handled.delete(handled.values().next().value!);
    try {
      const payload = await payloadFor(response.notification.request.content.data);
      if (!payload || disposed || !(await options.activateHost(payload.host))) return;
      if (disposed) return;
      const id = approvalId(payload);
      const action = response.actionIdentifier;
      if (id && (action === APPROVE_ACTION || action === DENY_ACTION)) {
        const fetch = await options.fetchForHost(payload.host);
        const result = await fetch(`/api/v1/approvals/${encodeURIComponent(id)}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: action === APPROVE_ACTION ? 'approve' : 'deny' }),
        });
        if (!result.ok)
          throw new Error(`Could not decide approval (${result.status}). Open Inbox to retry.`);
      }
      options.navigate(notificationRoute(payload));
      await Notifications.clearLastNotificationResponseAsync();
    } catch (error) {
      options.onError(error);
    }
  };
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    void respond(response);
  });
  const tokens = Notifications.addPushTokenListener((token) => {
    if (token.type === 'ios' && typeof token.data === 'string') {
      void options.tokenChanged?.(token.data).catch(options.onError);
    }
  });
  // Cold-start responses are not reliably delivered to the response listener.
  void Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (response) return respond(response);
    })
    .catch(options.onError);
  return () => {
    disposed = true;
    subscription.remove();
    tokens.remove();
    Notifications.setNotificationHandler(null);
  };
}

// Export only the validator for UI metadata; actions above require ciphertext.
export { parsePushPayload };
