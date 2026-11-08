import React from 'react';
import { Linking } from 'react-native';
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
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (href: string) => mockPush(href) } }));

const SESSION_ID = '5b0c8a52-8f39-4a5e-9a7e-2f5d3c1b9a10';
const APPROVAL_ID = '9d2f1a34-6b7c-4e8d-9f0a-1b2c3d4e5f60';
const LOGIN_ID = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';

const sessionProps = {
  session_id: SESSION_ID,
  agent: 'claude',
  repo: 'danielpang/openbots-relay',
  branch: 'openbots/fix-reconnect',
  base: 'main',
  mode: 'pr',
  prompt_excerpt: 'Fix the reconnect loop',
};

function feed(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    t: `2026-11-05T10:00:${String(i).padStart(2, '0')}Z`,
    type: 'text',
    text: `line ${i + 1}`,
  }));
}

function session(state: Record<string, unknown>) {
  return render(
    <NativeWidget
      messageId="session-message"
      index={1}
      part={{ type: 'widget', kind: 'coding_session', props: sessionProps, state }}
    />,
  );
}

function login(state: Record<string, unknown>, props: Record<string, unknown> = {}) {
  return render(
    <NativeWidget
      messageId="login-message"
      index={0}
      part={{
        type: 'widget',
        kind: 'coder_login',
        props: {
          login_id: LOGIN_ID,
          agent: 'claude',
          url: 'https://claude.ai/oauth/authorize?code=abc',
          instructions:
            'Open the link, sign in with your Claude account, then paste the code here.',
          ...props,
        },
        state,
      }}
    />,
  );
}

beforeEach(() => {
  mockPost.mockReset().mockResolvedValue({ data: {}, response: { ok: true } });
  mockInvalidate.mockReset().mockResolvedValue(undefined);
});

