import React from 'react';
import { ScrollView } from 'react-native';
import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { components } from '@openbots/api-client';
import { SessionApproval, SessionApprovals } from './approvals';

const mockPost = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGet = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('../api/provider', () => ({
  useApi: () => ({ POST: mockPost, GET: mockGet }),
  useMobile: () => ({ connected: true }),
}));
jest.mock('../components/accept-edits', () => ({ AcceptEdits: () => null }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
const approval = {
  id: 'a1',
  botId: 'b1',
  sessionId: 's1',
  status: 'pending',
  reason: 'Create pull request',
  summary: 'team/app · Fix reconnect',
  toolName: 'codex_apps.create_pull_request',
} as components['schemas']['PendingApproval'];
const clients: QueryClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  jest.restoreAllMocks();
});
beforeEach(() => {
  mockPost.mockReset().mockResolvedValue({ data: {}, response: { ok: true } });
  mockGet.mockReset().mockResolvedValue({ data: { items: [approval] }, response: { ok: true } });
});
describe('session approval controls', () => {
  it('lets approval text wrap without a fixed-height nested scroll view', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    clients.push(client);
    render(
      <QueryClientProvider client={client}>
        <SessionApprovals sessionId="s1" />
      </QueryClientProvider>,
    );
    await screen.findByText('Create pull request');
    expect(screen.UNSAFE_queryByType(ScrollView)).toBeNull();
    expect(screen.getByTestId('session-approvals').props.style.maxHeight).toBeUndefined();
    expect(screen.getByText('Create pull request').props.numberOfLines).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });
  it.each([
    ['Approve', 'approve'],
    ['Decline', 'deny'],
  ])('sends %s to the existing approval endpoint', async (label, decision) => {
    const client = new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity } } });
    clients.push(client);
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    render(
      <QueryClientProvider client={client}>
        <SessionApproval approval={approval} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Create pull request')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: label }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/v1/approvals/{id}/decide', {
        params: { path: { id: 'a1' } },
        body: { decision },
      }),
    );
    await waitFor(() => {
      for (const key of ['approvals', 'coding-sessions', 'inbox', 'messages']) {
        expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] });
      }
    });
  });
});
