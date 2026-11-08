import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Transcript } from './transcript';

let mockKeyboardHeight = 0;
type ListProps = {
  onLoad?: () => void;
  onStartReached?: () => void;
  keyboardDismissMode?: string;
  keyboardShouldPersistTaps?: string;
  automaticallyAdjustKeyboardInsets?: boolean;
  contentInsetAdjustmentBehavior?: string;
  contentContainerStyle?: { paddingTop: number; paddingBottom: number };
  scrollIndicatorInsets?: { bottom: number };
  onScroll: (event: {
    nativeEvent: {
      contentOffset: { y: number };
      contentSize: { height: number };
      layoutMeasurement: { height: number };
    };
  }) => void;
};
let mockListProps: ListProps;
const mockScrollToEnd = jest.fn();
const mockScrollToIndex = jest.fn(() => Promise.resolve());
let mockScrollOffset = 0;
let mockLoading = false;
let mockHasMore = true;
const mockRefetch = jest.fn();
const mockLoadMore = jest.fn();
let mockMessages: { id: string; seq: number }[] = [];
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'View' },
  useAnimatedKeyboard: () => ({ height: { value: mockKeyboardHeight } }),
  useAnimatedStyle: (factory: () => unknown) => factory(),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 34 }) }));
jest.mock('@shopify/flash-list', () => {
  const actualReact = jest.requireActual<typeof React>('react');
  return {
    FlashList: actualReact.forwardRef<unknown, ListProps>((props, ref) => {
      mockListProps = props;
      actualReact.useImperativeHandle(ref, () => ({
        scrollToEnd: mockScrollToEnd,
        scrollToIndex: mockScrollToIndex,
        getAbsoluteLastScrollOffset: () => mockScrollOffset,
        getWindowSize: () => ({ width: 400, height: 800 }),
      }));
      return null;
    }),
  };
});
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@openbots/api-client', () => ({ unwrap: jest.fn() }));
jest.mock('../api/provider', () => ({ useApi: () => ({}) }));
jest.mock('../api/messages', () => ({
  useMessages: () => ({
    messages: mockMessages,
    loading: mockLoading,
    hasMore: mockHasMore,
    sending: false,
    refetch: mockRefetch,
    loadMore: mockLoadMore,
  }),
}));
jest.mock('../components/bot-avatar', () => ({ BotAvatar: () => null }));
jest.mock('./parts', () => ({ MessagePartView: () => null }));
jest.mock('./composer', () => ({ Composer: () => null }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

beforeEach(() => {
  mockKeyboardHeight = 0;
  mockMessages = [];
  mockScrollOffset = 0;
  mockLoading = false;
  mockHasMore = true;
  jest.clearAllMocks();
});

describe('chat keyboard and scrolling', () => {
  it('keeps the home-indicator inset when the keyboard is closed', () => {
    render(<Transcript chatId="chat" bots={[]} title="Bot" />);
    expect(
      StyleSheet.flatten(screen.getByTestId('chat-keyboard-frame').props.style).paddingBottom,
    ).toBe(34);
  });

  it('tracks keyboard height without adding a second safe-area gap', () => {
    mockKeyboardHeight = 320;
    const view = render(<Transcript chatId="chat" bots={[]} title="Bot" />);
    expect(
      StyleSheet.flatten(screen.getByTestId('chat-keyboard-frame').props.style).paddingBottom,
    ).toBe(320);
    mockKeyboardHeight = 150;
    view.rerender(<Transcript chatId="chat" bots={[]} title="Bot" />);
    expect(
      StyleSheet.flatten(screen.getByTestId('chat-keyboard-frame').props.style).paddingBottom,
    ).toBe(150);
  });

  it('enables interactive dismissal without double keyboard adjustment', () => {
    render(<Transcript chatId="chat" bots={[]} title="Bot" />);
    expect(mockListProps.keyboardDismissMode).toBe('interactive');
    expect(mockListProps.keyboardShouldPersistTaps).toBe('handled');
    expect(mockListProps.automaticallyAdjustKeyboardInsets).toBe(false);
  });

  it('lets messages scroll beneath the composer while reserving its measured height', () => {
    render(<Transcript chatId="chat" bots={[]} title="Bot" />);
    const overlay = screen.getByTestId('chat-composer-overlay');
    expect(overlay.props.pointerEvents).toBe('box-none');
    expect(StyleSheet.flatten(overlay.props.style)).toMatchObject({
      position: 'absolute',
      bottom: 0,
    });
    expect(mockListProps.contentInsetAdjustmentBehavior).toBe('automatic');
    fireEvent(overlay, 'layout', { nativeEvent: { layout: { height: 220 } } });
    expect(mockListProps.contentContainerStyle?.paddingBottom).toBe(228);
    expect(mockListProps.scrollIndicatorInsets?.bottom).toBe(220);
    // The keyboard inset is independent of multiline drafts and attachment menus.
    expect(
      StyleSheet.flatten(screen.getByTestId('chat-keyboard-frame').props.style).paddingBottom,
    ).toBe(34);
    act(() =>
      mockListProps.onScroll({
        nativeEvent: {
          contentOffset: { y: 100 },
          contentSize: { height: 2000 },
          layoutMeasurement: { height: 600 },
        },
      }),
    );
    expect(StyleSheet.flatten(screen.getByTestId('chat-jump-control').props.style).bottom).toBe(
      228,
    );
  });

  it('offers a jump-to-latest action only while reading older messages', () => {
    render(<Transcript chatId="chat" bots={[]} title="Bot" />);
    expect(screen.queryByRole('button', { name: 'Jump to latest message' })).toBeNull();
    act(() =>
      mockListProps.onScroll({
        nativeEvent: {
          contentOffset: { y: 100 },
          contentSize: { height: 2000 },
          layoutMeasurement: { height: 600 },
        },
      }),
    );
    fireEvent.press(screen.getByRole('button', { name: 'Jump to latest message' }));
    expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: true });
    act(() =>
      mockListProps.onScroll({
        nativeEvent: {
          contentOffset: { y: 1400 },
          contentSize: { height: 2000 },
          layoutMeasurement: { height: 600 },
        },
      }),
    );
    expect(screen.queryByRole('button', { name: 'Jump to latest message' })).toBeNull();
  });
});

