import React from 'react';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { components } from '@openbots/api-client';
import { SessionApproval } from './approvals';

const mockPost = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('../api/provider', () => ({
  useApi: () => ({ POST: mockPost }),
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
beforeEach(() => {
  mockPost.mockReset().mockResolvedValue({ data: {} });
});
describe('session approval controls', () => {
  it.each([
    ['Approve', 'approve'],
    ['Decline', 'deny'],
  ])('sends %s to the existing approval endpoint', async (label, decision) => {
    const client = new QueryClient();
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
  });
});
