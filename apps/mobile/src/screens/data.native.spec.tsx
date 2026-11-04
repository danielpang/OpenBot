import React, { type PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useBots, useChats } from './data';

const mockGet = jest.fn<(path: string) => Promise<{ items: { id: string }[] }>>();
const mockMobile = { client: { GET: mockGet }, transport: null as object | null };
jest.mock('../api/provider', () => ({ useMobile: () => mockMobile }));
jest.mock('@openbots/api-client', () => ({ unwrap: (promise: Promise<unknown>) => promise }));

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue({ items: [{ id: 'fresh' }] });
  mockMobile.transport = null;
});

describe('cached roster during reconnection', () => {
  it.each(['bots', 'chats'])(
    'retains cached %s and resumes background fetching when transport returns',
    async (key) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } },
      });
      client.setQueryData([key], { items: [{ id: 'cached' }] });
      const wrapper = ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const hook = key === 'bots' ? useBots : useChats;
      const view = renderHook(() => hook(), { wrapper });
      expect(view.result.current.data).toEqual([{ id: 'cached' }]);
      expect(view.result.current.isLoading).toBe(false);
      expect(mockGet).not.toHaveBeenCalled();
      mockMobile.transport = {};
      view.rerender({});
      await waitFor(() => expect(view.result.current.data).toEqual([{ id: 'fresh' }]));
      expect(mockGet).toHaveBeenCalledWith(`/api/v1/${key}`);
      mockMobile.transport = null;
      view.rerender({});
      expect(view.result.current.data).toEqual([{ id: 'fresh' }]);
      view.unmount();
      client.clear();
    },
  );
});
