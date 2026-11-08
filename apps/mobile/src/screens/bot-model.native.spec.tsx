import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BotModel } from './bot-model';
import type { Bot } from './data';
import { botsQueryOptions } from '../api/bots';

const mockGet = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPatch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockMobile = { connected: true };
jest.mock('../api/provider', () => ({
  useApi: () => ({ GET: mockGet, PATCH: mockPatch }),
  useMobile: () => mockMobile,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
const bot = {
  id: 'bot-1',
  name: 'Scout',
  modelConfig: {
    provider_id: 'old-provider',
    model_id: 'old-model',
    reasoning: 'high',
    temperature: 0.4,
  },
} as Bot;
const model = {
  id: 'model-1',
  modelId: 'claude-new',
  displayName: 'Claude New',
  enabled: true,
  capabilities: { tools: true, vision: true, reasoning: true, context_window: 200000 },
};
const group = {
  provider: { id: 'provider-1', name: 'Anthropic', kind: 'anthropic', protocol: 'native' },
  models: [model],
};
const ok = (data: unknown) => ({ data, response: { ok: true } });
const caches: QueryClient[] = [];
let groups: unknown[];
let fresh: Bot;
beforeEach(() => {
  jest.clearAllMocks();
  mockMobile.connected = true;
  groups = [group];
  fresh = bot;
  mockGet.mockImplementation(async (path) => ok(path === '/api/v1/models' ? { groups } : fresh));
  mockPatch.mockImplementation(async (_path, options) =>
    ok({
      ...bot,
      modelConfig: (options as { body: { modelConfig: Bot['modelConfig'] } }).body.modelConfig,
    }),
  );
});
afterEach(() => {
  cleanup();
  caches.forEach((cache) => cache.clear());
  caches.length = 0;
});
function setup() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  caches.push(cache);
  cache.setQueryData(botsQueryOptions(null).queryKey, { items: [bot, { ...bot, id: 'other' }] });
  render(
    <QueryClientProvider client={cache}>
      <BotModel bot={bot} />
    </QueryClientProvider>,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Change model' }));
  return cache;
}
const choice = () => screen.getByRole('button', { name: 'Use Claude New from Anthropic' });
async function ready() {
  await waitFor(() => expect(choice()).toBeTruthy());
}

describe('Bot model picker', () => {
  it('loads compatible models for the Bot and saves with the new reasoning default', async () => {
    fresh = { ...bot, modelConfig: { ...bot.modelConfig!, temperature: 0.7 } };
    const cache = setup();
    await ready();
    expect(mockGet).toHaveBeenCalledWith('/api/v1/models', {
      params: { query: { needs: 'tools', botId: bot.id } },
    });
    await act(async () => fireEvent.press(choice()));
    const modelConfig = {
      provider_id: 'provider-1',
      model_id: 'claude-new',
      reasoning: true,
      temperature: 0.7,
    };
    expect(mockPatch).toHaveBeenCalledWith('/api/v1/bots/{id}', {
      params: { path: { id: bot.id } },
      body: { modelConfig },
    });
    expect(cache.getQueryData(botsQueryOptions(null).queryKey)?.items).toEqual([
      { ...bot, modelConfig },
      { ...bot, id: 'other' },
    ]);
    expect(screen.getByRole('button', { name: 'Change model' })).toBeTruthy();
  });
  it('clears the old reasoning setting for models without a reasoning default', async () => {
    groups = [{ ...group, provider: { ...group.provider, kind: 'openai' } }];
    setup();
    await ready();
    await act(async () => fireEvent.press(choice()));
    expect(mockPatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: {
          modelConfig: { provider_id: 'provider-1', model_id: 'claude-new', temperature: 0.4 },
        },
      }),
    );
  });
  it('hides disabled and incompatible models and reports an empty list', async () => {
    groups = [
      {
        ...group,
        models: [
          { ...model, enabled: false },
          { ...model, id: 'no-tools', capabilities: { ...model.capabilities, tools: false } },
        ],
      },
    ];
    setup();
    await waitFor(() => expect(screen.getByText(/No compatible models available/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Use Claude New from Anthropic' })).toBeNull();
  });
  it('keeps the old model after failure and allows retry', async () => {
    mockPatch.mockRejectedValueOnce(new Error('Could not save model'));
    const cache = setup();
    await ready();
    await act(async () => fireEvent.press(choice()));
    expect(screen.getByText('Could not save model')).toBeTruthy();
    expect(cache.getQueryData(botsQueryOptions(null).queryKey)?.items[0]?.modelConfig).toEqual(
      bot.modelConfig,
    );
    await act(async () => fireEvent.press(choice()));
    expect(mockPatch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Change model' })).toBeTruthy();
  });
  it('does not fetch or save while disconnected', () => {
    mockMobile.connected = false;
    setup();
    expect(screen.getByText('Reconnect to change the model.')).toBeTruthy();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
  });
  it('disables choices and cancellation while saving to prevent duplicate requests', async () => {
    let finish!: (value: unknown) => void;
    mockPatch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    setup();
    await ready();
    fireEvent.press(choice());
    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
    expect(choice()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.press(choice());
    expect(mockPatch).toHaveBeenCalledTimes(1);
    await act(async () => finish(ok(bot)));
  });
  it('offers retry when loading models fails and cancellation never saves', async () => {
    mockGet.mockRejectedValueOnce(new Error('Could not load models'));
    setup();
    await waitFor(() => expect(screen.getByText('Could not load models')).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await ready();
    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockPatch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Change model' })).toBeTruthy();
  });
});
