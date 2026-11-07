import React from 'react';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { NativeWidget } from './widget';

const mockPost = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockInvalidate = jest.fn<(...args: unknown[]) => Promise<void>>();
jest.mock('../api/provider', () => ({ useApi: () => ({ POST: mockPost }) }));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

beforeEach(() => {
  mockPost
    .mockReset()
    .mockResolvedValue({ data: { widget: { status: 'answered' } }, response: { ok: true } });
  mockInvalidate.mockReset().mockResolvedValue(undefined);
});
describe('native owner-input widgets', () => {
  it('sends the selected option through the widget action route and refreshes the inbox', async () => {
    const updated = jest.fn();
    render(
      <NativeWidget
        messageId="message-1"
        index={2}
        part={{
          type: 'widget',
          kind: 'question',
          props: {
            question: 'Which environment?',
            options: [
              { id: 'staging', label: 'Staging' },
              { id: 'prod', label: 'Production' },
            ],
            allow_text: false,
          },
          state: { status: 'pending' },
        }}
        onUpdated={updated}
      />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Staging' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/v1/messages/{id}/widgets/{part}/action', {
        params: { path: { id: 'message-1', part: 2 } },
        body: { action: { type: 'answer', option_id: 'staging' } },
      }),
    );
    await waitFor(() => expect(updated).toHaveBeenCalled());
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['inbox'] });
    expect(screen.queryByLabelText('Your answer')).toBeNull();
  });
  it('renders a resolved answer without actionable controls', () => {
    render(
      <NativeWidget
        messageId="message-1"
        index={0}
        part={{
          type: 'widget',
          kind: 'question',
          props: { question: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] },
          state: { status: 'answered', answer: { label: 'Yes' } },
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull();
    expect(screen.getByText('Answered: Yes')).toBeTruthy();
    expect(mockPost).not.toHaveBeenCalled();
  });
  it('shows a rejected approval error and preserves the actionable request', async () => {
    mockPost.mockRejectedValueOnce(new Error('Connection lost'));
    render(
      <NativeWidget
        messageId="approval-message"
        index={0}
        part={{
          type: 'widget',
          kind: 'approval',
          props: {
            tool_name: 'send_email',
            args: { to: 'team@example.com' },
            summary: 'Send the report',
            reason: 'External action',
          },
          state: { status: 'pending' },
        }}
      />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText('Connection lost')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Approve' }).props.accessibilityState.disabled).toBe(
      false,
    );
  });
  it('never offers actions for unknown widget kinds', () => {
    render(
      <NativeWidget
        messageId="message-1"
        index={0}
        part={{ type: 'widget', kind: 'future_kind', props: { title: 'A new widget' } }}
      />,
    );
    expect(screen.getByText('This widget is available on your computer.')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
