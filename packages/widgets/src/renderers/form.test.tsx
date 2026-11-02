// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FormState } from '../kinds/form.js';
import { reduceWidget } from '../registry.js';
import { formValues, FormWidget } from './form.js';
import { Widget } from './registry.js';

// Submit posts the values, the form then shows them disabled; a reload (the
// stored state coming back as the `state` prop) shows the same thing.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
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
  title: 'Trip details',
  description: 'For the booking.',
  fields: [
    { name: 'city', label: 'City', type: 'text' as const, required: true },
    { name: 'nights', label: 'Nights', type: 'number' as const, default: 2 },
    {
      name: 'room',
      label: 'Room',
      type: 'select' as const,
      options: [
        { value: 'single', label: 'Single' },
        { value: 'double', label: 'Double' },
      ],
    },
    { name: 'notes', label: 'Notes', type: 'textarea' as const },
    { name: 'breakfast', label: 'Breakfast', type: 'checkbox' as const },
  ],
  submit_label: 'Book',
};

const field = (name: string) =>
  host.querySelector<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>(
    `[name="${name}"]`,
  )!;
const submitButton = () => host.querySelector<HTMLButtonElement>('button[type="submit"]');

function type(name: string, value: string) {
  const el = field(name);
  const proto = Object.getPrototypeOf(el) as object;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}

describe('<FormWidget>', () => {
  it('posts the values, then shows them disabled; a reload restores the same', async () => {
    // A stand-in for the action route: the kind's reducer, and the stored state.
    let stored: FormState = { status: 'open' };
    const onAction = vi.fn(async (action: unknown) => {
      const next = reduceWidget('form', stored, action, props);
      if (!next.ok) throw new Error(next.error);
      stored = next.value as FormState;
      return stored;
    });
    render(<Widget kind="form" props={props} state={stored} onAction={onAction} />);
    expect(host.querySelector('h3')!.textContent).toBe('Trip details');
    expect(field('nights').value).toBe('2');
    expect(submitButton()!.textContent).toBe('Book');

    type('city', 'Oslo');
    type('nights', '3');
    type('room', 'double');
    type('notes', 'Late arrival');
    act(() => field('breakfast').click());
    await act(async () => host.querySelector('form')!.requestSubmit());

    expect(onAction).toHaveBeenCalledExactlyOnceWith({
      type: 'submit',
      values: { city: 'Oslo', nights: 3, room: 'double', notes: 'Late arrival', breakfast: true },
    });
    expect(stored.status).toBe('submitted');
    const showsSubmitted = () => {
      expect(host.querySelector('form')!.dataset.status).toBe('submitted');
      expect(field('city').value).toBe('Oslo');
      expect(field('nights').value).toBe('3');
      expect(field('room').value).toBe('double');
      expect(field('notes').value).toBe('Late arrival');
      expect(field('breakfast').checked).toBe(true);
      for (const name of ['city', 'nights', 'room', 'notes', 'breakfast']) {
        expect(field(name).disabled).toBe(true);
      }
      expect(submitButton()).toBeNull();
      expect(host.querySelector('[role="status"]')!.textContent).toBe('Submitted');
    };
    showsSubmitted();

    // Reload: a fresh mount from the stored state, nothing local carried over.
    act(() => root!.unmount());
    host.remove();
    render(<Widget kind="form" props={props} state={stored} onAction={onAction} />);
    showsSubmitted();
  });

  it('shows the refusal and stays editable when the post fails', async () => {
    const onAction = vi.fn(async () => {
      throw new Error('City is required');
    });
    render(<FormWidget props={props} state={{ status: 'open' }} onAction={onAction} />);
    await act(async () =>
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('City is required');
    expect(field('city').disabled).toBe(false);
    expect(submitButton()!.disabled).toBe(false);
  });

  it('is read only without an action handler', () => {
    render(<FormWidget props={props} />);
    expect(field('city').disabled).toBe(true);
    expect(submitButton()!.disabled).toBe(true);
  });

  it('turns the draft into action values', () => {
    expect(
      formValues(props.fields, {
        city: 'Oslo',
        nights: '',
        room: '',
        notes: ' ',
        breakfast: false,
      }),
    ).toEqual({ city: 'Oslo', breakfast: false });
  });
});
