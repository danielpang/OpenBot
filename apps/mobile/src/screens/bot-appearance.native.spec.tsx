import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BotAppearance } from './bot-appearance';
import type { Bot } from './data';

const mockPatch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockMobile = { connected: true };
jest.mock('../api/provider', () => ({
  useApi: () => ({ PATCH: mockPatch }),
  useMobile: () => mockMobile,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../components/bot-avatar', () => ({ BotAvatar: () => null }));
const bot = {
  id: 'bot-1',
  name: 'Scout',
  avatar: { kind: 'generated', seed: 'scout', shape: 'bean', palette: 'mint' },
  state: { state: 'idle' },
} as Bot;
const close = jest.fn();
const caches: QueryClient[] = [];
afterEach(() => {
  caches.forEach((cache) => cache.clear());
  caches.length = 0;
});
function setup(value = bot) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  caches.push(cache);
  cache.setQueryData(['bots'], [value]);
  render(
    <QueryClientProvider client={cache}>
      <BotAppearance bot={value} bots={[value]} onClose={close} />
    </QueryClientProvider>,
  );
  return cache;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockMobile.connected = true;
  mockPatch.mockImplementation(async (_path, options) => ({
    data: { ...bot, avatar: (options as { body: { avatar: Bot['avatar'] } }).body.avatar },
    response: { ok: true },
  }));
});
describe('Bot appearance', () => {
  it('saves only the draft avatar and updates the cached roster after success', async () => {
    const cache = setup();
    expect(screen.getByRole('button', { name: 'Save appearance' })).toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: 'Shape: Box' }));
    fireEvent.press(screen.getByRole('button', { name: 'Colors: Coral' }));
    fireEvent.press(screen.getByRole('button', { name: 'Eyes: Visor' }));
    fireEvent.press(screen.getByRole('button', { name: 'Accessory: Hat' }));
    expect(mockPatch).not.toHaveBeenCalled();
    const avatar = {
      ...bot.avatar,
      shape: 'rounded',
      palette: 'coral',
      eyes: 'visor',
      accessory: 'hat',
    };
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Save appearance' })));
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/bots/{id}', {
      params: { path: { id: bot.id } },
      body: { avatar },
    });
    expect(cache.getQueryData<Bot[]>(['bots'])?.[0]?.avatar).toEqual(avatar);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('cancels without persisting draft changes', () => {
    const cache = setup();
    fireEvent.press(screen.getByRole('button', { name: 'Colors: Sky' }));
    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockPatch).not.toHaveBeenCalled();
    expect(cache.getQueryData(['bots'])).toEqual([bot]);
    expect(close).toHaveBeenCalled();
  });
  it('keeps the draft and allows retry after a failed save', async () => {
    mockPatch.mockRejectedValueOnce(new Error('Could not save avatar'));
    setup();
    fireEvent.press(screen.getByRole('button', { name: 'Colors: Sky' }));
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Save appearance' })));
    expect(screen.getByText('Could not save avatar')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Colors: Sky' }).props.accessibilityState.selected,
    ).toBe(true);
    expect(close).not.toHaveBeenCalled();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Save appearance' })));
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('keeps editing available offline but disables saving', () => {
    mockMobile.connected = false;
    setup();
    fireEvent.press(screen.getByRole('button', { name: 'Colors: Sky' }));
    expect(screen.getByRole('button', { name: 'Save appearance' })).toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: 'Save appearance' }));
    expect(mockPatch).not.toHaveBeenCalled();
  });
  it('disables editing and duplicate saves while a request is pending', async () => {
    let finish!: (value: unknown) => void;
    mockPatch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    setup();
    fireEvent.press(screen.getByRole('button', { name: 'Colors: Sky' }));
    fireEvent.press(screen.getByRole('button', { name: 'Save appearance' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Colors: Mint' })).toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: 'Save appearance' }));
    expect(mockPatch).toHaveBeenCalledTimes(1);
    await act(async () =>
      finish({
        data: { ...bot, avatar: { ...bot.avatar, palette: 'sky' } },
        response: { ok: true },
      }),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('preserves the selected shape when shuffling', () => {
    setup();
    fireEvent.press(screen.getByRole('button', { name: 'Shape: Egg' }));
    fireEvent.press(screen.getByRole('button', { name: 'Shuffle avatar' }));
    expect(
      screen.getByRole('button', { name: 'Shape: Egg' }).props.accessibilityState.selected,
    ).toBe(true);
  });
  it('preserves an uploaded avatar until explicitly switched to generated', () => {
    const uploaded = { ...bot, avatar: { kind: 'upload' as const, file_id: 'file-1' } };
    const cache = setup(uploaded);
    expect(screen.getByRole('button', { name: 'Save appearance' })).toBeDisabled();
    expect(screen.queryByText('Colors')).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Use a generated avatar' }));
    expect(screen.getByRole('button', { name: 'Colors: Mint' })).toBeTruthy();
    expect(cache.getQueryData(['bots'])).toEqual([uploaded]);
    expect(mockPatch).not.toHaveBeenCalled();
  });
});
