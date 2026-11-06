import React, { useEffect } from 'react';
import type * as ReactNative from 'react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { TabletWorkspace } from './tablet-workspace';

let mockWide = true;
let mockPathname = '/bot/bot-1';
let mockSegment = 'bot';
let mockClient: object | null = {};
let mockHost: { id: string; name: string } | null = { id: 'host-1', name: 'My Mac' };
const mockReplace = jest.fn();
const mockMount = jest.fn();
const mockUnmount = jest.fn();
let mockRoster: Record<string, unknown>;

jest.mock('./adaptive-layout', () => ({
  useTabletLayout: () => mockWide,
  TABLET_SIDEBAR_WIDTH: 320,
}));
jest.mock('../api/provider', () => ({
  useMobile: () => ({ ready: true, host: mockHost, client: mockClient, connecting: false }),
}));
jest.mock('../screens/inbox-data', () => ({ useInbox: () => ({ count: 4 }) }));
jest.mock('../screens/bots', () => ({
  BotsScreen: (props: Record<string, unknown>) => {
    mockRoster = props;
    const { Text } = jest.requireActual<typeof ReactNative>('react-native');
    return <Text>Shared roster</Text>;
  },
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-router', () => ({
  router: { replace: (...args: unknown[]) => mockReplace(...args) },
  usePathname: () => mockPathname,
  useGlobalSearchParams: () => ({ id: 'bot-1' }),
  useSegments: () => [mockSegment],
}));

function Detail() {
  useEffect(() => {
    mockMount();
    return () => {
      mockUnmount();
    };
  }, []);
  const { Text } = jest.requireActual<typeof ReactNative>('react-native');
  return <Text>Current conversation</Text>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWide = true;
  mockSegment = 'bot';
  mockPathname = '/bot/bot-1';
  mockHost = { id: 'host-1', name: 'My Mac' };
  mockClient = {};
});

describe('iPad workspace', () => {
  it('keeps the shared roster beside a deep-linked conversation and marks the active Bot', () => {
    render(
      <TabletWorkspace>
        <Detail />
      </TabletWorkspace>,
    );
    expect(screen.getByTestId('tablet-sidebar')).toBeTruthy();
    expect(screen.getByText('Current conversation')).toBeTruthy();
    expect(mockRoster).toMatchObject({ sidebar: true, selected: { kind: 'bot', id: 'bot-1' } });
    expect(screen.getByRole('button', { name: 'Bots' }).props.accessibilityState.selected).toBe(
      true,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Inbox, 4 pending' }));
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/inbox');
    fireEvent.press(screen.getByRole('button', { name: 'Settings' }));
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/settings');
  });

  it('keeps the detail mounted when a window narrows and widens', () => {
    const view = render(
      <TabletWorkspace>
        <Detail />
      </TabletWorkspace>,
    );
    mockWide = false;
    view.rerender(
      <TabletWorkspace>
        <Detail />
      </TabletWorkspace>,
    );
    expect(screen.queryByTestId('tablet-sidebar')).toBeNull();
    expect(screen.getByText('Current conversation')).toBeTruthy();
    mockWide = true;
    view.rerender(
      <TabletWorkspace>
        <Detail />
      </TabletWorkspace>,
    );
    expect(screen.getByTestId('tablet-sidebar')).toBeTruthy();
    expect(mockMount).toHaveBeenCalledTimes(1);
    expect(mockUnmount).not.toHaveBeenCalled();
  });

  it('does not expose workspace content during onboarding or without a saved host', () => {
    mockSegment = '(onboarding)';
    const view = render(
      <TabletWorkspace>
        <Detail />
      </TabletWorkspace>,
    );
    expect(screen.queryByTestId('tablet-sidebar')).toBeNull();
    mockSegment = '(tabs)';
    mockHost = null;
    view.rerender(
      <TabletWorkspace>
        <Detail />
      </TabletWorkspace>,
    );
    expect(screen.queryByTestId('tablet-sidebar')).toBeNull();
  });

  it('keeps server management available offline without mounting API-bound controls', () => {
    mockClient = null;
    render(
      <TabletWorkspace>
        <Detail />
      </TabletWorkspace>,
    );
    expect(screen.queryByText('Shared roster')).toBeNull();
    expect(screen.getByText('Reconnect to browse your Bots.')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Settings' }));
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/settings');
  });
});
