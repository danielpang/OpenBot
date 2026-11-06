import React from 'react';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { RefreshControl } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { BotsScreen } from './bots';

const mockPush = jest.fn();
const mockNavigate = jest.fn();
const mockRefresh = jest.fn();
const mockRefetch = jest.fn<() => Promise<unknown>>();
const mockMobile = {
  host: { name: 'My Mac' },
  connected: false,
  connecting: true,
  transport: null as object | null,
  refresh: mockRefresh,
};
const cachedBots = [
  {
    id: 'bot-1',
    name: 'Chief of Staff',
    handle: 'chief',
    pinned: true,
    hidden: false,
    state: { currentAction: null },
  },
];
const mockBots = {
  data: cachedBots as typeof cachedBots | undefined,
  isRefetching: true,
  isLoading: false,
  error: new Error('Disconnected'),
  refetch: mockRefetch,
};
jest.mock('expo-router', () => ({
  router: {
    push: (...args: unknown[]) => mockPush(...args),
    navigate: (...args: unknown[]) => mockNavigate(...args),
  },
}));
jest.mock('@openbots/api-client', () => ({ unwrap: jest.fn() }));
jest.mock('@openbots/avatars', () => ({ generate: () => '<svg/>', newBotAvatar: () => ({}) }));
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
jest.mock('../api/provider', () => ({ useMobile: () => mockMobile, useApi: () => ({}) }));
jest.mock('../components/bot-avatar', () => ({ BotAvatar: () => null }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('./data', () => ({
  useBots: () => mockBots,
  useChats: () => ({ data: [], refetch: mockRefetch }),
  groupTitle: () => '',
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockRefetch.mockResolvedValue(undefined);
  Object.assign(mockMobile, { connected: false, connecting: true, transport: null });
  Object.assign(mockBots, { data: cachedBots, isRefetching: true, isLoading: false });
});

describe('background reconnection on the Bots home screen', () => {
  it('reuses the roster as an iPad sidebar with selected rows and conversation navigation', () => {
    render(<BotsScreen sidebar selected={{ kind: 'bot', id: 'bot-1' }} />);
    const bot = screen.getByRole('button', { name: 'Open Chief of Staff' });
    expect(bot.props.accessibilityState.selected).toBe(true);
    fireEvent.press(bot);
    expect(mockNavigate).toHaveBeenCalledWith('/bot/bot-1');
    expect(mockPush).not.toHaveBeenCalled();
  });
  it('keeps cached Bots tappable without showing a refresh spinner or transient error', () => {
    render(<BotsScreen />);
    expect(screen.getByText('OpenBots')).toBeTruthy();
    expect(screen.getByLabelText('Disconnected from server').props.style.backgroundColor).toBe(
      '#dc2626',
    );
    expect(screen.getByText(/Reconnecting/)).toBeTruthy();
    expect(screen.queryByText('Disconnected')).toBeNull();
    expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
    fireEvent.press(screen.getByRole('button', { name: 'Open Chief of Staff' }));
    expect(mockPush).toHaveBeenCalledWith('/bot/bot-1');
    fireEvent.changeText(screen.getByLabelText('Search Bots and groups'), 'Chief');
    expect(screen.getByRole('button', { name: 'Open Chief of Staff' })).toBeTruthy();
  });

  it('does not show a pull-to-refresh spinner for a connected background resync', () => {
    Object.assign(mockMobile, { connected: true, transport: {} });
    render(<BotsScreen />);
    expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
  });

  it('shows a green connection dot when connected', () => {
    Object.assign(mockMobile, { connected: true, connecting: false, transport: {} });
    render(<BotsScreen />);
    expect(screen.getByLabelText('Connected to server').props.style.backgroundColor).toBe(
      '#169449',
    );
    expect(screen.getByText('My Mac · Connected')).toBeTruthy();
  });

  it('shows a red dot and disconnected text when not reconnecting', () => {
    mockMobile.connecting = false;
    render(<BotsScreen />);
    expect(screen.getByLabelText('Disconnected from server').props.style.backgroundColor).toBe(
      '#dc2626',
    );
    expect(screen.getByText('My Mac · Disconnected')).toBeTruthy();
  });

  it('only shows the spinner for a user-initiated refresh and clears it afterward', async () => {
    Object.assign(mockMobile, { connected: true, transport: {} });
    let finish!: () => void;
    // Both requests share a controllable promise.
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mockRefetch.mockReturnValue(pending);
    render(<BotsScreen />);
    act(() => screen.UNSAFE_getByType(RefreshControl).props.onRefresh());
    expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true);
    await act(async () => {
      finish();
      await pending;
    });
    expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
  });

  it('requests reconnect without a blocking spinner if pulled while transport is absent', () => {
    render(<BotsScreen />);
    act(() => screen.UNSAFE_getByType(RefreshControl).props.onRefresh());
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefetch).not.toHaveBeenCalled();
    expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
  });

  it('does not mistake an uncached reconnect for an empty account', () => {
    mockBots.data = undefined;
    render(<BotsScreen />);
    expect(screen.queryByText('Meet your first Bot')).toBeNull();
    expect(screen.getByLabelText('Search Bots and groups')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create a Bot or group' })).toBeTruthy();
  });
});
