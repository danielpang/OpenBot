import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AccessibilityInfo } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { THINKING_PHRASE_MS, thinkingPhrase } from '@openbots/shared';
import { ThinkingLine } from './thinking-line';

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('the thinking line', () => {
  it('names the Bot once and moves to the next phrase every few seconds', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    jest.useFakeTimers();
    render(<ThinkingLine seed="m1" who="Chief of Staff" />);
    await act(async () => {});
    expect(screen.getByLabelText('Chief of Staff is replying')).toBeTruthy();
    expect(screen.getByText(thinkingPhrase('m1', 0))).toBeTruthy();
    act(() => jest.advanceTimersByTime(THINKING_PHRASE_MS));
    expect(screen.getByText(thinkingPhrase('m1', 1))).toBeTruthy();
    screen.unmount();
  });
});
