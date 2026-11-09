// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoderLoginProps, CoderLoginWidgetState } from '../kinds/coder_login.js';
import { CoderLoginWidget } from './coder_login.js';

// The sign-in widget (CA3): the link with Copy and Open link, a device code
// when the agent gives one, a field for the code to paste back, then Use an
// API key and Can't sign in; each status after that in words.

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

const URL = 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=k3Wq';
const props: CoderLoginProps = {
  login_id: '00000000-0000-4000-8000-0000000000e1',
  agent: 'claude',
  url: URL,
  instructions:
    'Open this link on any device, sign in to Claude, then paste the code it gives you.',
};
const buttons = () => [...host.querySelectorAll('button')];
const button = (label: string) => buttons().find((b) => b.textContent === label);

function type(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('<CoderLoginWidget>', () => {
  it('draws the sign-in link as a QR code with Show QR, and hides it again', async () => {
    render(<CoderLoginWidget props={props} state={{ status: 'pending' }} onAction={vi.fn()} />);
    expect(host.querySelector('img')).toBeNull();
    const show = button('Show QR')!;
    expect(show.getAttribute('aria-pressed')).toBe('false');
    act(() => show.click());
    await vi.waitFor(() => expect(host.querySelector('img')).not.toBeNull());
    const img = host.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('QR code for signing in to Claude Code');
    const svg = decodeURIComponent(img.getAttribute('src')!.split(',')[1]!);
    expect(svg).toMatch(/^<svg/);
    expect(button('Hide QR')!.getAttribute('aria-pressed')).toBe('true');
    act(() => button('Hide QR')!.click());
    expect(host.querySelector('img')).toBeNull();
    expect(button('Show QR')).toBeDefined();
  });

  it('offers no QR before the link shows', () => {
    render(
      <CoderLoginWidget
        props={{ ...props, url: undefined }}
        state={{ status: 'pending' }}
        onAction={vi.fn()}
      />,
    );
    expect(button('Show QR')).toBeUndefined();
  });

  it('shows the instructions, the link with Copy and Open link, and the code field', () => {
    render(<CoderLoginWidget props={props} state={{ status: 'pending' }} onAction={vi.fn()} />);
    expect(host.textContent).toContain('Sign in to Claude Code');
    expect(host.textContent).not.toContain('billed to');
    expect(host.textContent).toContain(props.instructions);
    expect(host.querySelector('[data-sign-in-url]')?.textContent).toBe(URL);
    expect(button('Copy')).toBeDefined();
    const open = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Open link')!;
    expect(open.getAttribute('href')).toBe(URL);
    expect(open.getAttribute('target')).toBe('_blank');
    expect(host.querySelector('input[aria-label="Code"]')).not.toBeNull();
    expect(button('Use an API key')).toBeDefined();
    expect(button("Can't sign in")).toBeDefined();
    expect(host.textContent).not.toContain('Take over');
    expect(host.textContent).not.toMatch(/[–—]| - /);
  });

  it('copies the link', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CoderLoginWidget props={props} onAction={vi.fn()} />);
    await act(async () => button('Copy')!.click());
    expect(writeText).toHaveBeenCalledWith(URL);
    expect(button('Copied')).toBeDefined();
  });

  it("shows Codex's device code, with no paste field", () => {
    render(
      <CoderLoginWidget
        props={{ ...props, agent: 'codex', url: 'https://auth.openai.com/device' }}
        state={{ status: 'pending', device_code: 'ABCD-1234' }}
        onAction={vi.fn()}
      />,
    );
    expect(host.textContent).not.toContain('billed to');
    expect(host.querySelector('[data-device-code]')?.textContent).toBe('ABCD-1234');
    expect(host.querySelector('input[aria-label="Code"]')).toBeNull();
  });

  it('shows the device code large with no paste field, pending or awaiting_code', () => {
    for (const status of ['pending', 'awaiting_code'] as const) {
      render(
        <CoderLoginWidget
          props={{ ...props, agent: 'codex', url: 'https://auth.openai.com/device' }}
          state={{ status, device_code: 'WXYZ-9876' }}
          onAction={vi.fn()}
        />,
      );
      const code = host.querySelector('[data-device-code]')!;
      expect(code.textContent).toBe('WXYZ-9876');
      expect(code.className).toContain('text-2xl');
      expect(host.querySelector('[data-device-note]')?.textContent).toBe(
        'Enter this code on the OpenAI page; nothing to paste back here.',
      );
      expect(host.querySelector('input[aria-label="Code"]')).toBeNull();
      expect(button('Done')).toBeUndefined();
      expect(button('Copy code')).toBeDefined();
      expect(host.textContent).not.toMatch(/[–—]| - /);
      act(() => root?.unmount());
      host.remove();
    }
    root = undefined;
  });

  it('waits for the link while the login has not printed one', () => {
    render(<CoderLoginWidget props={{ ...props, url: undefined }} state={{ status: 'pending' }} />);
    expect(host.textContent).toContain('Waiting for Claude Code to show its sign-in link');
  });

  it('sends the pasted code with Done, then says it is checking it', async () => {
    const onAction = vi.fn(async () => undefined);
    render(<CoderLoginWidget props={props} state={{ status: 'pending' }} onAction={onAction} />);
    expect(button('Done')!.disabled).toBe(true);
    type(host.querySelector<HTMLInputElement>('input[aria-label="Code"]')!, '  abcd-efgh  ');
    await act(async () => button('Done')!.closest('form')!.requestSubmit());
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'code', code: 'abcd-efgh' });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'Checking the code with Claude Code…',
    );
  });

  it('still shows the link and the paste field once the login asks for the code', () => {
    // The Claude CLI prints the link and asks for the code at once, so the
    // server moves to awaiting_code before the owner has done anything.
    render(
      <CoderLoginWidget props={props} state={{ status: 'awaiting_code' }} onAction={vi.fn()} />,
    );
    expect(host.querySelector('[data-sign-in-url]')?.textContent).toBe(URL);
    expect(button('Copy')).toBeDefined();
    expect([...host.querySelectorAll('a')].some((a) => a.textContent === 'Open link')).toBe(true);
    expect(host.querySelector('input[aria-label="Code"]')).not.toBeNull();
    expect(button('Done')).toBeDefined();
    expect(host.textContent).not.toContain('Checking the code');
  });

  it('checks a code sent in awaiting_code until the status moves on, and shows a wrong code', async () => {
    const onAction = vi.fn(async () => undefined);
    render(
      <CoderLoginWidget props={props} state={{ status: 'awaiting_code' }} onAction={onAction} />,
    );
    type(host.querySelector<HTMLInputElement>('input[aria-label="Code"]')!, 'abcd-efgh');
    await act(async () => button('Done')!.closest('form')!.requestSubmit());
    expect(host.textContent).toContain('Checking the code with Claude Code…');
    expect(host.querySelector('input[aria-label="Code"]')).toBeNull();
    // The server says the code was wrong: the field comes back with why.
    act(() =>
      root!.render(
        <CoderLoginWidget
          props={props}
          state={{ status: 'awaiting_code', error: 'That code did not work. Try again.' }}
          onAction={onAction}
        />,
      ),
    );
    expect(host.textContent).not.toContain('Checking the code');
    expect(host.querySelector('input[aria-label="Code"]')).not.toBeNull();
    expect(host.textContent).toContain('That code did not work. Try again.');
  });

  it('chooses an API key and goes to Settings > Coding agents', async () => {
    const onAction = vi.fn(async () => ({ status: 'cancelled', wants_api_key: true }));
    const onNavigate = vi.fn();
    render(<CoderLoginWidget props={props} onAction={onAction} onNavigate={onNavigate} />);
    await act(async () => button('Use an API key')!.click());
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'api_key' });
    expect(onNavigate).toHaveBeenCalledWith('/settings/coding-agents');
    expect(host.textContent).toContain('You chose an API key instead');
    expect(buttons()).toEqual([]);
  });

  it("answers Can't sign in", async () => {
    const onAction = vi.fn(async () => undefined);
    render(<CoderLoginWidget props={props} onAction={onAction} />);
    await act(async () => button("Can't sign in")!.click());
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'cant' });
    expect(host.textContent).toContain('Not signed in to Claude Code.');
  });

  it.each<[CoderLoginWidgetState, string]>([
    [
      { status: 'signed_in', account_label: 'dan@example.com' },
      'Signed in to Claude Code as dan@example.com.',
    ],
    [{ status: 'signed_in' }, 'Signed in to Claude Code.'],
    [{ status: 'expired' }, 'This sign-in expired before it was finished. The Bot was told.'],
    [
      { status: 'failed', error: 'The code was wrong' },
      'Not signed in to Claude Code. The Bot was told.',
    ],
    [{ status: 'cancelled' }, 'This sign-in was cancelled.'],
  ])('says how it ended: %o', (state, words) => {
    render(<CoderLoginWidget props={props} state={state} onAction={vi.fn()} />);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(words);
    expect(buttons()).toEqual([]);
    if (state.error) expect(host.textContent).toContain(state.error);
  });

  it('follows the state from widget.updated over its own reply', async () => {
    const onAction = vi.fn(async () => undefined);
    render(<CoderLoginWidget props={props} state={{ status: 'pending' }} onAction={onAction} />);
    await act(async () => button("Can't sign in")!.click());
    act(() =>
      root!.render(
        <CoderLoginWidget props={props} state={{ status: 'signed_in' }} onAction={onAction} />,
      ),
    );
    expect(host.textContent).toContain('Signed in to Claude Code.');
  });

  it('lists the other Bots waiting and shows why an answer failed', async () => {
    const onAction = vi.fn(async () => {
      throw new Error('This sign-in is already done');
    });
    render(
      <CoderLoginWidget
        props={{
          ...props,
          waiting: [
            { bot_id: '00000000-0000-4000-8000-00000000000b', handle: 'scout', name: 'Scout' },
          ],
        }}
        onAction={onAction}
      />,
    );
    expect(host.textContent).toContain('Waiting: @scout');
    await act(async () => button("Can't sign in")!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('This sign-in is already done');
  });
});
