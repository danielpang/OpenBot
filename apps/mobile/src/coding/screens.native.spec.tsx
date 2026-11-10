import React from 'react';
import { ActivityIndicator, Alert, Keyboard, RefreshControl, StyleSheet } from 'react-native';
import type * as ReactNative from 'react-native';
import type * as Glass from '../components/glass';
import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CodingSessionScreen, CodingSessionsScreen, Entry } from './screens';
import { CodingSessionDetailsScreen } from './session-details';
import { ConnectionErrorsContext, OfflineError } from '../api/connection-state';

const mockGet = jest.fn<(path: string, ...args: unknown[]) => Promise<unknown>>();
const mockPost = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPatch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
let mockGlass = true;
jest.mock('../components/glass', () => ({
  ...jest.requireActual<typeof Glass>('../components/glass'),
  useGlassEnabled: () => mockGlass,
}));
let mockHeaderOptions: {
  headerTransparent?: boolean;
  headerStyle?: { backgroundColor: string };
  scrollEdgeEffects?: { top: string };
  unstable_headerRightItems?: () => Array<{
    accessibilityLabel: string;
    icon: { type: string; name: string };
    onPress: () => void;
  }>;
};
const mockPush = jest.fn();
const mockApi = { GET: mockGet, POST: mockPost, PATCH: mockPatch };
jest.mock('../api/provider', () => ({
  useApi: () => mockApi,
  useMobile: () => ({ connected: true }),
}));
jest.mock('../screens/data', () => ({
  useBots: () => ({ data: [{ id: 'bot1', name: 'Builder', toolPolicy: {} }] }),
}));
jest.mock('expo-router', () => ({
  Stack: {
    Screen: ({ options }: { options: typeof mockHeaderOptions }) => {
      mockHeaderOptions = options;
      return null;
    },
  },
  router: { push: (path: string) => mockPush(path) },
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('./agent-orb', () => ({ AgentOrb: () => null }));
// Jest has no native UI thread. Keep the screen and its style callback real,
// replacing only the native keyboard shared value and animated view boundary.
const mockKeyboard = { height: { value: 0 } };
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: jest.requireActual<typeof ReactNative>('react-native').View },
  useAnimatedKeyboard: () => mockKeyboard,
  useAnimatedStyle: (style: () => unknown) => style(),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 34 }),
}));
const session = {
  id: 's1',
  botId: 'bot1',
  title: 'Fix reconnect',
  agent: 'pi',
  status: 'settled',
  repoFullName: 'team/app',
  branch: 'fix',
  mode: 'pr',
};
const clients: QueryClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  jest.restoreAllMocks();
});
function mount(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  clients.push(client);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}
beforeEach(() => {
  mockGlass = true;
  mockKeyboard.height.value = 0;
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockPush.mockReset();
  mockPatch.mockReset().mockResolvedValue({ data: {}, response: { ok: true } });
  mockPost.mockReset().mockResolvedValue({
    data: { session: { ...session, status: 'queued' } },
    response: { ok: true },
  });
  mockGet.mockReset().mockImplementation(async (path: string) => ({
    response: { ok: true },
    data:
      path === '/api/v1/bots/{id}'
        ? { id: 'bot1', toolPolicy: { coder: { actions: { pr: 'deny' } } } }
        : path.endsWith('/approvals')
          ? { items: [] }
          : path.endsWith('/events')
            ? { entries: [], hasMore: false }
            : path.endsWith('coding-sessions')
              ? { sessions: [session] }
              : { session },
  }));
});
describe('coding conversations', () => {
  it.each([0, 320])(
    'keeps long approval cards inside the transcript scroll surface (keyboard: %s)',
    async (height) => {
      mockKeyboard.height.value = height;
      const original = mockGet.getMockImplementation()!;
      mockGet.mockImplementation(async (path, ...args) =>
        path.endsWith('/approvals')
          ? {
              data: {
                items: [1, 2, 3].map((n) => ({
                  id: `a${n}`,
                  botId: 'bot1',
                  sessionId: 's1',
                  status: 'pending',
                  reason: `Approval ${n}: ${'long command '.repeat(100)}`,
                  summary: 'Review the complete command',
                  toolName: 'Bash',
                })),
              },
              response: { ok: true },
            }
          : original(path, ...args),
      );
      mount(<CodingSessionScreen id="s1" />);
      await screen.findByTestId('session-approvals');
      const transcript = within(screen.getByTestId('coding-transcript'));
      expect(transcript.getByTestId('session-approvals')).toBeTruthy();
      expect(transcript.getAllByRole('button', { name: 'Approve' })).toHaveLength(3);
    },
  );
  it.each([true, false])('matches the bot header glass treatment (enabled: %s)', async (glass) => {
    mockGlass = glass;
    mount(<CodingSessionScreen id="s1" />);
    await screen.findByLabelText('Message');
    expect(mockHeaderOptions.headerTransparent).toBe(true);
    expect(mockHeaderOptions.headerStyle?.backgroundColor).toBe(glass ? 'transparent' : '#ffffff');
    expect(mockHeaderOptions.scrollEdgeEffects?.top).toBe(glass ? 'soft' : 'hidden');
  });
  it.each([true, false])(
    'uses the same glass header in session details (enabled: %s)',
    async (glass) => {
      mockGlass = glass;
      mount(<CodingSessionDetailsScreen id="s1" />);
      await screen.findByText('Fix reconnect');
      expect(mockHeaderOptions.headerTransparent).toBe(true);
      expect(mockHeaderOptions.headerStyle?.backgroundColor).toBe(
        glass ? 'transparent' : '#ffffff',
      );
      expect(mockHeaderOptions.scrollEdgeEffects?.top).toBe(glass ? 'soft' : 'hidden');
    },
  );
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
  it('keeps initial loading separate from pull-to-refresh', async () => {
    let finish!: () => void;
    mockGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ data: { sessions: [session] }, response: { ok: true } });
        }),
    );
    mount(<CodingSessionsScreen />);
    expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
    expect(screen.UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
    await act(async () => finish());
    expect(await screen.findByRole('button', { name: 'Open Fix reconnect' })).toBeTruthy();
    expect(screen.UNSAFE_queryByType(ActivityIndicator)).toBeNull();
  });
  it('keeps cached sessions visible without pull-to-refresh during background updates', async () => {
    mount(<CodingSessionsScreen />);
    await screen.findByRole('button', { name: 'Open Fix reconnect' });
    let finish!: () => void;
    mockGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ data: { sessions: [session] }, response: { ok: true } });
        }),
    );
    act(() => {
      void clients[0]!.invalidateQueries({ queryKey: ['coding-sessions'] });
    });
    await waitFor(() => expect(clients[0]!.isFetching()).toBe(1));
    expect(screen.getByRole('button', { name: 'Open Fix reconnect' })).toBeTruthy();
    expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
    await act(async () => finish());
  });
  it.each([false, true])('ends manual refreshing after a request (failure: %s)', async (fails) => {
    mount(<CodingSessionsScreen />);
    await screen.findByRole('button', { name: 'Open Fix reconnect' });
    let finish!: () => void;
    mockGet.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = () =>
            fails
              ? reject(new Error('Refresh failed'))
              : resolve({ data: { sessions: [session] }, response: { ok: true } });
        }),
    );
    act(() => screen.UNSAFE_getByType(RefreshControl).props.onRefresh());
    expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true);
    expect(screen.getByRole('button', { name: 'Open Fix reconnect' })).toBeTruthy();
    await act(async () => finish());
    await waitFor(() =>
      expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false),
    );
    expect(screen.getByRole('button', { name: 'Open Fix reconnect' })).toBeTruthy();
  });
  it('opens session metadata from the native info button, not the conversation body', async () => {
    mount(<CodingSessionScreen id="s1" />);
    await screen.findByLabelText('Message');
    expect(screen.queryByText('team/app · fix')).toBeNull();
    expect(screen.queryByText('Done')).toBeNull();
    const info = mockHeaderOptions.unstable_headerRightItems!()[0]!;
    expect(info.accessibilityLabel).toBe('Session details');
    expect(info.icon).toEqual({ type: 'sfSymbol', name: 'info.circle' });
    act(() => info.onPress());
    expect(mockPush).toHaveBeenCalledWith('/coding-session/s1/details');
  });
  it('shows session metadata and the actual server error on the details page', async () => {
    mockGet.mockResolvedValue({
      data: {
        session: {
          ...session,
          status: 'failed',
          error: 'The server restarted before saving the outcome',
        },
      },
      response: { ok: true },
    });
    mount(<CodingSessionDetailsScreen id="s1" />);
    expect(await screen.findByText('team/app')).toBeTruthy();
    expect(screen.getByText('fix')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('The server restarted before saving the outcome')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });
  it('does not stack offline errors from session, transcript, and approvals', async () => {
    mount(
      <ConnectionErrorsContext.Provider value>
        <CodingSessionScreen id="s1" />
      </ConnectionErrorsContext.Provider>,
    );
    await screen.findByLabelText('Message');
    mockGet.mockRejectedValue(new OfflineError());
    await act(async () => {
      await clients[0]!.invalidateQueries();
    });
    expect(screen.queryAllByText(/You’re offline/)).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: 'Try again' })).toHaveLength(0);
    expect(screen.getByLabelText('Message')).toBeTruthy();
  });
  it('shows edit modes only while composing, in an in-app popup', async () => {
    mount(<CodingSessionScreen id="s1" />);
    const input = await screen.findByLabelText('Message');
    expect(screen.queryByTestId('code-edit-mode')).toBeNull();
    fireEvent(input, 'focus');
    const mode = screen.getByRole('button', { name: 'Edit mode: Ask before edits' });
    expect(screen.queryByRole('button', { name: 'Accept edits' })).toBeNull();
    fireEvent.press(mode);
    const popup = within(screen.getByLabelText('File edit approvals'));
    expect(popup.getAllByRole('button')).toHaveLength(2);
    expect(popup.getByRole('button', { name: 'Accept edits' })).toBeTruthy();
    expect(popup.getByRole('button', { name: 'Ask before edits' })).toBeTruthy();
    fireEvent.press(mode);
    expect(screen.queryByRole('button', { name: 'Accept edits' })).toBeNull();
    fireEvent(input, 'blur');
    expect(screen.queryByTestId('code-edit-mode')).toBeNull();
  });
  it('saves the selected edit mode without weakening the latest PR policy', async () => {
    mount(<CodingSessionScreen id="s1" />);
    const invalidate = jest.spyOn(clients[0]!, 'invalidateQueries');
    fireEvent(await screen.findByLabelText('Message'), 'focus');
    fireEvent.press(screen.getByRole('button', { name: 'Edit mode: Ask before edits' }));
    fireEvent.press(
      within(screen.getByLabelText('File edit approvals')).getByRole('button', {
        name: 'Accept edits',
      }),
    );
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith('/api/v1/bots/{id}', {
        params: { path: { id: 'bot1' } },
        body: {
          toolPolicy: {
            tools: { write_file: 'auto', edit_file: 'auto', coding_edits: 'auto' },
            coder: { actions: { pr: 'deny' } },
          },
        },
      }),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bots'] }));
    expect(screen.queryByLabelText('File edit approvals')).toBeNull();
  });
  it('keeps the composer above the keyboard and restores the bottom safe area', async () => {
    const view = mount(<CodingSessionScreen id="s1" />);
    await screen.findByLabelText('Message');
    const padding = () =>
      StyleSheet.flatten(screen.getByTestId('code-keyboard-frame').props.style).paddingBottom;
    expect(padding()).toBe(34);
    mockKeyboard.height.value = 320;
    view.rerender(
      <QueryClientProvider client={clients[0]!}>
        <CodingSessionScreen id="s1" />
      </QueryClientProvider>,
    );
    expect(padding()).toBe(320);
    mockKeyboard.height.value = 0;
    view.rerender(
      <QueryClientProvider client={clients[0]!}>
        <CodingSessionScreen id="s1" />
      </QueryClientProvider>,
    );
    expect(padding()).toBe(34);
  });
  it('hides edit modes when the keyboard is dismissed without a blur event', async () => {
    let hideKeyboard: (() => void) | undefined;
    const original = Keyboard.addListener.bind(Keyboard);
    jest.spyOn(Keyboard, 'addListener').mockImplementation((event, callback) => {
      if (event === 'keyboardDidHide') {
        hideKeyboard = () =>
          callback({
            duration: 0,
            easing: 'keyboard',
            endCoordinates: { screenX: 0, screenY: 0, width: 390, height: 0 },
          });
      }
      return original(event, callback);
    });
    mount(<CodingSessionScreen id="s1" />);
    fireEvent(await screen.findByLabelText('Message'), 'focus');
    expect(screen.getByTestId('code-edit-mode')).toBeTruthy();
    expect(hideKeyboard).toBeDefined();
    act(() => hideKeyboard!());
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
