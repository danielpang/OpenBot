import React from 'react';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Transcript } from './transcript';

let mockKeyboardHeight = 0;
type ListProps = {
  keyboardDismissMode?: string;
  keyboardShouldPersistTaps?: string;
  automaticallyAdjustKeyboardInsets?: boolean;
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
    messages: [],
    loading: false,
    hasMore: false,
    sending: false,
    refetch: mockRefetch,
  }),
}));
jest.mock('../components/bot-avatar', () => ({ BotAvatar: () => null }));
jest.mock('./parts', () => ({ MessagePartView: () => null }));
jest.mock('./composer', () => ({ Composer: () => null }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

beforeEach(() => {
  mockKeyboardHeight = 0;
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
