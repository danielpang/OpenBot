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

  it('marks syntax it does not model, and leaves what it does', () => {
    for (const command of [
      "$'git\\x20push'",
      'git status # ; git push',
      'cat <<EOF',
      'cat <<< x',
      '{ git push; }',
      'case x in *) git push;; esac',
      'echo $((1 + 2))',
      '(( x++ ))',
      'git {push,status}',
      'echo `echo \\`git push\\``',
    ]) {
      expect(parseShell(command).unmodelled, command).toBe(true);
    }
    for (const command of [
      'git status',
      "echo 'a # b' a#b",
      'find . -name x -exec rm {} \\;',
      'echo ${HOME} $(git status)',
      'if true; then git push; fi',
    ]) {
      expect(parseShell(command).unmodelled, command).toBe(false);
    }
    expect(parseShell('ls *.ts "a*" [ x ]').commands[0]!.words.map((w) => !!w.glob)).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
    // `if`, `then` and the like only precede the command that runs.
    expect(
      parseShell('if true; then git push; fi').commands.map((c) => c.words.map((w) => w.text)),
    ).toEqual([['true'], ['git', 'push'], ['fi']]);
  });
});
