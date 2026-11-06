// A command line read the way POSIX sh splits it, for the classifier
// (classify.ts) and Codex's `bash -lc` unwrapping: words with quotes and
// escapes honoured, simple commands split on the control operators, and the
// bodies of `$(...)` and backticks kept to be read as commands of their own.
//
// It models a subset of bash. What it does not model (ANSI-C `$'...'` quoting,
// `#` comments, here-docs, `case`, `{ }` groups, arithmetic `(( ))`, brace
// expansion, escapes inside backticks, a glob where the command or its
// subcommand is named) marks the line `unmodelled`, and the
// classifier asks rather than guess: a line read wrongly could look harmless
// while running something else.

/** A word of a simple command, and whether its text depends on the shell (`$`, backticks). */
export interface Word {
  text: string;
  dynamic: boolean;
  /** Has unquoted glob characters (`*`, `?`, `[...]`): the shell may expand it into other words. */
  glob?: boolean;
}

/** One simple command: its words, and what joined it to the previous one. */
export interface SimpleCommand {
  words: Word[];
  /** Piped into from the previous command. */
  piped: boolean;
}

export interface Parsed {
  commands: SimpleCommand[];
  /** The bodies of `$(…)` and backticks, read as commands of their own. */
  nested: string[];
  /** Quotes left open: the shell would refuse it, and the rest cannot be read. */
  unbalanced: boolean;
  /** Uses shell syntax this reader does not model, so its words cannot be trusted. */
  unmodelled: boolean;
}

/** The shell's control operators, longest first. */
const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '\n', '(', ')'];

/**
 * Syntax anywhere in the line that changes how it reads and is not modelled:
 * ANSI-C quoting, here-docs and here-strings, arithmetic. Matched on the raw
 * text, so a quoted occurrence asks too (fail closed).
 */
const UNMODELLED_SYNTAX = /\$'|<<|\(\(/;

/** Reserved words that start a compound command this reader does not follow. */
const UNMODELLED_HEADS = new Set(['case', 'esac', 'coproc', 'function', 'select', '{', '}']);

/** Reserved words that only precede the command after them: dropped, so that command is read. */
const PREFIX_WORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!']);

/** `{a,b}` or `{1..3}`: brace expansion, which makes words the reader does not see. */
const BRACE_EXPANSION = /^\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/;

/** Reads a command line into simple commands, as POSIX sh splits words. */
export function parseShell(source: string): Parsed {
  const commands: SimpleCommand[] = [];
  const nested: string[] = [];
  let words: Word[] = [];
  let piped = false;
  let nextPiped = false;
  let text = '';
  let dynamic = false;
  let inWord = false;
  let quoted = false;
  let glob = false;
  let bracket = false;
  let unbalanced = false;
  let unmodelled = UNMODELLED_SYNTAX.test(source);

  const endWord = () => {
    if (inWord) {
      // A reserved word counts only unquoted, as a command's first word.
      const reserved = !quoted && !dynamic && words.length === 0;
      if (reserved && UNMODELLED_HEADS.has(text)) unmodelled = true;
      // `{` is dropped too, so the group's first command is still read.
      if (!(reserved && (PREFIX_WORDS.has(text) || text === '{'))) {
        words.push(glob ? { text, dynamic, glob } : { text, dynamic });
      }
    }
    text = '';
    dynamic = false;
    inWord = false;
    quoted = false;
    glob = false;
    bracket = false;
  };
  const endCommand = (pipe: boolean) => {
    endWord();
    if (words.length) commands.push({ words, piped });
    words = [];
    piped = pipe || nextPiped;
    nextPiped = false;
  };
  /** The index just past the `)` that closes the `$(` opened before `start`. */
  const closeParen = (start: number) => {
    let depth = 1;
    let quote: string | null = null;
    for (let j = start; j < source.length; j++) {
      const c = source[j]!;
      if (quote) {
        if (c === '\\' && quote === '"') j++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '\\') j++;
      else if (c === "'" || c === '"') quote = c;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return j;
    }
    return -1;
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    // Substitutions, in or out of double quotes: their body runs too.
    if (c === '$' && source[i + 1] === '(') {
      const end = closeParen(i + 2);
      if (end < 0) {
        unbalanced = true;
        nested.push(source.slice(i + 2));
        break;
      }
      nested.push(source.slice(i + 2, end));
      text += source.slice(i, end + 1);
      dynamic = inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '`') {
      const end = source.indexOf('`', i + 1);
      if (end < 0) {
        unbalanced = true;
        nested.push(source.slice(i + 1));
        break;
      }
      const body = source.slice(i + 1, end);
      // `\`` nests backticks, and `\` escapes differ inside them: not modelled.
      if (body.includes('\\')) unmodelled = true;
      nested.push(body);
      text += source.slice(i, end + 1);
      dynamic = inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '\\') {
      // A line continuation joins lines; any other escaped character is literal.
      if (source[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (i + 1 < source.length) {
        text += source[i + 1];
        inWord = quoted = true;
      }
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = source.indexOf("'", i + 1);
      if (end < 0) {
        unbalanced = true;
        text += source.slice(i + 1);
        inWord = true;
        break;
      }
      const literal = source.slice(i + 1, end);
      text += literal;
      // Literal to the shell, but a `$` here still reads as unresolved to us.
      if (/[$`]/.test(literal)) dynamic = true;
      inWord = quoted = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let closed = false;
      inWord = quoted = true;
      while (j < source.length) {
        const d = source[j]!;
        if (d === '\\' && '"\\$`\n'.includes(source[j + 1] ?? '')) {
          if (source[j + 1] !== '\n') text += source[j + 1];
          j += 2;
          continue;
        }
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === '$' && source[j + 1] === '(') {
          const end = closeParen(j + 2);
          if (end < 0) break;
          nested.push(source.slice(j + 2, end));
          text += source.slice(j, end + 1);
          dynamic = true;
          j = end + 1;
          continue;
        }
        if (d === '`') {
          const end = source.indexOf('`', j + 1);
          if (end < 0) break;
          if (source.slice(j + 1, end).includes('\\')) unmodelled = true;
          nested.push(source.slice(j + 1, end));
          text += source.slice(j, end + 1);
          dynamic = true;
          j = end + 1;
          continue;
        }
        if (d === '$') dynamic = true;
        text += d;
        j++;
      }
      if (!closed) {
        unbalanced = true;
        break;
      }
      i = j + 1;
      continue;
    }
    const operator = OPERATORS.find((op) => source.startsWith(op, i));
    if (operator) {
      endCommand(operator === '|' || operator === '|&');
      i += operator.length;
      continue;
    }
    // Redirections are words of their own, so the path after one is checked.
    if (c === '>' || c === '<') {
      endWord();
      const op = /^(?:>>|>&|<<<|<<|<>|>\||>|<)/.exec(source.slice(i))![0];
      words.push({ text: op, dynamic: false });
      i += op.length;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    // A `#` starting a word comments out the rest of the line.
    if (c === '#' && !inWord) unmodelled = true;
    if (c === '{' && source[i - 1] !== '$' && BRACE_EXPANSION.test(source.slice(i))) {
      unmodelled = true;
    }
    // `$*` and `$?` are parameters, not globs.
    if ((c === '*' || c === '?') && source[i - 1] !== '$') glob = true;
    if (c === '[') bracket = true;
    if (c === ']' && bracket) glob = true;
    if (c === '$') dynamic = true;
    text += c;
    inWord = true;
    i++;
  }
  endCommand(false);
  return { commands, nested, unbalanced, unmodelled };
}
