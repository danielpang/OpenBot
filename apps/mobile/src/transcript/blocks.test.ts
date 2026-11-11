import { describe, expect, it } from 'vitest';
import { toBlocks } from './blocks';
import type { Message } from './model';

type Part = Message['parts'][number];
const call = (id: string, label: string): Part =>
  ({ type: 'tool_call', tool_call_id: id, tool_name: 'web_fetch', args: { id }, label }) as Part;
const result = (id: string, label: string, is_error = false): Part =>
  ({
    type: 'tool_result',
    tool_call_id: id,
    tool_name: 'web_fetch',
    result: { id },
    label,
    is_error,
  }) as Part;
const text = (value: string): Part => ({ type: 'text', text: value }) as Part;

describe('message blocks', () => {
  it('folds a run of tool calls and results into one activity, one step per call', () => {
    const blocks = toBlocks({
      status: 'complete',
      parts: [
        text('Looking into it.'),
        call('a', 'Reading a.com'),
        call('b', 'Reading b.com'),
        result('a', 'Read a.com'),
        result('b', 'Read b.com', true),
        text('Here is what I found.'),
      ],
    });
    expect(blocks.map((block) => block.kind)).toEqual(['part', 'activity', 'part']);
    // Other parts keep their own position in the message: widgets act by part index.
    expect(blocks.map((block) => block.index)).toEqual([0, 1, 5]);
    const activity = blocks[1] as Extract<(typeof blocks)[number], { kind: 'activity' }>;
    expect(activity.steps).toEqual([
      {
        id: 'a',
        label: 'Read a.com',
        done: true,
        error: false,
        args: { id: 'a' },
        result: { id: 'a' },
      },
      {
        id: 'b',
        label: 'Read b.com',
        done: true,
        error: true,
        args: { id: 'b' },
        result: { id: 'b' },
      },
    ]);
  });

  it('starts a new activity after other content', () => {
    const blocks = toBlocks({
      status: 'complete',
      parts: [call('a', 'Reading a.com'), text('Then'), call('b', 'Reading b.com')],
    });
    expect(blocks.map((block) => block.kind)).toEqual(['activity', 'part', 'activity']);
  });

  it('marks a call without a result as running only while the message streams', () => {
    const parts = [call('a', 'Reading a.com')];
    const running = toBlocks({ status: 'streaming', parts })[0];
    const finished = toBlocks({ status: 'complete', parts })[0];
    expect(running).toMatchObject({ steps: [{ label: 'Reading a.com', done: false }] });
    expect(finished).toMatchObject({ steps: [{ label: 'Reading a.com', done: true }] });
  });
});
