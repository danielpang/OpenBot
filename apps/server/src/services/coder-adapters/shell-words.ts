// A command line read the way POSIX sh splits it, for the classifier
// (classify.ts) and Codex's `bash -lc` unwrapping: words with quotes and
// escapes honoured, simple commands split on the control operators, and the
// bodies of `$(...)` and backticks kept to be read as commands of their own.

/** A word of a simple command, and whether its text depends on the shell (`$`, backticks). */
export interface Word {
  text: string;
  dynamic: boolean;
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
}

/** The shell's control operators, longest first. */
const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '\n', '(', ')'];

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
  let unbalanced = false;

  const endWord = () => {
    if (inWord) words.push({ text, dynamic });
    text = '';
    dynamic = false;
    inWord = false;
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
      nested.push(source.slice(i + 1, end));
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
        inWord = true;
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
      const quoted = source.slice(i + 1, end);
      text += quoted;
      // Literal to the shell, but a `$` here still reads as unresolved to us.
      if (/[$`]/.test(quoted)) dynamic = true;
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let closed = false;
      inWord = true;
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
    if (c === '$') dynamic = true;
    text += c;
    inWord = true;
    i++;
  }
  endCommand(false);
  return { commands, nested, unbalanced };
}
