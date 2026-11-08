import React from 'react';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import { BotScreen, ChatScreen } from './conversation';

type HeaderOptions = {
  title: string;
  headerTransparent: boolean;
  headerStyle: { backgroundColor: string };
  scrollEdgeEffects: { top: string };
  unstable_headerRightItems: () => Array<{
    label: string;
    accessibilityLabel: string;
    icon: { type: string; name: string };
    onPress: () => void;
  }>;
};
let mockOptions: HeaderOptions;
let mockGlass = true;
let mockId = 'bot-1';
let mockGroup = false;
let mockMembersVisible = false;
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  Stack: {
    Screen: ({ options }: { options: HeaderOptions }) => {
      mockOptions = options;
      return null;
    },
  },
  router: { push: (...args: unknown[]) => mockPush(...args) },
  useLocalSearchParams: () => ({ id: mockId }),
}));
jest.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: { id: 'chat-1' } }) }));
jest.mock('@openbots/api-client', () => ({ unwrap: jest.fn() }));
jest.mock('../api/provider', () => ({ useApi: () => ({}) }));
jest.mock('../components/glass', () => ({ useGlassEnabled: () => mockGlass }));
jest.mock('../transcript/transcript', () => ({ Transcript: () => null }));
jest.mock('./group-members', () => ({
  GroupMembers: ({ visible }: { visible: boolean }) => {
    mockMembersVisible = visible;
    return null;
  },
}));
jest.mock('./data', () => ({
  useBots: () => ({ data: [{ id: 'bot-1', chatId: 'chat-1', name: 'My Bot' }] }),
  useChats: () => ({ data: mockGroup ? [{ id: 'group-1', type: 'group' }] : [] }),
  groupTitle: () => 'My group',
}));

beforeEach(() => {
  mockGlass = true;
  mockId = 'bot-1';
  mockGroup = false;
  mockPush.mockClear();
});

describe('conversation navigation', () => {
  it('uses an accessible native info symbol instead of Details text', () => {
    render(<BotScreen />);
    const coding = mockOptions.unstable_headerRightItems()[0]!;
    expect(coding.accessibilityLabel).toBe('Code');
    coding.onPress();
    expect(mockPush).toHaveBeenCalledWith('/bot/bot-1/coding');
    const button = mockOptions.unstable_headerRightItems()[1]!;
    expect(button.icon).toEqual({ type: 'sfSymbol', name: 'info.circle' });
    expect(button.accessibilityLabel).toBe('Bot details');
    button.onPress();
    expect(mockPush).toHaveBeenCalledWith('/bot/bot-1/details');
    expect(mockOptions.headerTransparent).toBe(true);
    expect(mockOptions.headerStyle.backgroundColor).toBe('transparent');
    expect(mockOptions.scrollEdgeEffects.top).toBe('soft');
  });

  it('keeps the header opaque when glass is unavailable or accessibility limits it', () => {
    mockGlass = false;
    render(<BotScreen />);
    expect(mockOptions.headerStyle.backgroundColor).toBe('#ffffff');
    expect(mockOptions.scrollEdgeEffects.top).toBe('hidden');
  });

  it('also exposes Bot details when entering from a chat link', () => {
    mockId = 'chat-1';
    render(<ChatScreen />);
    mockOptions.unstable_headerRightItems()[0]!.onPress();
    expect(mockPush).toHaveBeenCalledWith('/bot/bot-1/details');
  });

  it('preserves group membership via the native members control', () => {
    mockId = 'group-1';
    mockGroup = true;
    render(<ChatScreen />);
    const button = mockOptions.unstable_headerRightItems()[0]!;
    expect(button.accessibilityLabel).toBe('Group members');
    expect(mockMembersVisible).toBe(false);
    act(() => button.onPress());
    expect(mockMembersVisible).toBe(true);
  });
});
