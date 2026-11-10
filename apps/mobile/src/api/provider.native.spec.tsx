import React from 'react';
import { AppState, Text } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MobileProvider, useMobile } from './provider';
import type { MobileTransport } from '../transport';

const mockHost = { id: 'host1', name: 'My Mac', directUrls: ['https://example.com'] };
const mockSnapshot = { hosts: [mockHost], activeHostId: 'host1' };
const mockConnect = jest.fn<() => Promise<MobileTransport>>();
let mockSocketStatus: ((status: 'open' | 'closed') => void) | undefined;
let mockAppState: ((state: string) => void) | undefined;
jest.mock('../hosts/store', () => ({
  HostStore: class {
    subscribe = () => () => {};
    getSnapshot = () => mockSnapshot;
    load = async () => {};
    secrets = async () => ({});
  },
}));
jest.mock('../hosts/secure-store', () => ({ createSecureHostStorage: () => ({}) }));
jest.mock('../hosts/pairing', () => ({}));
jest.mock('./sign-in', () => ({}));
jest.mock('./files', () => ({}));
jest.mock('expo-secure-store', () => ({ getItemAsync: async () => 'false' }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../components/adaptive-layout', () => ({ defaultDeviceName: () => 'Phone' }));
jest.mock('../cache/sqlite', () => ({
  createSqliteCache: async () => {
    throw new Error('No SQLite');
  },
}));
jest.mock('../native/appLock', () => ({
  AppLockPolicy: class {
    background() {}
    foreground() {
      return false;
    }
  },
  authenticateOwner: async () => true,
}));
jest.mock('../native/pushKey', () => ({
  setSharedPushKey: jest.fn(),
  removeSharedPushKey: jest.fn(),
}));
jest.mock('../push/notifications', () => ({ installPushHandlers: () => () => {} }));
jest.mock('../push/avatars', () => ({
  cacheBotNotificationAvatars: async () => {},
  forgetNotificationAvatars: jest.fn(),
}));
jest.mock('../transport', () => ({ connectHost: () => mockConnect() }));
jest.mock('@openbots/api-client', () => ({
  createClient: () => ({
    GET: async () => ({ items: [], user: { name: 'Owner', email: 'owner@example.com' } }),
  }),
  unwrap: (result: unknown) => result,
  createWsClient: (options: { onStatus: typeof mockSocketStatus }) => {
    mockSocketStatus = options.onStatus;
    return {
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      onEvent: () => () => {},
      close: jest.fn(),
    };
  },
}));

function Status() {
  const mobile = useMobile();
  return (
    <Text>{mobile.connectionFailed ? 'failed' : mobile.connected ? 'connected' : 'silent'}</Text>
  );
}
const transport = (): MobileTransport => ({
  kind: 'direct',
  baseUrl: 'https://example.com',
  fetch,
  createSocket: jest.fn() as MobileTransport['createSocket'],
  createBinarySocket: jest.fn() as MobileTransport['createBinarySocket'],
  close: jest.fn(),
});

beforeEach(() => {
  jest.useFakeTimers();
  mockConnect.mockReset().mockRejectedValue(new Error('Network request failed'));
  mockSocketStatus = undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
    mockAppState = callback as typeof mockAppState;
    return { remove: jest.fn() };
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('silent background reconnection', () => {
  it('notifies once after three failures, keeps retrying, and clears on a successful socket', async () => {
    render(
      <MobileProvider>
        <Status />
      </MobileProvider>,
    );
    act(() => mockAppState!('active'));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));
    expect(screen.getByText('silent')).toBeTruthy();
    expect(screen.queryByText('You’re offline')).toBeNull();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(500);
    });
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('You’re offline')).toBeNull();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(mockConnect).toHaveBeenCalledTimes(3);
    expect(screen.getAllByText('You’re offline')).toHaveLength(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(mockConnect).toHaveBeenCalledTimes(4);
    expect(screen.getAllByText('You’re offline')).toHaveLength(1);
    mockConnect.mockResolvedValue(transport());
    await act(async () => {
      await jest.advanceTimersByTimeAsync(4000);
    });
    // A transport handshake alone must not reset failed WebSocket attempts.
    expect(screen.getAllByText('You’re offline')).toHaveLength(1);
    act(() => mockSocketStatus!('open'));
    expect(screen.getByText('connected')).toBeTruthy();
    expect(screen.queryByText('You’re offline')).toBeNull();
    act(() => mockSocketStatus!('closed'));
    expect(screen.getByText('silent')).toBeTruthy();
  });

  it('counts failed WebSocket handshakes even when transport connections succeed', async () => {
    mockConnect.mockResolvedValue(transport());
    render(
      <MobileProvider>
        <Status />
      </MobileProvider>,
    );
    act(() => mockAppState!('active'));
    await waitFor(() => expect(mockSocketStatus).toBeDefined());
    for (let attempt = 1; attempt <= 3; attempt++) {
      act(() => mockSocketStatus!('closed'));
      expect(screen.queryAllByText('You’re offline')).toHaveLength(attempt === 3 ? 1 : 0);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(500);
      });
    }
    act(() => mockSocketStatus!('open'));
    expect(screen.queryByText('You’re offline')).toBeNull();
  });

  it('restarts the silent retry budget when the app returns to the foreground', async () => {
    render(
      <MobileProvider>
        <Status />
      </MobileProvider>,
    );
    act(() => mockAppState!('active'));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getAllByText('You’re offline')).toHaveLength(1);
    act(() => mockAppState!('background'));
    expect(screen.queryByText('You’re offline')).toBeNull();
    await act(async () => {
      mockAppState!('active');
    });
    expect(screen.getByText('silent')).toBeTruthy();
    expect(screen.queryByText('You’re offline')).toBeNull();
  });
});
