import React from 'react';
import type * as ReactNative from 'react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import TabsLayout from '../../app/(tabs)/_layout';

const mockMobile = {
  ready: true,
  host: { id: 'host' },
  client: {},
  connecting: false,
  error: null,
  refresh: jest.fn(),
};
let mockCount = 3;
let mockSegment = 'bots';
let mockTabsProps: Record<string, unknown>;
const mockTriggers: string[] = [];
jest.mock('../../src/api/provider', () => ({ useMobile: () => mockMobile }));
jest.mock('../../src/screens/inbox-data', () => ({ useInbox: () => ({ count: mockCount }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-router', () => ({
  useSegments: () => ['(tabs)', mockSegment],
  router: { replace: jest.fn() },
  Redirect: ({ href }: { href: string }) => {
    const { Text } = jest.requireActual<typeof ReactNative>('react-native');
    return <Text>{href}</Text>;
  },
}));
jest.mock('expo-router/unstable-native-tabs', () => {
  const { View, Text } = jest.requireActual<typeof ReactNative>('react-native');
  function NativeTabs(props: React.PropsWithChildren<Record<string, unknown>>) {
    mockTabsProps = props;
    return <View testID="native-tabs">{props.children}</View>;
  }
  function Trigger({ name, children }: React.PropsWithChildren<{ name: string }>) {
    mockTriggers.push(name);
    return <View>{children}</View>;
  }
  Trigger.Label = ({ children }: React.PropsWithChildren) => <Text>{children}</Text>;
  Trigger.Icon = () => null;
  Trigger.Badge = ({ children }: React.PropsWithChildren) => (
    <Text testID="inbox-badge">{children}</Text>
  );
  NativeTabs.Trigger = Trigger;
  return { NativeTabs };
});

beforeEach(() => {
  mockCount = 3;
  mockSegment = 'bots';
  mockTriggers.length = 0;
  Object.assign(mockMobile, { ready: true, host: { id: 'host' }, client: {} });
});

describe('native tab navigation', () => {
  it('retains all destinations and the Inbox count without painting over system glass', () => {
    render(<TabsLayout />);
    expect(mockTriggers).toEqual(['bots', 'inbox', 'settings']);
    expect(screen.getByTestId('inbox-badge').props.children).toBe('3');
    expect(mockTabsProps.backgroundColor).toBeUndefined();
    expect(mockTabsProps.minimizeBehavior).toBe('never');
  });

  it('hides the badge when the Inbox is empty', () => {
    mockCount = 0;
    render(<TabsLayout />);
    expect(screen.queryByTestId('inbox-badge')).toBeNull();
  });

  it('keeps the pairing gate', () => {
    Object.assign(mockMobile, { host: null });
    render(<TabsLayout />);
    expect(screen.getByText('/(onboarding)/welcome')).toBeTruthy();
    expect(screen.queryByTestId('native-tabs')).toBeNull();
  });

  it('allows server management while disconnected', () => {
    Object.assign(mockMobile, { client: null });
    const view = render(<TabsLayout />);
    expect(screen.getByRole('button', { name: 'Manage servers' })).toBeTruthy();
    expect(screen.queryByTestId('native-tabs')).toBeNull();
    mockSegment = 'settings';
    view.rerender(<TabsLayout />);
    expect(screen.getByTestId('native-tabs')).toBeTruthy();
  });
});
