// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoginRequestState } from '../kinds/login_request.js';
import { LoginRequestWidget } from './login_request.js';

// Which Bot needs which site and why, Take over on the right screen, then
// Done or Can't sign in once.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(ui: React.ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}

const MAIN = '00000000-0000-4000-8000-00000000000a';
const SCOUT = '00000000-0000-4000-8000-00000000000b';
const props = {
  site: 'github.com',
  url: 'https://github.com/login',
  reason: 'To read the private issues',
  requester: { bot_id: SCOUT, handle: 'scout', name: 'Scout' },
  screen_bot_id: MAIN,
};
const buttons = () => [...host.querySelectorAll('button')];
const button = (label: string) => buttons().find((b) => b.textContent === label);

describe('<LoginRequestWidget>', () => {
  it('says which Bot needs which site and why, and who else waits and why', () => {
    const state: LoginRequestState = {
      status: 'pending',
      waiting: [
        { run_id: 'r1', bot_id: SCOUT, handle: 'scout', reason: 'To read the private issues' },
        {
          run_id: 'r2',
          bot_id: '00000000-0000-4000-8000-00000000000c',
          handle: 'writer',
          reason: 'To comment on the pull request',
        },
        { run_id: 'r3', bot_id: '00000000-0000-4000-8000-00000000000d', handle: 'older' },
      ],
    };
    render(<LoginRequestWidget props={props} state={state} onAction={vi.fn()} />);
    expect(host.textContent).toContain('@scout needs you to sign in to github.com');
    expect(host.textContent).toContain('To read the private issues');
    expect(host.textContent).toContain('Also waiting:');
    const waiters = [...host.querySelectorAll('[data-waiter]')].map((li) => li.textContent);
    // The requester is named above, not again in the list; a waiter from
    // before reasons were kept shows its handle alone.
    expect(waiters).toEqual(['@writer: To comment on the pull request', '@older']);
    // The owner's copy rule: no dashes used as pauses.
    expect(host.textContent).not.toMatch(/[–—]| - /);
  });

  it('opens Takeover on the screen named in the request, on the sign-in page', () => {
    const onTakeover = vi.fn();
    render(<LoginRequestWidget props={props} onAction={vi.fn()} onTakeover={onTakeover} />);
    act(() => button('Take over')!.click());
    expect(onTakeover).toHaveBeenCalledExactlyOnceWith(MAIN, 'https://github.com/login');
  });

  it('has no Take over where there is no computer view', () => {
    render(<LoginRequestWidget props={props} onAction={vi.fn()} />);
    expect(button('Take over')).toBeUndefined();
    expect(button('Done')).toBeDefined();
  });

  it('posts Done once, then says it is signed in, with no buttons left', async () => {
    const onAction = vi.fn(async () => ({ status: 'signed_in' }));
    render(<LoginRequestWidget props={props} onAction={onAction} onTakeover={vi.fn()} />);
    await act(async () => button('Done')!.click());
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'done' });
    expect(buttons()).toEqual([]);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Signed in');
  });

  it("posts Can't sign in, and follows the state from widget.updated", async () => {
    const onAction = vi.fn(async () => undefined);
    render(<LoginRequestWidget props={props} onAction={onAction} />);
    await act(async () => button("Can't sign in")!.click());
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'cant' });
    expect(host.textContent).toContain('Not signed in');

    act(() =>
      root!.render(
        <LoginRequestWidget props={props} state={{ status: 'signed_in' }} onAction={onAction} />,
      ),
    );
    expect(host.textContent).toContain('Signed in');
  });

  it('says an expired request expired, with no buttons left', () => {
    render(
      <LoginRequestWidget
        props={props}
        state={{ status: 'expired', waiting: [] }}
        onAction={vi.fn()}
        onTakeover={vi.fn()}
      />,
    );
    expect(buttons()).toEqual([]);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'Expired unanswered. The waiting Bots were told.',
    );
  });

  it('shows why an answer failed', async () => {
    const onAction = vi.fn(async () => {
      throw new Error('This sign-in request was already answered');
    });
    render(<LoginRequestWidget props={props} onAction={onAction} />);
    await act(async () => button('Done')!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'This sign-in request was already answered',
    );
  });
});
