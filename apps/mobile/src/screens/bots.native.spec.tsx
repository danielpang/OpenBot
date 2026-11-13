import React from 'react';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ScrollView } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { BotsScreen } from './bots';

const mockPush = jest.fn();
const mockNavigate = jest.fn();
const mockRefresh = jest.fn();
const mockRefetch = jest.fn<() => Promise<unknown>>();
let mockGroupLimit = 6;
const mockMobile = {
  host: { name: 'My Mac' },
  connected: false,
  connecting: true,
  connectionFailed: false,
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
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, left: 0, right: 0, bottom: 34 }),
}));
let mockOffice: { visible: boolean; onOpenBot: (id: string) => void } | undefined;
jest.mock('../office/office-sheet', () => ({
  OfficeSheet: (props: { visible: boolean; onOpenBot: (id: string) => void }) => {
    mockOffice = props;
    return null;
  },
}));
jest.mock('@openbots/api-client', () => ({ unwrap: jest.fn() }));
jest.mock('@openbots/avatars', () => ({
  generate: () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"/>' }),
  newBotAvatar: () => ({}),
}));
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
jest.mock('../api/provider', () => ({ useMobile: () => mockMobile, useApi: () => ({}) }));
jest.mock('../components/bot-avatar', () => ({ BotAvatar: () => null }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('./data', () => ({
  useBots: () => mockBots,
  useChats: () => ({ data: [], refetch: mockRefetch }),
  groupTitle: () => '',
  useGroupLimit: () => mockGroupLimit,
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockRefetch.mockResolvedValue(undefined);
  Object.assign(mockMobile, {
    connected: false,
    connecting: true,
    connectionFailed: false,
    transport: null,
  });
  Object.assign(mockBots, { data: cachedBots, isRefetching: true, isLoading: false });
});

// iOS measures pulls itself: the list rests at -59 here, below the safe area.
const REST = -59;
function scrollTo(event: string, y: number) {
  fireEvent(screen.UNSAFE_getByType(ScrollView), event, {
    nativeEvent: { contentOffset: { x: 0, y }, velocity: { x: 0, y: 0 } },
  });
}
function pullAndRelease(pulled: number) {
  scrollTo('scrollBeginDrag', REST);
  scrollTo('scroll', REST - pulled);
  scrollTo('scrollEndDrag', REST - pulled);
}
const spinner = () => screen.queryByLabelText('Refreshing');

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
    expect(screen.getByLabelText('Server')).toBeTruthy();
    expect(screen.getByText('My Mac')).toBeTruthy();
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
    expect(screen.queryByLabelText('Disconnected from server')).toBeNull();
    expect(screen.queryByText('Disconnected')).toBeNull();
    expect(spinner()).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Open Chief of Staff' }));
    expect(mockPush).toHaveBeenCalledWith('/bot/bot-1');
    pullAndRelease(60);
    fireEvent.changeText(screen.getByLabelText('Search Bots and groups'), 'Chief');
    expect(screen.getByRole('button', { name: 'Open Chief of Staff' })).toBeTruthy();
  });

  it('does not show a pull-to-refresh spinner for a connected background resync', () => {
    Object.assign(mockMobile, { connected: true, transport: {} });
    render(<BotsScreen />);
    expect(spinner()).toBeNull();
  });

  it('shows a green connection dot when connected', () => {
    Object.assign(mockMobile, { connected: true, connecting: false, transport: {} });
    render(<BotsScreen />);
    expect(screen.getByLabelText('Connected to server').props.style.backgroundColor).toBe(
      '#169449',
    );
    expect(screen.getByText('My Mac · Connected')).toBeTruthy();
  });

  it('shows a red dot and disconnected text only after repeated failures', () => {
    mockMobile.connectionFailed = true;
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
    pullAndRelease(140);
    expect(spinner()).toBeTruthy();
    await act(async () => {
      finish();
      await pending;
    });
    expect(spinner()).toBeNull();
  });

  it('requests reconnect without a blocking spinner if pulled while transport is absent', () => {
    render(<BotsScreen />);
    pullAndRelease(140);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefetch).not.toHaveBeenCalled();
    expect(spinner()).toBeNull();
  });

  it('does not mistake an uncached reconnect for an empty account', () => {
    mockBots.data = undefined;
    render(<BotsScreen />);
    expect(screen.queryByText('Meet your first Bot')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create a Bot or group' })).toBeTruthy();
  });
});

describe('server line under the title', () => {
  it('does not repeat OpenBots under the OpenBots title', () => {
    Object.assign(mockMobile, { connected: true, host: { name: 'OpenBots' } });
    render(<BotsScreen />);
    expect(screen.getAllByText(/OpenBots/)).toHaveLength(1);
    expect(screen.getByText('Connected')).toBeTruthy();
    mockMobile.host = { name: 'My Mac' };
  });
});

