// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodingSessionProps, CodingSessionState } from '../kinds/coding_session.js';
import { CodingSessionWidget, sessionClock, sessionDuration } from './coding_session.js';
import type { CodingSessionHost } from './types.js';

// The coding session card (CA5 to CA8): the header, the live feed, approvals
// decided through the app, the result once it settles, and Open terminal,
// Stop, Continue, Discard branch and View log.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.useRealTimers();
});

function render(ui: React.ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}

const SESSION = '00000000-0000-4000-8000-0000000000f1';
const APPROVAL = '00000000-0000-4000-8000-0000000000a1';
const props: CodingSessionProps = {
  session_id: SESSION,
  agent: 'claude',
  repo: 'danielpang/openbots-relay',
  branch: 'bot/relay-reconnect',
  base: 'main',
  mode: 'pr',
  prompt_excerpt: 'Fix the reconnect loop in the relay.',
};
const T = '2026-11-05T10:00:00.000Z';
const running: CodingSessionState = {
  status: 'running',
  started_at: T,
  feed: [
    { t: T, type: 'tool_use', text: 'Read apps/relay/src/server.ts' },
    { t: T, type: 'file_change', text: 'Edited apps/relay/src/session.ts (+38 −7)' },
  ],
  approvals: [
    {
      id: APPROVAL,
      action_class: 'push',
      title: 'Wants to push',
      detail: 'git push origin bot/relay-reconnect',
      status: 'pending',
    },
  ],
};
const settled: CodingSessionState = {
  status: 'settled',
  started_at: T,
  finished_at: '2026-11-05T10:06:00.000Z',
  feed: running.feed,
  approvals: [{ ...running.approvals[0]!, status: 'approved' }],
  result: {
    summary: 'Backed off **reconnects** after a sleep.',
    changed_files: [
      { path: 'apps/relay/src/session.ts', added: 38, removed: 7, kind: 'edit' },
      { path: 'apps/relay/src/session.test.ts', added: 3, removed: 2, kind: 'edit' },
    ],
    commits: [{ sha: 'a1b2c3d4e5f6', title: 'relay: back off reconnects after a sleep' }],
    branch: 'bot/relay-reconnect',
    base: 'main',
    worktree_path: '/home/bot/repos/danielpang/openbots-relay/.worktrees/bot-relay-reconnect',
    pr_url: 'https://github.com/danielpang/openbots-relay/pull/12',
    usage: { input_tokens: 1000, output_tokens: 200, billed: 'subscription' },
  },
};

const buttons = () => [...host.querySelectorAll('button')];
const button = (label: string) => buttons().find((b) => b.textContent === label);
const hostApi = (over: Partial<CodingSessionHost> = {}): CodingSessionHost => ({
  decideApproval: vi.fn(async () => {}),
  openTerminal: vi.fn(async () => {}),
  loadLog: vi.fn(async () => 'line one\nline two'),
  ...over,
});

