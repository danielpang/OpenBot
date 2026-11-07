import { describe, expect, it } from 'vitest';
import {
  reduceWidget,
  validateBotWidget,
  validateWidgetAction,
  validateWidgetProps,
  widgetToolResult,
} from '../index.js';
import { codingSessionWidget, type CodingSessionState } from './coding_session.js';
import { coderLoginWidget } from './coder_login.js';

// The coding agent widgets (CA3, CA5, I8): props, the owner's actions and
// what the waiting run is told.

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('coding_session widget', () => {
  const props = {
    session_id: ID(1),
    agent: 'claude',
    repo: 'openbots/relay',
    branch: 'bot/fix-reconnect',
    base: 'main',
    mode: 'edit',
    prompt_excerpt: 'Fix the reconnect loop in the relay',
  };
  const at = (status: CodingSessionState['status']): CodingSessionState => ({
    status,
    feed: [],
    approvals: [],
  });

  it('validates its props and actions, and only the system posts it', () => {
    expect(validateWidgetProps('coding_session', props).ok).toBe(true);
    expect(validateWidgetProps('coding_session', { ...props, agent: 'cursor' }).ok).toBe(false);
    expect(validateWidgetProps('coding_session', { ...props, mode: 'merge' }).ok).toBe(false);
    expect(
      validateWidgetProps('coding_session', { ...props, prompt_excerpt: 'x'.repeat(301) }).ok,
    ).toBe(false);
    expect(validateBotWidget('coding_session', props).ok).toBe(false);
    for (const action of [
      { type: 'stop' },
      { type: 'continue', prompt: 'Also add a test' },
      { type: 'discard' },
      { type: 'open_terminal' },
    ]) {
      expect(validateWidgetAction('coding_session', action).ok, action.type).toBe(true);
    }
    expect(validateWidgetAction('coding_session', { type: 'continue', prompt: '' }).ok).toBe(false);
    expect(
      validateWidgetAction('coding_session', { type: 'continue', prompt: 'x'.repeat(4_001) }).ok,
    ).toBe(false);
    expect(validateWidgetAction('coding_session', { type: 'merge' }).ok).toBe(false);
  });

  it('starts queued with an empty feed', () => {
    expect(codingSessionWidget.initialState!(codingSessionWidget.props.parse(props))).toEqual({
      ...at('queued'),
      session_id: props.session_id,
    });
  });

  it('stops a session that has not ended, once', () => {
    for (const status of ['queued', 'starting', 'running', 'waiting'] as const) {
      expect(reduceWidget('coding_session', at(status), { type: 'stop' }, props)).toEqual({
        ok: true,
        value: { ...at(status), status: 'stopped', control: 'stop' },
      });
    }
    for (const status of ['settled', 'failed', 'stopped'] as const) {
      expect(reduceWidget('coding_session', at(status), { type: 'stop' }, props)).toEqual({
        ok: false,
        error: 'This session already ended',
      });
    }
  });

  it('continues and discards only a session that ended', () => {
    const next = reduceWidget(
      'coding_session',
      at('settled'),
      { type: 'continue', prompt: 'Also add a test\n for the timeout' },
      props,
    );
    expect(next).toMatchObject({
      ok: true,
      value: {
        status: 'queued',
        control: 'continue',
        feed: [{ type: 'text', text: 'Continue: Also add a test for the timeout' }],
      },
    });
    expect(
      reduceWidget('coding_session', at('running'), { type: 'continue', prompt: 'more' }, props),
    ).toMatchObject({ ok: false });
    expect(reduceWidget('coding_session', at('failed'), { type: 'discard' }, props)).toEqual({
      ok: true,
      value: { ...at('failed'), control: 'discard' },
    });
    expect(reduceWidget('coding_session', at('running'), { type: 'discard' }, props)).toMatchObject(
      { ok: false },
    );
  });

  it('keeps the feed to its cap when continuing', () => {
    const feed = Array.from({ length: 200 }, (_, i) => ({
      t: '2026-11-05T10:00:00.000Z',
      type: 'text' as const,
      text: `line ${i}`,
    }));
    const next = reduceWidget(
      'coding_session',
      { ...at('stopped'), feed },
      { type: 'continue', prompt: 'Go on' },
      props,
    );
    const value = (next as { value: CodingSessionState }).value;
    expect(value.feed).toHaveLength(200);
    expect(value.feed[0]!.text).toBe('line 1');
    expect(value.feed.at(-1)!.text).toBe('Continue: Go on');
  });

  it('leaves the state alone for Open terminal, the client action', () => {
    const state = at('running');
    expect(reduceWidget('coding_session', state, { type: 'open_terminal' }, props)).toEqual({
      ok: true,
      value: state,
    });
  });

  it('gives the run a compact result with how to continue', () => {
    const changed = Array.from({ length: 60 }, (_, i) => ({
      path: `f${i}.ts`,
      added: 1,
      removed: 0,
      kind: 'edit' as const,
    }));
    const commits = Array.from({ length: 25 }, (_, i) => ({ sha: `s${i}`, title: `c${i}` }));
    const outcome = widgetToolResult('coding_session', {
      ...at('settled'),
      feed: [{ t: '2026-11-05T10:00:00.000Z', type: 'text', text: 'not for the model' }],
      result: {
        summary: 'Fixed the reconnect loop',
        changed_files: changed,
        commits,
        branch: 'bot/fix-reconnect',
        base: 'main',
        worktree_path: '/home/bot/repos/openbots/relay/.worktrees/bot-fix-reconnect',
        usage: { input_tokens: 10, output_tokens: 5, billed: 'subscription' },
      },
    }) as Record<string, unknown>;
    expect(outcome).toMatchObject({
      status: 'settled',
      summary: 'Fixed the reconnect loop',
      branch: 'bot/fix-reconnect',
      base: 'main',
      pr_url: null,
      usage: { input_tokens: 10, output_tokens: 5, billed: 'subscription' },
      error: null,
      note: expect.stringContaining('call code_task with session_id'),
    });
    expect(outcome.changed_files).toHaveLength(50);
    expect(outcome.commits).toHaveLength(20);
    expect(outcome).not.toHaveProperty('feed');
    // The session's id is in the note, so the Bot continues the right one.
    expect(
      widgetToolResult('coding_session', { ...at('settled'), session_id: props.session_id }),
    ).toMatchObject({
      session_id: props.session_id,
      note: expect.stringContaining(
        `To continue this session call code_task with session_id ${props.session_id}`,
      ),
    });
    expect(
      widgetToolResult('coding_session', { ...at('failed'), error: 'Rate limited' }),
    ).toMatchObject({ status: 'failed', summary: null, error: 'Rate limited', changed_files: [] });
  });
});

