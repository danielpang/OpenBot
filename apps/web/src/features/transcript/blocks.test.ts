import { describe, expect, it } from 'vitest';
import type { MessagePart } from './api.js';
import { isEventOnly, toBlocks } from './blocks.js';

const call = (id: string, label: string): MessagePart => ({
  type: 'tool_call',
  tool_call_id: id,
  tool_name: 'bash',
  args: {},
  label,
});
const result = (id: string, label: string, is_error = false): MessagePart => ({
  type: 'tool_result',
  tool_call_id: id,
  tool_name: 'bash',
  result: {},
  label,
  is_error,
});

describe('message blocks', () => {
  it('folds consecutive tool calls and results into one activity line with step labels', () => {
    const parts: MessagePart[] = [
      { type: 'reasoning', text: 'plan' },
      call('a', 'Editing math.ts'),
      result('a', 'Edited math.ts +14 −10'),
      call('b', 'Running npm test'),
      { type: 'text', text: 'Done.' },
      call('c', 'Running npm test'),
      result('c', 'Ran npm test: exit 1', true),
    ];
    const blocks = toBlocks({ parts, status: 'streaming' });
    expect(blocks.map((b) => b.kind)).toEqual(['reasoning', 'activity', 'text', 'activity']);
    expect(blocks[1]).toMatchObject({
      items: [
        { id: 'a', label: 'Edited math.ts +14 −10', done: true, error: false },
        { id: 'b', label: 'Running npm test', done: false },
      ],
    });
    expect(blocks[3]).toMatchObject({
      items: [{ id: 'c', label: 'Ran npm test: exit 1', done: true, error: true }],
    });
  });

  it('treats unanswered calls in a finished message as done', () => {
    const [block] = toBlocks({ parts: [call('a', 'Asking a question')], status: 'complete' });
    expect(block).toMatchObject({ items: [{ done: true }] });
  });

  it('skips empty text and keeps other parts in order', () => {
    const parts: MessagePart[] = [
      { type: 'text', text: '' },
      { type: 'image', file_id: 'f', name: 'a.png', mime: 'image/png' },
      { type: 'event', kind: 'blocked', text: 'No model.' },
    ];
    expect(toBlocks({ parts, status: 'complete' }).map((b) => [b.kind, b.index])).toEqual([
      ['image', 1],
      ['event', 2],
    ]);
    expect(isEventOnly({ parts: [parts[2]!] })).toBe(true);
    expect(isEventOnly({ parts })).toBe(false);
    expect(isEventOnly({ parts: [] })).toBe(false);
  });
});