describe('coding session widget', () => {
  it('shows the header, the last eight feed lines and Stop while running', async () => {
    session({ status: 'running', feed: feed(12), approvals: [] });
    expect(screen.getByText('Claude Code on danielpang/openbots-relay')).toBeTruthy();
    expect(screen.getByText('Branch openbots/fix-reconnect')).toBeTruthy();
    expect(screen.getByText('Working')).toBeTruthy();
    expect(screen.queryByText('line 4')).toBeNull();
    expect(screen.getByText('line 5')).toBeTruthy();
    expect(screen.getByText('line 12')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /terminal/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /continue/i })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/v1/messages/{id}/widgets/{part}/action', {
        params: { path: { id: 'session-message', part: 1 } },
        body: { action: { type: 'stop' } },
      }),
    );
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['messages'] });
  });

  it('decides a pending approval through the approvals route', async () => {
    session({
      status: 'waiting',
      feed: [],
      approvals: [
        {
          id: APPROVAL_ID,
          action_class: 'push',
          title: 'Push openbots/fix-reconnect',
          detail: 'git push origin openbots/fix-reconnect',
          status: 'pending',
        },
      ],
    });
    expect(screen.getByText('Waiting for you')).toBeTruthy();
    expect(screen.getByText('Push openbots/fix-reconnect')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/v1/approvals/{id}/decide', {
        params: { path: { id: APPROVAL_ID } },
        body: { decision: 'approve' },
      }),
    );
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['approvals'] });
  });

  it('denies an approval and shows the error when deciding fails', async () => {
    mockPost.mockRejectedValueOnce(new Error('Approval expired'));
    session({
      status: 'waiting',
      feed: [],
      approvals: [
        { id: APPROVAL_ID, action_class: 'push', title: 'Push the branch', status: 'pending' },
      ],
    });
    fireEvent.press(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(screen.getByText('Approval expired')).toBeTruthy());
    expect(mockPost).toHaveBeenCalledWith('/api/v1/approvals/{id}/decide', {
      params: { path: { id: APPROVAL_ID } },
      body: { decision: 'deny' },
    });
  });

  it('shows the settled result with the PR link and no Stop', () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    session({
      status: 'settled',
      feed: feed(3),
      approvals: [
        { id: APPROVAL_ID, action_class: 'push', title: 'Push the branch', status: 'approved' },
      ],
      result: {
        summary: 'Fixed the reconnect loop with a backoff.',
        changed_files: [
          { path: 'src/relay.ts', added: 20, removed: 4, kind: 'edit' },
          { path: 'src/relay.test.ts', added: 30, removed: 0, kind: 'create' },
        ],
        commits: [{ sha: 'abc1234', title: 'Back off reconnects' }],
        branch: 'openbots/fix-reconnect',
        base: 'main',
        worktree_path: '/home/coder/work/relay',
        pr_url: 'https://github.com/danielpang/openbots-relay/pull/42',
      },
    });
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Fixed the reconnect loop with a backoff.')).toBeTruthy();
    expect(screen.getByText('2 files changed (+50, -4), 1 commit')).toBeTruthy();
    expect(screen.getByText('Push the branch: Approved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Open pull request' }));
    expect(open).toHaveBeenCalledWith('https://github.com/danielpang/openbots-relay/pull/42');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('links the diff saved as an Artifact', () => {
    const DIFF = 'c3d4e5f6-0718-4a29-8b3c-4d5e6f708192';
    session({
      status: 'settled',
      feed: [],
      approvals: [],
      result: {
        summary: '',
        changed_files: [],
        commits: [],
        branch: 'openbots/fix-reconnect',
        base: 'main',
        worktree_path: '/home/coder/work/relay',
        diff_artifact_id: DIFF,
      },
    });
    expect(screen.getByText('Diff saved as an Artifact')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'View diff' }));
    expect(mockPush).toHaveBeenCalledWith(`/artifact/${DIFF}`);
  });

  it('shows the usage line: tokens and cost, or the plan words', () => {
    const settled = (usage: Record<string, unknown>) => ({
      status: 'settled',
      feed: [],
      approvals: [],
      result: {
        summary: '',
        changed_files: [],
        commits: [],
        branch: 'b',
        base: 'main',
        worktree_path: '/w',
        usage,
      },
    });
    const first = session(
      settled({ input_tokens: 12000, output_tokens: 600, cost_usd: 0.4, billed: 'api' }),
    );
    expect(screen.getByText('12,000 in / 600 out tokens, $0.40')).toBeTruthy();
    first.unmount();
    session(settled({ input_tokens: 1, output_tokens: 2, billed: 'subscription' }));
    expect(screen.getByText('Billed to your Claude plan')).toBeTruthy();
  });

  it('has no diff link without a diff Artifact', () => {
    session({
      status: 'settled',
      feed: [],
      approvals: [],
      result: {
        summary: '',
        changed_files: [],
        commits: [],
        branch: 'b',
        base: 'main',
        worktree_path: '/w',
      },
    });
    expect(screen.queryByText('Diff saved as an Artifact')).toBeNull();
  });

  it('says a needs_login marker as a sentence', () => {
    session({ status: 'failed', feed: [], approvals: [], error: 'needs_login' });
    expect(screen.getByText('Not signed in. Sign in under Settings > Models.')).toBeTruthy();
    expect(screen.queryByText('needs_login')).toBeNull();
  });

  it('shows a failed session with its error', () => {
    session({ status: 'failed', feed: [], approvals: [], error: 'The agent ran out of turns.' });
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('The agent ran out of turns.')).toBeTruthy();
    expect(
      screen.getByText('Open Code to message the agent directly, or reply in this thread.'),
    ).toBeTruthy();
  });
});