describe('reopening a conversation', () => {
  const transcript = () => screen.getByTestId('chat-transcript', { includeHiddenElements: true });
  const opacity = () => StyleSheet.flatten(transcript().props.style).opacity;
  const settle = () => act(() => jest.advanceTimersByTime(100));
  // A jump to a linked message finishes asynchronously before the reveal frames.
  const load = async () => {
    await act(async () => {
      mockListProps.onLoad?.();
    });
    settle();
  };
  const scrollUp = () =>
    act(() =>
      mockListProps.onScroll({
        nativeEvent: {
          contentOffset: { y: 100 },
          contentSize: { height: 2000 },
          layoutMeasurement: { height: 600 },
        },
      }),
    );

  beforeEach(() => {
    jest.useFakeTimers();
    mockMessages = [
      { id: 'a', seq: 1 },
      { id: 'b', seq: 2 },
    ];
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('stays hidden and untouchable until it has settled on the latest message', () => {
    mockScrollOffset = 5000;
    render(<Transcript chatId="chat" bots={[]} title="Bot" />);
    expect(opacity()).toBe(0);
    expect(transcript().props.pointerEvents).toBe('none');
    expect(transcript().props.accessibilityElementsHidden).toBe(true);
    expect(transcript().props.importantForAccessibility).toBe('no-hide-descendants');
    // While hidden the list sits at the top; that must not page in older history.
    mockListProps.onStartReached?.();
    expect(mockLoadMore).not.toHaveBeenCalled();
    act(() => mockListProps.onLoad?.());
    expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(opacity()).toBe(0);
    settle();
    expect(opacity()).toBe(1);
    expect(transcript().props.pointerEvents).toBe('auto');
    expect(transcript().props.accessibilityElementsHidden).toBe(false);
    // Settled at the bottom, so nothing is paged in until the reader scrolls up.
    expect(mockLoadMore).not.toHaveBeenCalled();
    mockListProps.onStartReached?.();
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
  });

  it('pages in history skipped while hidden when it settles near the top', () => {
    mockScrollOffset = 0;
    render(<Transcript chatId="chat" bots={[]} title="Bot" />);
    mockListProps.onStartReached?.();
    act(() => mockListProps.onLoad?.());
    settle();
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
  });

  it('never leaves the transcript blank if the list does not report its layout', () => {
    render(<Transcript chatId="chat" bots={[]} title="Bot" />);
    expect(opacity()).toBe(0);
    act(() => jest.advanceTimersByTime(1000));
    expect(opacity()).toBe(1);
  });

  it('shows an empty conversation immediately and its first message without a blink', () => {
    mockMessages = [];
    const view = render(<Transcript chatId="chat" bots={[]} title="Bot" />);
    expect(opacity()).toBe(1);
    mockMessages = [{ id: 'a', seq: 1 }];
    view.rerender(<Transcript chatId="chat" bots={[]} title="Bot" />);
    expect(opacity()).toBe(1);
  });

  it('stays hidden while an uncached conversation is still loading', () => {
    mockMessages = [];
    mockLoading = true;
    const view = render(<Transcript chatId="chat" bots={[]} title="Bot" />);
    mockMessages = [{ id: 'a', seq: 1 }];
    view.rerender(<Transcript chatId="chat" bots={[]} title="Bot" />);
    expect(opacity()).toBe(0);
  });

  it('reveals a linked message after jumping to it, not at the bottom', async () => {
    render(<Transcript chatId="chat" bots={[]} title="Bot" targetSeq={1} />);
    expect(opacity()).toBe(0);
    await load();
    expect(mockScrollToEnd).not.toHaveBeenCalled();
    expect(mockScrollToIndex).toHaveBeenCalledWith({
      index: 0,
      viewPosition: 0.5,
      animated: false,
    });
    expect(opacity()).toBe(1);
  });

  it('opens a saved linked message without waiting for the server', async () => {
    mockLoading = true;
    render(<Transcript chatId="chat" bots={[]} title="Bot" targetSeq={2} />);
    await load();
    expect(mockScrollToIndex).toHaveBeenCalledWith({
      index: 1,
      viewPosition: 0.5,
      animated: false,
    });
    expect(opacity()).toBe(1);
  });

  it('waits for the server while a linked message is not saved on the phone', async () => {
    mockLoading = true;
    render(<Transcript chatId="chat" bots={[]} title="Bot" targetSeq={9} />);
    await load();
    expect(mockScrollToIndex).not.toHaveBeenCalled();
    expect(mockLoadMore).not.toHaveBeenCalled();
    expect(opacity()).toBe(0);
  });

  it('reveals the conversation when a linked message cannot be found', () => {
    mockHasMore = false;
    render(<Transcript chatId="chat" bots={[]} title="Bot" targetMessageId="missing" />);
    expect(opacity()).toBe(0);
    settle();
    expect(mockScrollToIndex).not.toHaveBeenCalled();
    expect(opacity()).toBe(1);
  });

  it('starts each conversation fresh when the screen switches chats in place', async () => {
    const view = render(<Transcript chatId="a" bots={[]} title="Bot" targetSeq={2} />);
    await load();
    expect(mockScrollToIndex).toHaveBeenCalledTimes(1);
    scrollUp();
    expect(screen.getByRole('button', { name: 'Jump to latest message' })).toBeTruthy();
    // Same message number in another chat: it hides again and jumps again.
    view.rerender(<Transcript chatId="b" bots={[]} title="Bot" targetSeq={2} />);
    expect(opacity()).toBe(0);
    expect(screen.queryByRole('button', { name: 'Jump to latest message' })).toBeNull();
    await load();
    expect(mockScrollToIndex).toHaveBeenCalledTimes(2);
    expect(opacity()).toBe(1);
    expect(screen.queryByRole('button', { name: 'Jump to latest message' })).toBeNull();
  });
});
