import React from 'react';
import { Alert } from 'react-native';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CodingSessionScreen, CodingSessionsScreen, Entry } from './screens';

const mockGet = jest.fn<(path: string, ...args: unknown[]) => Promise<unknown>>();
const mockPost = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPush = jest.fn();
const mockApi = { GET: mockGet, POST: mockPost };
jest.mock('../api/provider', () => ({
  useApi: () => mockApi,
  useMobile: () => ({ connected: true }),
}));
jest.mock('../screens/data', () => ({
  useBots: () => ({ data: [{ id: 'bot1', name: 'Builder', toolPolicy: {} }] }),
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { push: (path: string) => mockPush(path) },
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('./agent-orb', () => ({ AgentOrb: () => null }));
const session = {
  id: 's1',
  botId: 'bot1',
  title: 'Fix reconnect',
  agent: 'pi',
  status: 'settled',
  repoFullName: 'team/app',
  branch: 'fix',
};
function mount(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}
beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockPush.mockReset();
  mockPost.mockReset().mockResolvedValue({ data: { session: { ...session, status: 'queued' } } });
  mockGet.mockReset().mockImplementation(async (path: string) => ({
    data: path.endsWith('/approvals')
      ? { items: [] }
      : path.endsWith('/events')
        ? { entries: [], hasMore: false }
        : path.endsWith('coding-sessions')
          ? { sessions: [session] }
          : { session },
  }));
});
describe('coding conversations', () => {
  it('expands and collapses command details', () => {
    render(
      <Entry
        agent="pi"
        entry={{
          seq: 1,
          turn: 1,
          at: '2026-01-01',
          event: { type: 'command', command: 'grep -R reconnect src', exit_code: 0 },
        }}
      />,
    );
    expect(screen.queryByText(/grep -R/)).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Expand bash' }));
    expect(screen.getByText(/grep -R reconnect src/)).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Collapse bash' }));
    expect(screen.queryByText(/grep -R/)).toBeNull();
  });
  it('opens a session from the list', async () => {
    mount(<CodingSessionsScreen botId="bot1" />);
    const sessionButton = await screen.findByRole('button', { name: 'Open Fix reconnect' });
    expect(screen.getByText('team/app')).toBeTruthy();
    expect(screen.queryByText('Builder · pi')).toBeNull();
    expect(screen.queryByText('team/app · fix')).toBeNull();
    expect(screen.queryByText('Done')).toBeNull();
    fireEvent.press(sessionButton);
    expect(mockPush).toHaveBeenCalledWith('/coding-session/s1');
  });
  it('shows edit modes only while composing, in an in-app popup', async () => {
    mount(<CodingSessionScreen id="s1" />);
    const input = await screen.findByLabelText('Message');
    expect(screen.queryByTestId('code-edit-mode')).toBeNull();
    fireEvent(input, 'focus');
    const mode = screen.getByRole('button', { name: 'Edit mode: Ask before edits' });
    expect(screen.queryByRole('button', { name: 'Accept edits' })).toBeNull();
    fireEvent.press(mode);
    expect(screen.getByRole('button', { name: 'Accept edits' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask before edits' })).toBeTruthy();
    fireEvent.press(mode);
    expect(screen.queryByRole('button', { name: 'Accept edits' })).toBeNull();
    fireEvent(input, 'blur');
    expect(screen.queryByTestId('code-edit-mode')).toBeNull();
  });
  it('sends an owner message directly to the session', async () => {
    mount(<CodingSessionScreen id="s1" />);
    const input = await screen.findByLabelText('Message');
    expect(input.props.placeholder).toBe('Message…');
    expect(screen.queryByRole('button', { name: 'Add to message' })).toBeNull();
    fireEvent.changeText(input, '  Add a regression test  ');
    fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/v1/coding-sessions/{id}/turns', {
        params: { path: { id: 's1' } },
        body: { prompt: 'Add a regression test' },
      }),
    );
    await waitFor(() => expect(screen.getByLabelText('Message').props.value).toBe(''));
  });
  it('keeps drafts when sending fails', async () => {
    mockPost.mockRejectedValue(new Error('Connection lost'));
    mount(<CodingSessionScreen id="s1" />);
    fireEvent.changeText(await screen.findByLabelText('Message'), 'Keep this draft');
    fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Connection lost')).toBeTruthy();
    expect(screen.getByLabelText('Message').props.value).toBe('Keep this draft');
  });
});
