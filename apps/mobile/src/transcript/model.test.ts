import { describe, expect, it } from 'vitest';
import { activeMention, insertMention, mergeMessages, type Message } from './model';
describe('native composer mentions', () => {
  it('finds only the handle being edited', () => {
    expect(activeMention('Ask @al')).toEqual({ start: 4, end: 7, query: 'al' });
    expect(activeMention('me@example.com')).toBeNull();
    expect(activeMention('hello @alice done')).toBeNull();
  });
  it('preserves trailing text and prior mentions', () => {
    expect(insertMention('@alice ask @bo tomorrow', 'bob', 14)).toBe('@alice ask @bob  tomorrow');
    expect(insertMention('Hello', 'alice')).toBe('Hello @alice ');
  });
});
describe('message pages', () => {
  it('keeps newer widget/reaction state when older pages overlap', () => {
    const m = (id: string, seq: number, updatedSeq: number) => ({ id, seq, updatedSeq }) as Message;
    const newest = m('a', 1, 8);
    expect(mergeMessages([newest], [m('a', 1, 2), m('b', 4, 4)])).toEqual([m('b', 4, 4), newest]);
  });
});
