import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Transcript } from './transcript';

let mockKeyboardHeight = 0;
type ListProps = {
  style?: { opacity: number };
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
      actualReact.useImperativeHandle(ref, () => ({ scrollToEnd: mockScrollToEnd }));
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
    loading: false,
    hasMore: true,
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

  it('stays hidden until it has settled on the latest message', () => {
    render(<Transcript chatId="chat" bots={[]} title="Bot" />);
    expect(mockListProps.style?.opacity).toBe(0);
    // While hidden the list sits at the top; that must not page in older history.
    mockListProps.onStartReached?.();
    expect(mockLoadMore).not.toHaveBeenCalled();
    act(() => mockListProps.onLoad?.());
    expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(mockListProps.style?.opacity).toBe(0);
    act(() => jest.advanceTimersByTime(100));
    expect(mockListProps.style?.opacity).toBe(1);
    mockListProps.onStartReached?.();
    expect(mockLoadMore).toHaveBeenCalled();
  });

  it('never leaves the transcript blank if the list does not report its layout', () => {
    render(<Transcript chatId="chat" bots={[]} title="Bot" />);
    expect(mockListProps.style?.opacity).toBe(0);
    act(() => jest.advanceTimersByTime(1000));
    expect(mockListProps.style?.opacity).toBe(1);
  });

  it('shows an empty conversation immediately', () => {
    mockMessages = [];
    render(<Transcript chatId="chat" bots={[]} title="Bot" />);
    expect(mockListProps.style?.opacity).toBe(1);
  });
});
