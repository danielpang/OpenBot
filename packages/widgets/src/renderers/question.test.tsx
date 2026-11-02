// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuestionState } from '../kinds/question.js';
import { QuestionWidget } from './question.js';

// The action flow: click or type, post the action, then stay disabled with the
// chosen answer, whether the answer came back from the post or from
// `widget.updated` through the `state` prop.

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

const props = {
  question: 'Which branch?',
  options: [
    { id: 'main', label: 'main' },
    { id: 'dev', label: 'dev' },
  ],
};
const buttons = () => [...host.querySelectorAll('button')];
const button = (label: string) => buttons().find((b) => b.textContent === label)!;

describe('<QuestionWidget>', () => {
  it('posts the chosen option, then disables itself with that answer', async () => {
    const answered: QuestionState = {
      status: 'answered',
      answer: { option_id: 'dev', label: 'dev' },
    };
    const onAction = vi.fn(async () => answered);
    render(<QuestionWidget props={props} state={{ status: 'pending' }} onAction={onAction} />);
    expect(button('dev').disabled).toBe(false);

    await act(async () => button('dev').click());

    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'answer', option_id: 'dev' });
    expect(buttons().every((b) => b.disabled)).toBe(true);
    expect(button('dev').getAttribute('aria-pressed')).toBe('true');
    expect(button('main').getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('input')).toBeNull();
  });

  it('posts a typed answer and shows it', async () => {
    const onAction = vi.fn(async () => ({ status: 'answered', answer: { text: 'staging' } }));
    render(<QuestionWidget props={props} onAction={onAction} />);
    const input = host.querySelector('input')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'staging');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => host.querySelector('form')!.requestSubmit());

    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: 'answer', text: 'staging' });
    expect(host.textContent).toContain('Answered: staging');
  });

  it('shows the refusal and stays answerable when the post fails', async () => {
    const onAction = vi.fn(async () => {
      throw new Error('This question was already answered');
    });
    render(<QuestionWidget props={props} onAction={onAction} />);
    await act(async () => button('main').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'This question was already answered',
    );
    expect(button('main').disabled).toBe(false);
  });

  it('renders an answer that arrives as state (reload or widget.updated) disabled', () => {
    render(
      <QuestionWidget
        props={props}
        state={{ status: 'answered', answer: { option_id: 'main', label: 'main' } }}
        onAction={vi.fn()}
      />,
    );
    expect(buttons().every((b) => b.disabled)).toBe(true);
    expect(button('main').getAttribute('aria-pressed')).toBe('true');
  });

  it('offers only buttons when typed answers are off', () => {
    render(<QuestionWidget props={{ ...props, allow_text: false }} onAction={vi.fn()} />);
    expect(host.querySelector('input')).toBeNull();
  });
});
