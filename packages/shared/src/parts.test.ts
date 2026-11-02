import { describe, expect, it } from 'vitest';
import {
  applyMessageDelta,
  MESSAGE_PART_TYPES,
  MessagePartSchema,
  parseMentions,
  type MessageDelta,
  type MessagePart,
} from './parts.js';

const FILE = '00000000-0000-4000-8000-000000000001';

describe('message parts', () => {
  it('accepts one of every part type and keeps unknown fields', () => {
    const parts: MessagePart[] = [
      { type: 'text', text: 'hi' },
      { type: 'image', file_id: FILE, name: 'a.png', mime: 'image/png', size: 3 },
      { type: 'file', file_id: FILE, name: 'a.pdf', mime: 'application/pdf' },
      { type: 'tool_call', tool_call_id: 'c1', tool_name: 'bash', args: { cmd: 'ls' } },
      { type: 'tool_result', tool_call_id: 'c1', tool_name: 'bash', result: { exitCode: 0 } },
      { type: 'reasoning', text: 'hmm' },
      { type: 'widget', kind: 'question', props: { options: ['a'] }, state: null },
      { type: 'event', kind: 'routine.ran', text: 'Morning digest ran' },
      { type: 'artifact', artifact_id: 'a1', title: 'Plan', version: 2 },
      { type: 'skill_ref', skill_id: 's1', name: 'Triage' },
    ];
    expect(parts.map((p) => p.type)).toEqual(MESSAGE_PART_TYPES);
    for (const part of parts) expect(MessagePartSchema.parse(part)).toEqual(part);
    expect(MessagePartSchema.parse({ type: 'text', text: 'x', extra: 1 })).toHaveProperty('extra');
  });

  it('rejects unknown types and missing fields', () => {
    expect(MessagePartSchema.safeParse({ type: 'video' }).success).toBe(false);
    expect(MessagePartSchema.safeParse({ type: 'image', name: 'a.png' }).success).toBe(false);
    expect(MessagePartSchema.safeParse({ type: 'widget', props: {} }).success).toBe(false);
  });
});

describe('parseMentions', () => {
  it('finds @handles and @everyone', () => {
    expect(parseMentions('@ada and @Bob-2, ask @everyone. @ada again')).toEqual({
      handles: ['ada', 'bob-2'],
      everyone: true,
    });
  });

  it('ignores email addresses and text without mentions', () => {
    expect(parseMentions('mail me at me@ada.dev')).toEqual({ handles: [], everyone: false });
    expect(parseMentions('')).toEqual({ handles: [], everyone: false });
  });

  it('accepts a mention at the start, after punctuation, or in parentheses', () => {
    expect(parseMentions('(@ada) hi\n@grace: go').handles).toEqual(['ada', 'grace']);
  });
});

describe('applyMessageDelta', () => {
  const events: MessageDelta[] = [
    { deltaSeq: 1, deltas: [{ partIndex: 0, type: 'reasoning', text: 'Let me' }] },
    {
      deltaSeq: 2,
      deltas: [
        { partIndex: 0, type: 'reasoning', text: ' think' },
        {
          partIndex: 1,
          type: 'tool_call',
          text: '',
          part: { type: 'tool_call', tool_call_id: 'c1', tool_name: 'bash', args: {} },
        },
      ],
    },
    { deltaSeq: 3, deltas: [{ partIndex: 2, type: 'text', text: 'Done' }] },
    { deltaSeq: 4, deltas: [{ partIndex: 2, type: 'text', text: '.' }] },
  ];

  const replay = (list: MessageDelta[], from = { parts: [] as MessagePart[], deltaSeq: 0 }) =>
    list.reduce((s, d) => applyMessageDelta(s.parts, s.deltaSeq, d), from);

  it('builds the parts in order', () => {
    expect(replay(events)).toEqual({
      deltaSeq: 4,
      parts: [
        { type: 'reasoning', text: 'Let me think' },
        { type: 'tool_call', tool_call_id: 'c1', tool_name: 'bash', args: {} },
        { type: 'text', text: 'Done.' },
      ],
    });
  });

  it('ignores replays, so applying everything twice changes nothing', () => {
    const once = replay(events);
    expect(replay([...events, ...events])).toEqual(once);
    // A client that loaded the row at deltaSeq 2 and then receives every event.
    const midway = replay(events.slice(0, 2));
    expect(replay(events, midway)).toEqual(once);
  });
});
