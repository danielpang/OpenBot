import { describe, expect, it } from 'vitest';
import { showsThinking, THINKING_PHRASES, thinkingPhrase } from './thinking.js';

describe('thinking', () => {
  it('shows while a reply streams with no text being written', () => {
    expect(showsThinking({ status: 'streaming', parts: [] })).toBe(true);
    expect(showsThinking({ status: 'streaming', parts: [{ type: 'text', text: ' ' }] })).toBe(true);
    expect(showsThinking({ status: 'streaming', parts: [{ type: 'tool_call' }] })).toBe(true);
    expect(showsThinking({ status: 'streaming', parts: [{ type: 'text', text: 'Hi' }] })).toBe(
      false,
    );
    expect(showsThinking({ status: 'complete', parts: [] })).toBe(false);
  });

  it('starts each reply somewhere steady in the list and moves one phrase a step', () => {
    const first = thinkingPhrase('m1', 0);
    expect(thinkingPhrase('m1', 0)).toBe(first);
    const at = THINKING_PHRASES.indexOf(first as (typeof THINKING_PHRASES)[number]);
    expect(thinkingPhrase('m1', 1)).toBe(THINKING_PHRASES[(at + 1) % THINKING_PHRASES.length]);
  });

  it('keeps phrases free of dashes', () => {
    for (const phrase of THINKING_PHRASES) expect(phrase).not.toMatch(/[-–—]/);
  });
});