describe('pull down to search on iOS', () => {
  const search = () => screen.queryByLabelText('Search Bots and groups');

  it('opens search with the keyboard after a short pull, without refreshing', () => {
    Object.assign(mockMobile, { connected: true, transport: {} });
    render(<BotsScreen />);
    expect(search()).toBeNull();
    pullAndRelease(20);
    expect(search()).toBeNull();
    scrollTo('scrollBeginDrag', REST);
    scrollTo('scroll', REST - 60);
    expect(screen.getByText('Release to search')).toBeTruthy();
    scrollTo('scrollEndDrag', REST - 60);
    expect(search()).toBeTruthy();
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  it('covers the list until something is typed, and closes search when the cover is tapped', () => {
    render(<BotsScreen />);
    pullAndRelease(60);
    expect(screen.getByLabelText('Close search')).toBeTruthy();
    fireEvent.changeText(search()!, 'chief');
    expect(screen.queryByLabelText('Close search')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Chief of Staff' })).toBeTruthy();
    fireEvent.changeText(search()!, '');
    fireEvent.press(screen.getByLabelText('Close search'));
    fireEvent(search()!, 'blur');
    expect(search()).toBeNull();
  });

  it('refreshes on a longer pull without opening search, even if eased back', () => {
    Object.assign(mockMobile, { connected: true, transport: {} });
    render(<BotsScreen />);
    scrollTo('scrollBeginDrag', REST);
    scrollTo('scroll', REST - 130);
    expect(screen.getByLabelText('Release to refresh')).toBeTruthy();
    scrollTo('scroll', REST - 60);
    scrollTo('scrollEndDrag', REST - 60);
    expect(mockRefetch).toHaveBeenCalled();
    expect(search()).toBeNull();
  });

  it('ignores a pull that did not start at the top', () => {
    render(<BotsScreen />);
    pullAndRelease(0);
    scrollTo('scrollBeginDrag', REST + 300);
    scrollTo('scroll', REST + 200);
    scrollTo('scrollEndDrag', REST + 200);
    expect(search()).toBeNull();
  });

  it('puts search away when dismissed empty, and keeps a typed search', () => {
    render(<BotsScreen />);
    pullAndRelease(60);
    fireEvent(search()!, 'blur');
    expect(search()).toBeNull();
    pullAndRelease(60);
    fireEvent.changeText(search()!, 'chief');
    fireEvent(search()!, 'blur');
    expect(search()).toBeTruthy();
  });
});

describe('the office past the end of the list on iOS', () => {
  // A list 1000 tall in a 700 tall view, which settles at 383 with the tab bar below it.
  const at = (event: string, y: number, target?: number) =>
    fireEvent(screen.UNSAFE_getByType(ScrollView), event, {
      nativeEvent: {
        contentOffset: { x: 0, y },
        contentSize: { width: 393, height: 1000 },
        layoutMeasurement: { width: 393, height: 700 },
        velocity: { x: 0, y: 0 },
        ...(target === undefined ? {} : { targetContentOffset: { x: 0, y: target } }),
      },
    });

  it('opens on a long pull past the end, and a tapped Bot opens its chat', () => {
    render(<BotsScreen />);
    at('scrollBeginDrag', REST);
    at('scrollEndDrag', REST);
    at('scrollBeginDrag', 383);
    at('scroll', 383 + 130);
    expect(screen.getByText('Release to visit the office')).toBeTruthy();
    at('scrollEndDrag', 383 + 130, 383);
    expect(mockOffice?.visible).toBe(true);
    act(() => mockOffice!.onOpenBot('bot-1'));
    expect(mockOffice?.visible).toBe(false);
    expect(mockPush).toHaveBeenCalledWith('/bot/bot-1');
  });

  it('stays closed for a short bounce at the end or an ordinary scroll', () => {
    render(<BotsScreen />);
    at('scrollBeginDrag', 383);
    at('scrollEndDrag', 383 + 60, 383);
    at('scrollBeginDrag', 100);
    at('scrollEndDrag', 200, 600);
    expect(mockOffice?.visible).toBe(false);
  });
});

describe('starting a group within the server limit', () => {
  it('lets no more Bots be chosen than the server allows', () => {
    mockGroupLimit = 2;
    const roster = ['a', 'b', 'c'].map((id) => ({
      id,
      name: `Bot ${id}`,
      handle: id,
      pinned: false,
      hidden: false,
      state: { currentAction: null },
    }));
    Object.assign(mockBots, { data: roster });
    render(<BotsScreen />);
    fireEvent.press(screen.getByLabelText('Create a Bot or group'));
    fireEvent.press(screen.getByRole('button', { name: 'Group' }));
    expect(screen.getByText('Choose 2 to 2 Bots.')).toBeTruthy();
    const boxes = screen.getAllByRole('checkbox');
    for (const box of boxes) fireEvent.press(box);
    expect(
      screen.getAllByRole('checkbox').filter((box) => box.props.accessibilityState.checked),
    ).toHaveLength(2);
    mockGroupLimit = 6;
  });
});
