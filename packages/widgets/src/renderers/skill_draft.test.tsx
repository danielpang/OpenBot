// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillDraftWidget } from './skill_draft.js';

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

const props = { skill_id: 's1', name: 'Weekly report', content: '1. List merged PRs' };
const field = (label: string) =>
  host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;

describe('<SkillDraftWidget>', () => {
  it('saves the edited name and content, then closes', async () => {
    const onAction = vi.fn(async (action: unknown) => {
      const a = action as { name: string; content: string };
      return { status: 'saved', name: a.name, content: a.content };
    });
    render(<SkillDraftWidget props={props} state={{ status: 'draft' }} onAction={onAction} />);
    expect(field('Skill content').value).toBe('1. List merged PRs');
    type(field('Skill name'), 'Friday report');
    type(field('Skill content'), '1. List merged PRs\n2. Summarize');
    await act(async () => button('Save').click());
    expect(onAction).toHaveBeenLastCalledWith({
      type: 'save',
      name: 'Friday report',
      content: '1. List merged PRs\n2. Summarize',
    });
    expect(host.textContent).toContain('Saved. Edit it in the Skills library.');
    expect(field('Skill content').disabled).toBe(true);
    expect(button('Save')).toBeUndefined();
  });

  it('shows why the server refused', async () => {
    const onAction = vi.fn(async () => {
      throw new Error('This Skill was deleted');
    });
    render(<SkillDraftWidget props={props} onAction={onAction} />);
    await act(async () => button('Save').click());
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('This Skill was deleted');
    expect(field('Skill content').disabled).toBe(false);
  });

  it('shows a saved Skill read only, as saved', () => {
    render(
      <SkillDraftWidget
        props={props}
        state={{ status: 'saved', name: 'Final', content: 'Done' }}
        onAction={vi.fn()}
      />,
    );
    expect(field('Skill name').value).toBe('Final');
    expect(field('Skill content').value).toBe('Done');
    expect(field('Skill name').disabled).toBe(true);
    expect(host.querySelector('button')).toBeNull();
  });
});