function type(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('<CodingSessionWidget>', () => {
  it('shows the header, the feed and the pending approval while running', () => {
    vi.useFakeTimers({
      now: new Date('2026-11-05T10:04:12.000Z'),
      toFake: ['Date', 'setInterval'],
    });
    render(
      <CodingSessionWidget props={props} state={running} onAction={vi.fn()} coder={hostApi()} />,
    );
    expect(host.querySelector('[data-dot]')?.className).toContain('bg-emerald-500');
    expect(host.textContent).toContain('Claude Code');
    expect(host.textContent).toContain('openbots-relay · bot/relay-reconnect');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Working · 4:12');
    const feed = host.querySelector('[data-feed]')!;
    expect(feed.className).toContain('font-mono');
    expect(feed.textContent).toContain('Read apps/relay/src/server.ts');
    const approval = host.querySelector(`[data-approval="${APPROVAL}"]`)!;
    expect(approval.textContent).toContain('Wants to push');
    expect(approval.textContent).toContain('Push');
    expect(approval.textContent).toContain('git push origin bot/relay-reconnect');
    expect(button('Stop')).toBeDefined();
    // The headless CLI owns the worktree while it runs; the terminal waits for it to end.
    expect(button('Open terminal')).toBeUndefined();
    expect(host.textContent).toContain('Stop the session to continue it in the terminal');
    expect(button('Continue')).toBeUndefined();
    expect(button('Discard branch')).toBeUndefined();
    expect(host.textContent).not.toMatch(/[–—]| - /);
    // The clock ticks.
    act(() => vi.advanceTimersByTime(2000));
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Working · 4:14');
  });

  it.each([
    ['waiting', 'bg-amber-500'],
    ['failed', 'bg-destructive'],
    ['settled', 'bg-muted-foreground'],
  ] as const)('marks a %s session with its colour', (status, dot) => {
    render(<CodingSessionWidget props={props} state={{ ...running, status }} />);
    expect(host.querySelector('[data-dot]')?.className).toContain(dot);
  });

  it('approves and denies through the app, then shows the decision', async () => {
    const coder = hostApi();
    render(<CodingSessionWidget props={props} state={running} onAction={vi.fn()} coder={coder} />);
    await act(async () => button('Approve')!.click());
    expect(coder.decideApproval).toHaveBeenCalledExactlyOnceWith(APPROVAL, 'approve');
    expect(button('Approve')).toBeUndefined();
    expect(host.textContent).toContain('Wants to push: Approved');

    const second = { ...running, approvals: [{ ...running.approvals[0]!, id: 'x' }] };
    act(() => root!.render(<CodingSessionWidget props={props} state={second} coder={coder} />));
    await act(async () => button('Deny')!.click());
    expect(coder.decideApproval).toHaveBeenLastCalledWith('x', 'deny');
    expect(host.textContent).toContain('Wants to push: Denied');
  });

  it('shows why a decision failed', async () => {
    const coder = hostApi({
      decideApproval: vi.fn(async () => {
        throw new Error('The request was already decided');
      }),
    });
    render(<CodingSessionWidget props={props} state={running} coder={coder} />);
    await act(async () => button('Approve')!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'The request was already decided',
    );
  });

  it('stops a running session', async () => {
    const onAction = vi.fn(async () => undefined);
    render(<CodingSessionWidget props={props} state={running} onAction={onAction} />);
    await act(async () => button('Stop')!.click());
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'stop' });
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Stopped');
    expect(button('Stop')).toBeUndefined();
  });

  it.each(['settled', 'failed', 'stopped'] as const)(
    'opens the terminal on a %s session',
    async (status) => {
      const coder = hostApi();
      render(
        <CodingSessionWidget
          props={props}
          state={{ ...settled, status }}
          onAction={vi.fn()}
          coder={coder}
        />,
      );
      expect(host.textContent).not.toContain('Stop the session to continue it in the terminal');
      await act(async () => button('Open terminal')!.click());
      expect(coder.openTerminal).toHaveBeenCalledExactlyOnceWith(SESSION);
    },
  );

  it.each(['queued', 'starting', 'running', 'waiting'] as const)(
    'has no Open terminal while %s',
    (status) => {
      render(
        <CodingSessionWidget
          props={props}
          state={{ ...running, status }}
          onAction={vi.fn()}
          coder={hostApi()}
        />,
      );
      expect(button('Open terminal')).toBeUndefined();
      expect(button('Stop')).toBeDefined();
    },
  );

  it('says a needs_login marker as a sentence and other errors as they are', () => {
    render(
      <CodingSessionWidget
        props={props}
        state={{ ...settled, status: 'failed', error: 'needs_login' }}
      />,
    );
    expect(host.querySelector('[data-error]')?.textContent).toBe(
      'Not signed in. Sign in under Settings > Models.',
    );
    act(() =>
      root!.render(
        <CodingSessionWidget
          props={props}
          state={{ ...settled, status: 'failed', error: 'Claude Code stopped: rate limited.' }}
        />,
      ),
    );
    expect(host.querySelector('[data-error]')?.textContent).toBe(
      'Claude Code stopped: rate limited.',
    );
  });

  it('shows the result once settled: summary, files, commits, PR and the plan', () => {
    render(
      <CodingSessionWidget
        props={props}
        state={settled}
        onAction={vi.fn()}
        coder={hostApi()}
        renderMarkdown={(text) => <div data-markdown>{text}</div>}
      />,
    );
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Done · 6 min');
    expect(host.querySelector('[data-markdown]')?.textContent).toBe(
      'Backed off **reconnects** after a sleep.',
    );
    expect(host.textContent).toContain('2 files changed (+41 −9)');
    expect(host.querySelector('[data-file="apps/relay/src/session.ts"]')?.textContent).toContain(
      '+38',
    );
    expect(host.textContent).toContain('a1b2c3d');
    expect(host.textContent).toContain('relay: back off reconnects after a sleep');
    expect(host.querySelector('[data-usage]')).toBeNull();
    const pr = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Open PR')!;
    expect(pr.getAttribute('href')).toBe(settled.result!.pr_url);
    expect(button('Stop')).toBeUndefined();
    expect(button('Continue')).toBeDefined();
    expect(button('Discard branch')).toBeDefined();
    expect(host.textContent).not.toMatch(/[–—]| - /);
  });

  it('opens the diff Artifact with View diff, and has no View diff without one', () => {
    const onOpenArtifact = vi.fn();
    const DIFF = '00000000-0000-4000-8000-0000000000d1';
    const withDiff = {
      ...settled,
      result: { ...settled.result!, diff_artifact_id: DIFF },
    } as CodingSessionState;
    render(<CodingSessionWidget props={props} state={withDiff} onOpenArtifact={onOpenArtifact} />);
    act(() => button('View diff')!.click());
    expect(onOpenArtifact).toHaveBeenCalledExactlyOnceWith(DIFF);
    act(() =>
      root!.render(
        <CodingSessionWidget props={props} state={settled} onOpenArtifact={onOpenArtifact} />,
      ),
    );
    expect(button('View diff')).toBeUndefined();
    // Without a viewer (a read only view) there is nothing to open it in.
    act(() => root!.render(<CodingSessionWidget props={props} state={withDiff} />));
    expect(button('View diff')).toBeUndefined();
  });

  it('continues with a prompt from the inline field', async () => {
    const onAction = vi.fn(async () => undefined);
    render(<CodingSessionWidget props={props} state={settled} onAction={onAction} />);
    act(() => button('Continue')!.click());
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Next prompt"]')!;
    expect(button('Send')!.disabled).toBe(true);
    type(input, ' Also add a test ');
    await act(async () => button('Send')!.closest('form')!.requestSubmit());
    expect(onAction).toHaveBeenCalledExactlyOnceWith({
      type: 'continue',
      prompt: 'Also add a test',
    });
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Queued');
    expect(host.querySelector('input[aria-label="Next prompt"]')).toBeNull();
  });

  it('discards the branch only after the inline confirm', async () => {
    const onAction = vi.fn(async () => undefined);
    render(<CodingSessionWidget props={props} state={settled} onAction={onAction} />);
    act(() => button('Discard branch')!.click());
    expect(onAction).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Delete the branch bot/relay-reconnect');
    act(() => button('Keep it')!.click());
    expect(host.textContent).not.toContain('Delete the branch');
    act(() => button('Discard branch')!.click());
    await act(async () => button('Discard branch')!.click());
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'discard' });
    expect(host.textContent).toContain('Discarding the branch.');
    expect(button('Discard branch')).toBeUndefined();
  });

  it('opens the full log in a dialog', async () => {
    const coder = hostApi();
    render(<CodingSessionWidget props={props} state={settled} coder={coder} />);
    await act(async () => button('View log')!.click());
    expect(coder.loadLog).toHaveBeenCalledWith(SESSION);
    expect(document.querySelector('[data-log]')?.textContent).toBe('line one\nline two');
  });

  it('shows an error and API usage for a failed session', () => {
    render(
      <CodingSessionWidget
        props={{ ...props, agent: 'codex' }}
        state={{
          ...settled,
          status: 'failed',
          error: 'Codex is not signed in',
          result: {
            ...settled.result!,
            usage: { input_tokens: 12345, output_tokens: 2300, cost_usd: 0.4, billed: 'api' },
          },
        }}
      />,
    );
    expect(host.textContent).toContain('Codex is not signed in');
    expect(host.querySelector('[data-usage]')?.textContent).toBe(
      '12,345 in / 2,300 out tokens, $0.40',
    );
  });

  it('is read only without the app or actions', () => {
    render(<CodingSessionWidget props={props} state={running} />);
    expect(buttons()).toEqual([]);
  });

  it('formats times', () => {
    expect(sessionClock(252_000)).toBe('4:12');
    expect(sessionClock(3_852_000)).toBe('1:04:12');
    expect(sessionDuration(45_000)).toBe('45s');
    expect(sessionDuration(360_000)).toBe('6 min');
    expect(sessionDuration(3_900_000)).toBe('1 h 5 min');
  });
});
