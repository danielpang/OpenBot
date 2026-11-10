import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentOrb, sessionActivity } from './agent-orb.js';

describe('coding agent activity', () => {
  it('shows thinking before an action and searching for grep', () => {
    expect(sessionActivity('running', [])).toEqual({ label: 'Thinking…', state: 'shaping' });
    expect(
      sessionActivity('running', [
        {
          seq: 1,
          turn: 1,
          at: '',
          event: { type: 'tool_use', name: 'grep', summary: 'find handlers' },
        },
      ]),
    ).toEqual({ label: 'Working · grep', state: 'searching' });
  });
  it('stops on completed turns and pauses while waiting', () => {
    for (const status of ['settled', 'failed', 'stopped'] as const)
      expect(sessionActivity(status, [])).toBeNull();
    expect(sessionActivity('waiting', [])?.state).toBe('paused');
    expect(sessionActivity('queued', [])?.state).toBe('paused');
  });
  it('announces its label without exposing the decorative SVG', () => {
    const html = renderToStaticMarkup(<AgentOrb label="Thinking…" state="shaping" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('Thinking…');
  });
});
