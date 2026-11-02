import { describe, expect, it } from 'vitest';
import { activeTrigger, detectLinks, replaceTrigger } from './composer-text.js';

describe('composer text', () => {
  it('finds the picker trigger the caret is in', () => {
    expect(activeTrigger('/', 1)).toEqual({ char: '/', query: '', start: 0 });
    expect(activeTrigger('ask @ad', 7)).toEqual({ char: '@', query: 'ad', start: 4 });
    expect(activeTrigger('ask @ad now', 11)).toBeNull();
    expect(activeTrigger('mail a@b.com', 12)).toBeNull();
    expect(activeTrigger('see https://x.io/a', 18)).toBeNull();
    expect(activeTrigger('line\n/sum', 9)).toEqual({ char: '/', query: 'sum', start: 5 });
  });

  it('replaces the trigger word with the choice and a space', () => {
    const text = 'hey @ad';
    const trigger = activeTrigger(text, 7)!;
    expect(replaceTrigger(text, trigger, 7, '@ada')).toEqual({ text: 'hey @ada ', caret: 9 });
    expect(replaceTrigger('hey @ad there', trigger, 7, '@ada')).toEqual({
      text: 'hey @ada there',
      caret: 9,
    });
  });

  it('detects links once each, without trailing punctuation', () => {
    const links = detectLinks(
      'See https://example.com/a?b=1, and (http://x.io). https://example.com/a?b=1',
    );
    expect(links.map((l) => l.href)).toEqual(['https://example.com/a?b=1', 'http://x.io/']);
    expect(detectLinks('no links here')).toEqual([]);
  });
});
