import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AccessibilityInfo, ActivityIndicator } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { DancingBots } from './dancing-avatar';
import type { Bot } from '../screens/data';

const mockAvatar = jest.fn((_props: { status?: boolean }) => null);
jest.mock('../components/bot-avatar', () => ({
  BotAvatar: (props: { status?: boolean }) => mockAvatar(props),
}));

const bot = { id: 'bot', name: 'Atlas', chatId: 'chat' } as unknown as Bot;
const reduceMotion = (enabled: boolean) =>
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(enabled);

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the loading dance', () => {
  it('names the Bot it is loading and dances without a spinner', async () => {
    reduceMotion(false);
    render(<DancingBots bots={[bot]} />);
    await act(async () => {});
    expect(screen.getByLabelText('Loading your conversation with Atlas')).toBeTruthy();
    // A loader is decoration: no working-state dot on the avatar.
    expect(mockAvatar).toHaveBeenCalledWith(expect.objectContaining({ status: false }));
    expect(screen.UNSAFE_queryByType(ActivityIndicator)).toBeNull();
    screen.unmount();
  });

  it('shows every Bot of a group and names them all', async () => {
    reduceMotion(false);
    const group = ['Atlas', 'Bea', 'Cy'].map(
      (name) => ({ id: name, name, chatId: `dm-${name}` }) as unknown as Bot,
    );
    render(<DancingBots bots={group} />);
    await act(async () => {});
    expect(screen.getAllByTestId('chat-loading-dancer')).toHaveLength(3);
    expect(screen.getByLabelText('Loading your conversation with Atlas, Bea and Cy')).toBeTruthy();
    screen.unmount();
  });

  it('shows at most six Bots of a bigger group', async () => {
    reduceMotion(false);
    const group = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(
      (name) => ({ id: name, name, chatId: `dm-${name}` }) as unknown as Bot,
    );
    render(<DancingBots bots={group} />);
    await act(async () => {});
    expect(screen.getAllByTestId('chat-loading-dancer')).toHaveLength(6);
    expect(
      screen.getByLabelText('Loading your conversation with A, B, C, D, E, F and 2 more'),
    ).toBeTruthy();
    screen.unmount();
  });

  it('stands still with a spinner when Reduce Motion is on', async () => {
    reduceMotion(true);
    render(<DancingBots bots={[bot]} />);
    await act(async () => {});
    expect(screen.UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
  });
});
