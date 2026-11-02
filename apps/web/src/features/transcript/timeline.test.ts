import { describe, expect, it } from 'vitest';
import type { Message } from './api.js';
import {
  applyApprovalResolved,
  applyCompleted,
  applyDelta,
  applyWidgetState,
  emptyTimeline,
  focusSeqSearch,
  messagesOf,
  newestSeq,
  oldestSeq,
  upsertMessages,
  type Timeline,
} from './timeline.js';

const message = (seq: number, over: Partial<Message> = {}): Message => ({
  id: `m${seq}`,
  chatId: 'c',
  seq,
  threadRootId: null,
  authorType: 'bot',
  authorId: 'b',
  parts: [],
  mentions: [],
  mentionEveryone: false,
  runId: 'r',
  status: 'complete',
  deltaSeq: 0,
  updatedSeq: seq,
  createdAt: '2026-10-16T00:00:00.000Z',
  ...over,
});

const text = (t: Timeline, id: string) =>
  t.byId[id]!.parts.map((p) => ('text' in p ? `${p.type}:${p.text}` : p.type));

const delta = (deltaSeq: number, text: string, partIndex = 0, type = 'text') => ({
  messageId: 'm3',
  deltaSeq,
  deltas: [{ partIndex, type, text }],
});

describe('transcript timeline', () => {
  it('keeps messages in seq order whatever order they arrive in, once each', () => {
    let t = upsertMessages(emptyTimeline, [message(5), message(4)]);
    t = upsertMessages(t, [message(1), message(3)]);
    t = upsertMessages(t, [message(4), message(6), message(2)]);
    expect(t.order).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(messagesOf(t).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect([oldestSeq(t), newestSeq(t)]).toEqual([1, 6]);
  });

  it('applies the streamed sequence: created, deltas, completed', () => {
    let t = upsertMessages(emptyTimeline, [message(3, { status: 'streaming' })]);
    for (const d of [delta(1, 'Hel'), delta(2, 'lo'), delta(3, 'hmm', 1, 'reasoning')]) {
      const r = applyDelta(t, d);
      expect(r.gap).toBe(false);
      t = r.timeline;
    }
    const tool = { type: 'tool_call', tool_call_id: 'x', tool_name: 'bash', args: {} } as const;
    t = applyDelta(t, {
      messageId: 'm3',
      deltaSeq: 4,
      deltas: [{ partIndex: 2, type: 'tool_call', text: '', part: tool }],
    }).timeline;
    expect(text(t, 'm3')).toEqual(['text:Hello', 'reasoning:hmm', 'tool_call']);
    expect(t.byId.m3!.deltaSeq).toBe(4);

    const done = applyCompleted(t, { messageId: 'm3', status: 'complete', deltaSeq: 4 });
    expect(done.gap).toBe(false);
    expect(done.timeline.byId.m3!.status).toBe('complete');
  });

  it('ignores replayed deltas and duplicate events', () => {
    let t = upsertMessages(emptyTimeline, [message(3, { status: 'streaming' })]);
    t = applyDelta(t, delta(1, 'A')).timeline;
    t = applyDelta(t, delta(2, 'B')).timeline;
    const replayed = [delta(1, 'A'), delta(2, 'B'), delta(2, 'B')].reduce(
      (acc, d) => applyDelta(acc, d).timeline,
      t,
    );
    expect(text(replayed, 'm3')).toEqual(['text:AB']);
    expect(replayed).toBe(t);

    // A late `message.created` (deltaSeq 0) does not roll the message back.
    const late = upsertMessages(t, [message(3, { status: 'streaming' })]);
    expect(text(late, 'm3')).toEqual(['text:AB']);
  });

  it('takes a REST or resync copy that is further along, and applies later deltas on top', () => {
    let t = upsertMessages(emptyTimeline, [message(3, { status: 'streaming' })]);
    t = applyDelta(t, delta(1, 'A')).timeline;
    t = upsertMessages(t, [
      message(3, { status: 'streaming', deltaSeq: 3, parts: [{ type: 'text', text: 'ABC' }] }),
    ]);
    expect(applyDelta(t, delta(3, 'C')).timeline).toBe(t);
    t = applyDelta(t, delta(4, 'D')).timeline;
    expect(text(t, 'm3')).toEqual(['text:ABCD']);
  });

  it('reports a gap instead of applying a delta that skips a number or has no message', () => {
    let t = upsertMessages(emptyTimeline, [message(3, { status: 'streaming' })]);
    t = applyDelta(t, delta(1, 'A')).timeline;
    const skipped = applyDelta(t, delta(3, 'C'));
    expect(skipped).toEqual({ timeline: t, gap: true });
    expect(applyDelta(emptyTimeline, delta(1, 'A')).gap).toBe(true);
    const completed = applyCompleted(t, { messageId: 'm3', status: 'complete', deltaSeq: 5 });
    expect(completed.gap).toBe(true);
    expect(completed.timeline.byId.m3!.status).toBe('streaming');
  });

  it('applies widget state to the widget part only', () => {
    const widget = {
      type: 'widget',
      kind: 'question',
      props: { question: 'Q?' },
      state: { status: 'pending' },
    } as const;
    const t = upsertMessages(emptyTimeline, [
      message(3, { parts: [{ type: 'text', text: 'x' }, widget] }),
    ]);
    const answered = { status: 'answered', answer: { text: 'yes' } };
    const next = applyWidgetState(t, { messageId: 'm3', partIndex: 1, state: answered });
    expect(next.byId.m3!.parts[1]).toEqual({ ...widget, state: answered });
    expect(applyWidgetState(t, { messageId: 'm3', partIndex: 0, state: answered })).toBe(t);
    expect(applyWidgetState(t, { messageId: 'nope', partIndex: 1, state: answered })).toBe(t);
  });

  it('adds who decided an approval, and never reopens one', () => {
    const widget = {
      type: 'widget' as const,
      kind: 'approval',
      props: { tool_name: 'bash', args: {}, reason: null },
      state: { status: 'approved' },
    };
    const t = upsertMessages(emptyTimeline, [
      message(3, { parts: [{ type: 'text', text: 'x' }, widget] }),
    ]);
    const resolved = {
      messageId: 'm3',
      status: 'approved',
      note: 'ok',
      decidedBy: 'u1',
      decidedAt: '2026-10-18T00:00:00.000Z',
    };
    expect(applyApprovalResolved(t, resolved).byId.m3!.parts[1]).toEqual({
      ...widget,
      state: { status: 'approved', note: 'ok', decidedBy: 'u1', decidedAt: resolved.decidedAt },
    });
    expect(applyApprovalResolved(t, { ...resolved, status: 'pending' })).toBe(t);
    expect(applyApprovalResolved(t, { ...resolved, messageId: 'nope' })).toBe(t);
    expect(applyApprovalResolved(t, { ...resolved, messageId: null })).toBe(t);
  });
});

describe('focusSeqSearch', () => {
  it('keeps a positive integer seq and drops anything else', () => {
    expect(focusSeqSearch({ seq: '12' })).toEqual({ seq: 12 });
    expect(focusSeqSearch({ seq: 3 })).toEqual({ seq: 3 });
    for (const seq of [undefined, '', '0', '-1', '1.5', 'abc']) {
      expect(focusSeqSearch({ seq })).toEqual({});
    }
  });

  it('keeps a thread root id and drops anything that is not one', () => {
    const root = '0B3F8A52-1C1E-4B9A-9D55-3F2A8C6E7D10';
    expect(focusSeqSearch({ seq: '4', thread: root })).toEqual({
      seq: 4,
      thread: root.toLowerCase(),
    });
    for (const thread of [undefined, '', '../x', 42, `${root}x`]) {
      expect(focusSeqSearch({ seq: '4', thread })).toEqual({ seq: 4 });
    }
  });
});