describe('coding agent sign-in widget', () => {
  it('opens the link and sends the pasted code with Done', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    login({ status: 'pending' });
    expect(screen.getByText('Sign in to Claude Code')).toBeTruthy();
    expect(screen.getByText('https://claude.ai/oauth/authorize?code=abc')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Open in browser' }));
    expect(open).toHaveBeenCalledWith('https://claude.ai/oauth/authorize?code=abc');
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done.props.accessibilityState.disabled).toBe(true);
    fireEvent.changeText(screen.getByLabelText('Code from the sign-in page'), '  ABCD-1234 ');
    fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/v1/messages/{id}/widgets/{part}/action', {
        params: { path: { id: 'login-message', part: 0 } },
        body: { action: { type: 'code', code: 'ABCD-1234' } },
      }),
    );
  });

  it('sends cant when the owner cannot sign in', async () => {
    login({ status: 'pending' });
    fireEvent.press(screen.getByRole('button', { name: 'Can’t sign in' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/v1/messages/{id}/widgets/{part}/action', {
        params: { path: { id: 'login-message', part: 0 } },
        body: { action: { type: 'cant' } },
      }),
    );
  });

  it('shows a device code when the agent prints one', () => {
    login({ status: 'pending' }, { agent: 'codex', device_code: 'WXYZ-9876' });
    expect(screen.getByText('Sign in to Codex')).toBeTruthy();
    expect(screen.getByText('WXYZ-9876')).toBeTruthy();
    expect(
      screen.getByText('Enter this code on the sign-in page. There is nothing to paste back here.'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Code from the sign-in page')).toBeNull();
    expect(screen.getByRole('button', { name: 'Can’t sign in' })).toBeTruthy();
  });

  it('keeps the link and the paste field while the login awaits the code', () => {
    // The Claude CLI asks for the code right after printing the link.
    login({ status: 'awaiting_code' });
    expect(screen.getByText('https://claude.ai/oauth/authorize?code=abc')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open in browser' })).toBeTruthy();
    expect(screen.getByLabelText('Code from the sign-in page')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(screen.queryByText('Checking the code.')).toBeNull();
  });

  it('says it is checking only after the owner sends a code, until a new error', async () => {
    const view = login({ status: 'awaiting_code' });
    fireEvent.changeText(screen.getByLabelText('Code from the sign-in page'), 'ABCD-1234');
    fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.getByText('Checking the code.')).toBeTruthy());
    expect(screen.queryByLabelText('Code from the sign-in page')).toBeNull();
    view.rerender(
      <NativeWidget
        messageId="login-message"
        index={0}
        part={{
          type: 'widget',
          kind: 'coder_login',
          props: {
            login_id: LOGIN_ID,
            agent: 'claude',
            url: 'https://claude.ai/oauth/authorize?code=abc',
            instructions: 'Open the link, sign in, then paste the code here.',
          },
          state: { status: 'awaiting_code', error: 'That code did not work. Try again.' },
        }}
      />,
    );
    expect(screen.queryByText('Checking the code.')).toBeNull();
    expect(screen.getByLabelText('Code from the sign-in page')).toBeTruthy();
    expect(screen.getByText('That code did not work. Try again.')).toBeTruthy();
  });

  it('does not say it is checking when sending the code failed', async () => {
    mockPost.mockRejectedValueOnce(new Error('This sign-in expired'));
    login({ status: 'pending' });
    fireEvent.changeText(screen.getByLabelText('Code from the sign-in page'), 'ABCD-1234');
    fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.getByText('This sign-in expired')).toBeTruthy());
    expect(screen.queryByText('Checking the code.')).toBeNull();
  });

  it.each([
    [
      { status: 'signed_in', account_label: 'dan@example.com' },
      'Signed in to Claude Code as dan@example.com.',
    ],
    [{ status: 'expired' }, 'This sign-in expired.'],
    [{ status: 'failed' }, 'Sign-in did not finish.'],
    [
      { status: 'cancelled', wants_api_key: true },
      'Using an API key instead. Add it in Settings on your computer.',
    ],
  ])('shows %j without actions', (state, text) => {
    login(state);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open in browser' })).toBeNull();
    expect(screen.queryByLabelText('Code from the sign-in page')).toBeNull();
  });
});