describe('coder_login widget', () => {
  const props = {
    login_id: ID(2),
    agent: 'codex',
    url: 'https://auth.openai.com/codex/device',
    device_code: 'ABCD-1234',
    instructions: 'Open the link, enter the code, then come back.',
    waiting: [{ bot_id: ID(3), handle: 'scout', name: 'Scout' }],
  };

  it('validates its props and actions, and only the system posts it', () => {
    expect(validateWidgetProps('coder_login', props).ok).toBe(true);
    expect(validateWidgetProps('coder_login', { ...props, url: 'javascript:alert(1)' }).ok).toBe(
      false,
    );
    expect(validateWidgetProps('coder_login', { ...props, instructions: '' }).ok).toBe(false);
    expect(validateBotWidget('coder_login', props).ok).toBe(false);
    expect(validateWidgetAction('coder_login', { type: 'code', code: 'abcd1234' }).ok).toBe(true);
    expect(validateWidgetAction('coder_login', { type: 'code', code: 'abc' }).ok).toBe(false);
    expect(validateWidgetAction('coder_login', { type: 'api_key' }).ok).toBe(true);
    expect(validateWidgetAction('coder_login', { type: 'done' }).ok).toBe(false);
  });

  it('records the answer and leaves the rest to the server', () => {
    expect(coderLoginWidget.initialState!(coderLoginWidget.props.parse(props))).toEqual({
      status: 'pending',
      agent: 'codex',
    });
    expect(
      reduceWidget('coder_login', undefined, { type: 'code', code: 'abcd1234' }, props),
    ).toEqual({
      ok: true,
      value: { status: 'awaiting_code', agent: 'codex', code_submitted: true },
    });
    // A second code while the first is checked replaces it.
    expect(
      reduceWidget(
        'coder_login',
        { status: 'awaiting_code' },
        { type: 'code', code: 'efgh5678' },
        props,
      ),
    ).toMatchObject({ ok: true, value: { status: 'awaiting_code' } });
    expect(reduceWidget('coder_login', { status: 'pending' }, { type: 'cant' }, props)).toEqual({
      ok: true,
      value: { status: 'failed' },
    });
    expect(reduceWidget('coder_login', { status: 'pending' }, { type: 'api_key' }, props)).toEqual({
      ok: true,
      value: { status: 'cancelled', wants_api_key: true },
    });
    for (const status of ['signed_in', 'failed', 'expired', 'cancelled'] as const) {
      expect(reduceWidget('coder_login', { status }, { type: 'cant' }, props)).toMatchObject({
        ok: false,
      });
    }
  });

  it('tells the run whether to try again, never to ask for credentials', () => {
    expect(widgetToolResult('coder_login', { status: 'signed_in', agent: 'claude' })).toEqual({
      signed_in: true,
      note: 'The owner signed in to Claude Code. Start the coding task again.',
    });
    for (const state of [
      { status: 'failed' },
      { status: 'expired' },
      { status: 'cancelled', wants_api_key: true },
    ]) {
      expect(widgetToolResult('coder_login', state)).toMatchObject({
        signed_in: false,
        note: expect.stringContaining('Do not ask for their password'),
      });
    }
  });
});
