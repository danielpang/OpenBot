// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addressList, EmailDraftWidget } from './email_draft.js';

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

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement : HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const props = { to: ['dana@example.com'], subject: 'Invoice', body: 'Attached.' };
const field = (label: string) => host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;

describe('<EmailDraftWidget>', () => {
  it('sends the edited draft, then shows it as sending', async () => {
    const onAction = vi.fn(async () => ({ status: 'sending' }));
    render(<EmailDraftWidget props={props} state={{ status: 'draft' }} onAction={onAction} />);
    type(field('To'), 'dana@example.com, sam@example.com');
    type(field('Subject'), 'Invoice 42');
    await act(async () => host.querySelector('form')!.requestSubmit());

    expect(onAction).toHaveBeenCalledExactlyOnceWith({
      type: 'send',
      to: ['dana@example.com', 'sam@example.com'],
      subject: 'Invoice 42',
      body: 'Attached.',
    });
    expect(host.textContent).toContain('Sending…');
    expect(field('Subject').disabled).toBe(true);
    expect(host.querySelector('button')).toBeNull();
  });

  it('shows a sent draft read only, with what was sent', () => {
    render(
      <EmailDraftWidget
        props={props}
        state={{ status: 'sent', draft: { ...props, subject: 'Final' } }}
        onAction={vi.fn()}
      />,
    );
    expect(field('Subject').value).toBe('Final');
    expect(field('Subject').disabled).toBe(true);
    expect(host.textContent).toContain('Sent');
  });

  it('lets a failed send be edited and sent again', () => {
    render(<EmailDraftWidget props={props} state={{ status: 'failed' }} onAction={vi.fn()} />);
    expect(field('Body').disabled).toBe(false);
    expect(host.textContent).toContain('Sending failed');
  });

  it('splits address lists', () => {
    expect(addressList(' a@x.com; b@y.com,\n,c@z.com ')).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
  });
});
