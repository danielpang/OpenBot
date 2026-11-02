// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Widget } from './registry.js';
import { runDuration } from './routine_run.js';

// The three Routine widgets (R3, R5): Confirm on a proposal sends the
// owner's timezone, the created card links to the Routines tab, every run
// offers Pause and the activity log, and a failed one Run again too.

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

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;

const proposal = {
  name: 'Morning briefing',
  prompt: 'Summarize my inbox',
  trigger: { type: 'schedule', preset: { kind: 'weekdays', time: '08:00' } },
  timezone: 'Europe/London',
};

const ids = {
  routine_id: '00000000-0000-4000-8000-000000000001',
  routine_run_id: '00000000-0000-4000-8000-000000000002',
  bot_id: '00000000-0000-4000-8000-000000000003',
  run_id: '00000000-0000-4000-8000-000000000004',
};

describe('routine widgets', () => {
  it('confirms a proposal in its timezone, then shows it was created', async () => {
    const onAction = vi.fn(async () => ({ status: 'confirmed', timezone: 'Europe/London' }));
    render(<Widget kind="routine_proposal" props={proposal} onAction={onAction} />);
    expect(host.textContent).toContain('Create Routine “Morning briefing”?');
    expect(host.textContent).toContain('Weekdays at 08:00 · Europe/London');

    await act(async () => button('Create Routine').click());

    expect(onAction).toHaveBeenCalledExactlyOnceWith({
      type: 'confirm',
      timezone: 'Europe/London',
    });
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).toContain('Created');
  });

  it('shows an answered proposal without its buttons', () => {
    render(<Widget kind="routine_proposal" props={proposal} state={{ status: 'declined' }} />);
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).toContain('Declined');
  });

  it('links a created Routine to the Routines tab', async () => {
    const onNavigate = vi.fn();
    render(
      <Widget
        kind="routine_created"
        props={{
          routine_id: ids.routine_id,
          bot_id: ids.bot_id,
          name: 'Morning briefing',
          trigger: { type: 'schedule', cron: '0 8 * * 1-5', preset: proposal.trigger.preset },
          timezone: 'Europe/London',
          next_run_at: '2026-10-19T07:00:00.000Z',
        }}
        onNavigate={onNavigate}
      />,
    );
    expect(host.textContent).toContain('Weekdays at 08:00 (Europe/London)');
    await act(async () => host.querySelector('a')!.click());
    expect(onNavigate).toHaveBeenCalledWith(`/bots/${ids.bot_id}/routines`);
  });

  it('offers the exception actions and the activity log on a failed run', async () => {
    const onAction = vi.fn(async (action: unknown) =>
      (action as { type: string }).type === 'pause' ? { paused: true } : { rerun_run_id: 'r2' },
    );
    const onOpenActivity = vi.fn();
    render(
      <Widget
        kind="routine_run"
        props={{
          ...ids,
          name: 'Morning briefing',
          outcome: 'failed',
          reason: 'schedule',
          started_at: '2026-10-19T07:00:00.000Z',
          finished_at: '2026-10-19T07:00:42.000Z',
          exception: 'The provider is down',
        }}
        onAction={onAction}
        onOpenActivity={onOpenActivity}
      />,
    );
    expect(host.textContent).toContain('Morning briefing failed');
    expect(host.textContent).toContain('The provider is down');
    expect(host.textContent).toContain('42s');

    await act(async () => button('Activity log').click());
    expect(onOpenActivity).toHaveBeenCalledWith(ids.run_id);
    await act(async () => button('Run again').click());
    expect(button('Started again').disabled).toBe(true);
    await act(async () => button('Pause Routine').click());
    expect(button('Routine paused').disabled).toBe(true);
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([
      { type: 'run_again' },
      { type: 'pause' },
    ]);
  });

  it('offers Pause on a completed run, but nothing to run again (plan 10.2)', async () => {
    const onAction = vi.fn(async () => ({ paused: true }));
    render(
      <Widget
        kind="routine_run"
        props={{
          ...ids,
          name: 'Morning briefing',
          outcome: 'completed',
          reason: 'run_now',
          started_at: '2026-10-19T07:00:00.000Z',
          finished_at: '2026-10-19T07:03:00.000Z',
        }}
        onAction={onAction}
      />,
    );
    expect(host.textContent).toContain('Morning briefing ran');
    expect(host.textContent).not.toContain('Run again');
    await act(async () => button('Pause Routine').click());
    expect(button('Routine paused').disabled).toBe(true);
    expect(onAction).toHaveBeenCalledWith({ type: 'pause' });
    expect(runDuration('2026-10-19T07:00:00Z', '2026-10-19T07:03:00Z')).toBe('3 min');
  });
});
