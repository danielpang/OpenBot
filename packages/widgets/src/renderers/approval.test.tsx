// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalWidget,
  decisionText,
  traceInWords,
  type ApprovalWidgetState,
} from './approval.js';

// The approval widget's states: pending with Approve and Deny, then closed
// with the decision, whether the decision came back from the post, from
// `widget.updated` or from `approval.resolved` through the `state` prop.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
});

/** Renders into one root per test, so a second call re-renders with new props. */
function render(ui: React.ReactNode) {
  if (!root) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root!.render(ui));
  return host;
}

const props = {
  tool_name: 'github__delete_repo',
  args: { repo: 'acme/site' },
  summary: 'Delete acme/site',
  reason: 'github__delete_repo is marked destructive',
  trace: [
    {
      rule: 'annotations',
      decision: 'ask' as const,
      why: 'github__delete_repo is marked destructive',
    },
  ],
};
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const status = () => host.querySelector('[data-widget="approval"]')!.getAttribute('data-status');

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('<ApprovalWidget>', () => {
  it('shows the tool, the summary and why it asked while pending', () => {
    render(<ApprovalWidget props={props} state={{ status: 'pending' }} onAction={vi.fn()} />);
    expect(host.textContent).toContain('github__delete_repo');
    expect(host.textContent).toContain('Delete acme/site');
    expect(host.textContent).toContain('Asked because github__delete_repo is marked destructive.');
    expect(button('Approve')!.disabled).toBe(false);
    expect(button('Deny')!.disabled).toBe(false);
    expect(status()).toBe('pending');
  });

  it('approves, then closes with the decision from the reply', async () => {
    const onAction = vi.fn(async () => ({ status: 'approved' }));
    render(<ApprovalWidget props={props} state={{ status: 'pending' }} onAction={onAction} />);
    await act(async () => button('Approve')!.click());
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'approve' });
    expect(status()).toBe('approved');
    expect(button('Approve')).toBeUndefined();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Approved by you');
  });

  it('denies with a note and shows it', async () => {
    const onAction = vi.fn(async () => ({ status: 'denied', note: 'not this one' }));
    render(<ApprovalWidget props={props} onAction={onAction} />);
    type(host.querySelector('input')!, ' not this one ');
    await act(async () => button('Deny')!.click());
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'deny', note: 'not this one' });
    expect(status()).toBe('denied');
    expect(host.textContent).toContain('Denied by you');
    expect(host.textContent).toContain('“not this one”');
  });

  it('stays pending and shows the refusal when the post fails', async () => {
    const onAction = vi.fn(async () => {
      throw new Error('This request was already expired');
    });
    render(<ApprovalWidget props={props} onAction={onAction} />);
    await act(async () => button('Approve')!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'This request was already expired',
    );
    expect(status()).toBe('pending');
    expect(button('Approve')!.disabled).toBe(false);
  });

  it('follows the state prop live (approval.resolved) from pending to decided', () => {
    const onAction = vi.fn();
    render(<ApprovalWidget props={props} state={{ status: 'pending' }} onAction={onAction} />);
    expect(status()).toBe('pending');
    const resolved: ApprovalWidgetState = {
      status: 'approved',
      decidedBy: 'user-1',
      decidedAt: '2026-10-17T10:00:00.000Z',
    };
    render(<ApprovalWidget props={props} state={resolved} onAction={onAction} />);
    expect(status()).toBe('approved');
    expect(host.textContent).toContain('Approved by you ·');
    expect(onAction).not.toHaveBeenCalled();
  });

  it('shows an expired request as closed', () => {
    render(<ApprovalWidget props={props} state={{ status: 'expired' }} onAction={vi.fn()} />);
    expect(button('Approve')).toBeUndefined();
    expect(host.textContent).toContain('Expired unanswered');
  });

  it('is read only without onAction', () => {
    render(<ApprovalWidget props={props} state={{ status: 'pending' }} />);
    expect(button('Approve')!.disabled).toBe(true);
  });

  it('offers Reply in thread when the transcript has threads', () => {
    const onReply = vi.fn();
    render(<ApprovalWidget props={props} onAction={vi.fn()} onReply={onReply} />);
    act(() => button('Reply in thread')!.click());
    expect(onReply).toHaveBeenCalledOnce();
  });
});

describe('approval text', () => {
  it('explains a trace in words, the last rule deciding', () => {
    expect(
      traceInWords([
        { rule: 'default', decision: 'ask', why: 'bash runs commands on the computer' },
        { rule: 'tool', decision: 'auto', why: 'Bot setting for bash' },
      ]),
    ).toEqual([
      'By default: bash runs commands on the computer, which would ask you first.',
      'Your setting for this tool: Bot setting for bash, so the Bot will run without asking.',
    ]);
  });

  it('says who closed a request', () => {
    expect(decisionText({ status: 'denied', decidedBy: 'u1' })).toBe('Denied by you');
    expect(decisionText({ status: 'denied', decidedBy: null })).toBe(
      'Closed when the run was stopped',
    );
  });
});
