// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoderChoiceProps } from '../kinds/coder_choice.js';
import { CoderChoiceWidget } from './coder_choice.js';

// The owner picks an agent and a model (CA9): the agent first offered, its
// model filled in, switching agents switches the model, then Start posts the
// choice and the card says what was chosen.

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

const props: CoderChoiceProps = {
  agents: [
    { agent: 'claude', signed_in: true, model: 'sonnet' },
    { agent: 'codex', signed_in: false },
  ],
  repo: 'openbots/relay',
};
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text))!;
const model = () => host.querySelector<HTMLInputElement>('input[aria-label="Model"]')!;
const remember = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('<CoderChoiceWidget>', () => {
  it('offers the signed-in agent with its model, and posts the choice', async () => {
    const onAction = vi.fn(async (action: unknown) => ({
      status: 'chosen',
      ...(action as object),
    }));
    render(<CoderChoiceWidget props={props} onAction={onAction} />);
    expect(button('Claude Code').getAttribute('aria-checked')).toBe('true');
    expect(button('Codex').textContent).toContain('(sign in)');
    expect(model().value).toBe('sonnet');
    expect(remember().checked).toBe(true);

    await act(async () => button('Codex').click());
    expect(model().value).toBe('gpt-5.3-codex');
    act(() => remember().click());
    await act(async () => button('Start').closest('form')!.requestSubmit());

    expect(onAction).toHaveBeenCalledExactlyOnceWith({
      type: 'choose',
      agent: 'codex',
      model: 'gpt-5.3-codex',
      remember: false,
    });
    expect(host.textContent).toContain('Chose Codex with gpt-5.3-codex.');
  });

  it('will not start without a valid model, and Cancel declines', async () => {
    const onAction = vi.fn(async () => ({ status: 'cancelled' }));
    render(<CoderChoiceWidget props={props} onAction={onAction} />);
    act(() => type(model(), '--yolo'));
    expect(button('Start').disabled).toBe(true);
    await act(async () => button('Cancel').click());
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'cancel' });
    expect(host.textContent).toContain('Not started.');
  });

  it('shows a choice already made, saved as the default', () => {
    render(
      <CoderChoiceWidget
        props={props}
        state={{ status: 'chosen', agent: 'claude', model: 'opus', remember: true }}
      />,
    );
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).toContain('Chose Claude Code with opus, saved as your default.');
  });
});
