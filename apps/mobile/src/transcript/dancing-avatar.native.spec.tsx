import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AccessibilityInfo, ActivityIndicator } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { DancingBotAvatar } from './dancing-avatar';
import type { Bot } from '../screens/data';

jest.mock('../components/bot-avatar', () => ({ BotAvatar: () => null }));

const bot = { id: 'bot', name: 'Atlas', chatId: 'chat' } as unknown as Bot;
const reduceMotion = (enabled: boolean) =>
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(enabled);

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the loading dance', () => {
  it('names the Bot it is loading and dances without a spinner', async () => {
    reduceMotion(false);
    render(<DancingBotAvatar bot={bot} />);
    await act(async () => {});
    expect(screen.getByLabelText('Loading your conversation with Atlas')).toBeTruthy();
    expect(screen.UNSAFE_queryByType(ActivityIndicator)).toBeNull();
    screen.unmount();
  });

  it('stands still with a spinner when Reduce Motion is on', async () => {
    reduceMotion(true);
    render(<DancingBotAvatar bot={bot} />);
    await act(async () => {});
    expect(screen.UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
  });
});
