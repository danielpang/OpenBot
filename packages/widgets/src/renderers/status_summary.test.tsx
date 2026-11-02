// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { Widget } from './registry.js';
import { StatusSummaryWidget } from './status_summary.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => createRoot(host).render(ui));
  return host;
}

const props = {
  title: 'Launch week',
  summary: 'Research is in; the copy waits on it.',
  items: [
    { label: 'Competitor scan', status: 'done' as const, owner: 'researcher' },
    { label: 'Launch post', status: 'in_progress' as const, owner: 'writer', note: 'Draft 2' },
    { label: 'Hero image', status: 'blocked' as const, owner: 'designer' },
  ],
};

describe('status summary', () => {
  it('shows each row with its owner and status, and the count done', () => {
    const host = render(<StatusSummaryWidget props={props} />);
    expect(host.querySelector('h3')!.textContent).toBe('Launch week');
    expect(host.textContent).toContain('1 of 3 done');
    expect(host.textContent).toContain('Research is in; the copy waits on it.');
    const rows = [...host.querySelectorAll('li')].map((li) => li.textContent);
    expect(rows).toEqual([
      'Competitor scan@researcherDone',
      'Launch postDraft 2@writerIn progress',
      'Hero image@designerBlocked',
    ]);
    expect(host.querySelector('button')).toBeNull();
  });

  it('is registered', () => {
    const host = render(<Widget kind="status_summary" props={props} />);
    expect(host.querySelector('[data-widget="status_summary"]')).not.toBeNull();
  });
});
