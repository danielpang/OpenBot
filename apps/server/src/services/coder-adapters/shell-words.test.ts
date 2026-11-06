import { describe, expect, it } from 'vitest';
import { parseShell } from './shell-words.js';

describe('shell words', () => {
  it('splits words and compound commands as the shell does', () => {
    const parsed = parseShell(`echo 'a; b' && git "pu"sh; ls | wc -l\nmake`);
    expect(parsed.commands.map((c) => c.words.map((w) => w.text))).toEqual([
      ['echo', 'a; b'],
      ['git', 'push'],
      ['ls'],
      ['wc', '-l'],
      ['make'],
    ]);
    expect(parsed.commands.map((c) => c.piped)).toEqual([false, false, false, true, false]);
  });
});
