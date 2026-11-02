import { describe, expect, it } from 'vitest';
import {
  botWidgetKinds,
  reduceWidget,
  validateWidgetAction,
  validateWidgetProps,
  WIDGET_KIND_NAMES,
  WIDGET_KINDS,
  widgetKind,
  widgetToolCall,
  widgetToolResult,
} from './index.js';

const question = {
  question: 'Which repo?',
  options: [
    { id: 'a', label: 'openbots' },
    { id: 'b', label: 'website' },
  ],
};

describe('widget registry', () => {
  it('has a built entry for every plan 12.2 kind', () => {
    expect(Object.keys(WIDGET_KINDS).sort()).toEqual([...WIDGET_KIND_NAMES].sort());
    expect(WIDGET_KIND_NAMES.filter((k) => WIDGET_KINDS[k] === null)).toEqual([]);
    for (const kind of WIDGET_KIND_NAMES) expect(WIDGET_KINDS[kind]?.kind).toBe(kind);
    // Approvals are posted by the policy, Artifact cards by the artifact tools and event rows
    // by the system, never by a Bot.
    expect(
      botWidgetKinds()
        .map((k) => k.kind)
        .sort(),
    ).toEqual(['chart', 'email_draft', 'file', 'form', 'question', 'status_summary', 'table']);
  });

  it('falls back to null for unknown kinds', () => {
    expect(widgetKind('hologram')).toBeNull();
    expect(widgetKind('toString')).toBeNull();
    expect(validateWidgetProps('hologram', {})).toEqual({
      ok: false,
      error: 'Unknown widget kind "hologram"',
    });
  });

  it('validates props per kind', () => {
    expect(validateWidgetProps('question', question).ok).toBe(true);
    expect(validateWidgetProps('question', { question: '' }).ok).toBe(false);
    expect(validateWidgetProps('event', { event: 'blocked', text: 'No model' }).ok).toBe(true);
    expect(
      validateWidgetProps('file', { file_id: 'f1', name: 'a.pdf', mime: 'application/pdf' }).ok,
    ).toBe(true);
    expect(validateWidgetProps('file', { name: 'a.pdf' }).ok).toBe(false);
    const card = { artifact_id: 'a1', title: 'Q3 summary', kind: 'document', version: 2 };
    expect(validateWidgetProps('artifact', card).ok).toBe(true);
    expect(validateWidgetProps('artifact', { ...card, kind: 'slides' }).ok).toBe(false);
    expect(validateWidgetAction('artifact', { type: 'open' }).ok).toBe(false);
    const status = {
      title: 'Launch',
      items: [
        { label: 'Research', status: 'done', owner: 'researcher' },
        { label: 'Draft', status: 'in_progress', owner: 'writer', note: 'Due Friday' },
      ],
    };
    expect(validateWidgetProps('status_summary', status).ok).toBe(true);
    expect(validateWidgetProps('status_summary', { ...status, items: [] }).ok).toBe(false);
    expect(
      validateWidgetProps('status_summary', { title: 'x', items: [{ label: 'a', status: 'late' }] })
        .ok,
    ).toBe(false);
    expect(validateWidgetAction('status_summary', { type: 'open' }).ok).toBe(false);
  });

  it('validates actions; read-only kinds take none', () => {
    expect(validateWidgetAction('question', { type: 'answer', option_id: 'a' }).ok).toBe(true);
    expect(validateWidgetAction('question', { type: 'answer' }).ok).toBe(false);
    expect(validateWidgetAction('question', { type: 'click' }).ok).toBe(false);
    expect(validateWidgetAction('event', { type: 'answer', text: 'x' })).toEqual({
      ok: false,
      error: 'A event widget takes no actions',
    });
  });

  it('answers a question once, by option or text', () => {
    const byOption = reduceWidget(
      'question',
      undefined,
      { type: 'answer', option_id: 'b' },
      question,
    );
    expect(byOption).toEqual({
      ok: true,
      value: { status: 'answered', answer: { option_id: 'b', label: 'website' } },
    });
    expect(widgetToolResult('question', (byOption as { value: unknown }).value)).toEqual({
      answered: true,
      option_id: 'b',
      label: 'website',
    });
    const byText = reduceWidget(
      'question',
      { status: 'pending' },
      { type: 'answer', text: 'both' },
      question,
    );
    expect(byText).toEqual({ ok: true, value: { status: 'answered', answer: { text: 'both' } } });
    expect(
      reduceWidget('question', { status: 'answered' }, { type: 'answer', text: 'again' }, question),
    ).toEqual({ ok: false, error: 'This question was already answered' });
    expect(
      reduceWidget('question', undefined, { type: 'answer', option_id: 'z' }, question),
    ).toEqual({
      ok: false,
      error: 'Unknown option z',
      invalid: true,
    });
    expect(
      reduceWidget(
        'question',
        undefined,
        { type: 'answer', text: 'other' },
        { ...question, allow_text: false },
      ).ok,
    ).toBe(false);
  });

  it('decides an approval once; deny and expiry give the "Denied by owner" result', () => {
    const props = {
      tool_name: 'bash',
      args: { command: 'rm -rf build' },
      summary: '$ rm -rf build',
      reason: 'bash runs commands on the computer',
      trace: [{ rule: 'default', decision: 'ask', why: 'bash runs commands on the computer' }],
    };
    expect(validateWidgetProps('approval', props).ok).toBe(true);
    expect(validateWidgetAction('approval', { type: 'approve' }).ok).toBe(true);
    expect(validateWidgetAction('approval', { type: 'deny', note: 'not now' }).ok).toBe(true);
    expect(validateWidgetAction('approval', { type: 'expire' }).ok).toBe(false);

    const approved = reduceWidget('approval', undefined, { type: 'approve' }, props);
    expect(approved).toEqual({ ok: true, value: { status: 'approved' } });
    expect(widgetToolResult('approval', { status: 'approved' })).toEqual({ approved: true });
    expect(reduceWidget('approval', { status: 'approved' }, { type: 'deny' }, props)).toEqual({
      ok: false,
      error: 'This request was already approved',
    });
    const denied = reduceWidget(
      'approval',
      { status: 'pending' },
      { type: 'deny', note: 'no' },
      props,
    );
    expect(denied).toEqual({ ok: true, value: { status: 'denied', note: 'no' } });
    expect(widgetToolResult('approval', { status: 'denied', note: 'no' })).toEqual({
      approved: false,
      error: 'Denied by owner',
      note: 'no',
    });
    expect(widgetToolResult('approval', { status: 'expired' })).toMatchObject({
      approved: false,
      error: expect.stringContaining('Denied by owner'),
    });
    expect(reduceWidget('approval', { status: 'expired' }, { type: 'approve' }, props).ok).toBe(
      false,
    );
  });

  it('closes a sign-in request once, keeping who waits, with the result for every waiter (K8)', () => {
    const props = {
      site: 'github.com',
      url: 'https://github.com/login',
      reason: 'To open the private repository',
      requester: { bot_id: '00000000-0000-4000-8000-000000000001', handle: 'scout', name: 'Scout' },
      screen_bot_id: '00000000-0000-4000-8000-000000000002',
    };
    expect(validateWidgetProps('login_request', props).ok).toBe(true);
    expect(validateWidgetProps('login_request', { ...props, url: 'javascript:alert(1)' }).ok).toBe(
      false,
    );
    expect(validateWidgetProps('login_request', { ...props, reason: '' }).ok).toBe(false);
    expect(validateWidgetAction('login_request', { type: 'done' }).ok).toBe(true);
    expect(validateWidgetAction('login_request', { type: 'take_over' }).ok).toBe(false);

    const waiting = [{ run_id: 'r1', bot_id: props.requester.bot_id, handle: 'scout' }];
    const done = reduceWidget(
      'login_request',
      { status: 'pending', waiting },
      { type: 'done' },
      props,
    );
    expect(done).toEqual({ ok: true, value: { status: 'signed_in', waiting } });
    expect(widgetToolResult('login_request', { status: 'signed_in' })).toMatchObject({
      signed_in: true,
    });
    expect(reduceWidget('login_request', { status: 'signed_in' }, { type: 'cant' }, props)).toEqual(
      { ok: false, error: 'This sign-in request was already answered' },
    );
    const failed = reduceWidget('login_request', undefined, { type: 'cant' }, props);
    expect(failed).toEqual({ ok: true, value: { status: 'failed' } });
    expect(widgetToolResult('login_request', { status: 'failed' })).toMatchObject({
      signed_in: false,
      note: expect.stringContaining('Do not ask for their password'),
    });
    // Expired unanswered: no more answers, and every waiter is told it expired.
    expect(reduceWidget('login_request', { status: 'expired' }, { type: 'done' }, props)).toEqual({
      ok: false,
      error: 'This sign-in request expired',
    });
    expect(widgetToolResult('login_request', { status: 'expired' })).toMatchObject({
      signed_in: false,
      note: expect.stringContaining('expired before the owner answered'),
    });
  });

  it('sends an email draft once, with the edits, as a send_email call', () => {
    const props = { to: ['ada@example.com'], subject: 'Hello', body: 'Hi Ada' };
    expect(validateWidgetProps('email_draft', props).ok).toBe(true);
    expect(validateWidgetProps('email_draft', { ...props, to: [] }).ok).toBe(false);
    expect(validateWidgetAction('email_draft', { type: 'send', subject: 'Hello!' }).ok).toBe(true);

    const sent = reduceWidget('email_draft', undefined, { type: 'send', subject: 'Hello!' }, props);
    expect(sent).toEqual({
      ok: true,
      value: { status: 'sending', draft: { ...props, subject: 'Hello!' } },
    });
    expect(widgetToolCall('email_draft', (sent as { value: unknown }).value, props)).toEqual({
      toolName: 'send_email',
      args: { to: ['ada@example.com'], subject: 'Hello!', body: 'Hi Ada' },
    });
    expect(widgetToolCall('email_draft', { status: 'draft' }, props)).toBeNull();
    expect(widgetToolCall('question', { status: 'answered' }, question)).toBeNull();
    expect(reduceWidget('email_draft', { status: 'sending' }, { type: 'send' }, props)).toEqual({
      ok: false,
      error: 'This email was already sent',
    });
  });

  it('confirms a Routine proposal once, in the owner’s timezone', () => {
    const props = {
      name: 'Morning briefing',
      prompt: 'Summarize my inbox',
      trigger: { type: 'schedule', preset: { kind: 'weekdays', time: '08:00' } },
    };
    expect(validateWidgetProps('routine_proposal', props).ok).toBe(true);
    expect(
      validateWidgetProps('routine_proposal', {
        ...props,
        trigger: { type: 'schedule', preset: { kind: 'weekdays', time: '8am' } },
      }).ok,
    ).toBe(false);
    const confirmed = reduceWidget(
      'routine_proposal',
      undefined,
      { type: 'confirm', timezone: 'Europe/London' },
      props,
    );
    expect(confirmed).toEqual({
      ok: true,
      value: { status: 'confirmed', timezone: 'Europe/London' },
    });
    expect(
      reduceWidget(
        'routine_proposal',
        undefined,
        { type: 'confirm' },
        { ...props, timezone: 'Asia/Tokyo' },
      ),
    ).toEqual({ ok: true, value: { status: 'confirmed', timezone: 'Asia/Tokyo' } });
    expect(
      reduceWidget('routine_proposal', { status: 'confirmed' }, { type: 'decline' }, props).ok,
    ).toBe(false);
    expect(
      widgetToolResult('routine_proposal', {
        status: 'confirmed',
        routine_id: 'r1',
        timezone: 'UTC',
      }),
    ).toEqual({ created: true, routine_id: 'r1', timezone: 'UTC' });
    expect(widgetToolResult('routine_proposal', { status: 'declined' })).toMatchObject({
      created: false,
    });
  });

  it('runs a Routine again or pauses it from its run widget, once each', () => {
    expect(validateWidgetAction('routine_run', { type: 'run_again' }).ok).toBe(true);
    expect(validateWidgetAction('routine_run', { type: 'delete' }).ok).toBe(false);
    expect(reduceWidget('routine_run', undefined, { type: 'pause' }, {})).toEqual({
      ok: true,
      value: { paused: true },
    });
    expect(reduceWidget('routine_run', { paused: true }, { type: 'pause' }, {}).ok).toBe(false);
    expect(reduceWidget('routine_run', { rerun_run_id: 'x' }, { type: 'run_again' }, {}).ok).toBe(
      false,
    );
  });

  it('saves a Skill draft once', () => {
    const props = { skill_id: 's1', name: 'Weekly report', content: 'Use on Fridays.' };
    expect(validateWidgetProps('skill_draft', props).ok).toBe(true);
    expect(validateWidgetProps('skill_draft', { ...props, content: undefined }).ok).toBe(false);
    expect(validateWidgetAction('skill_draft', { type: 'mark_ready' }).ok).toBe(false);

    const saved = reduceWidget(
      'skill_draft',
      undefined,
      { type: 'save', name: 'Friday report', content: '1. Collect' },
      props,
    );
    expect(saved).toEqual({
      ok: true,
      value: { status: 'saved', name: 'Friday report', content: '1. Collect' },
    });
    expect(reduceWidget('skill_draft', undefined, { type: 'save' }, props)).toEqual({
      ok: true,
      value: { status: 'saved', name: 'Weekly report', content: 'Use on Fridays.' },
    });
    expect(
      reduceWidget('skill_draft', (saved as { value: unknown }).value, { type: 'save' }, props).ok,
    ).toBe(false);
    // A draft marked ready before Skills lost their status is closed too.
    expect(reduceWidget('skill_draft', { status: 'ready' }, { type: 'save' }, props).ok).toBe(
      false,
    );
  });
});
