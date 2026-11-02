// Text handling for the composer (C1): which picker the caret is in, what
// choosing an entry inserts, and which links the draft contains.

export interface Trigger {
  /** `/` opens the Skills picker, `@` the Bot mention picker. */
  char: '/' | '@';
  /** What is typed after the trigger character. */
  query: string;
  /** Index of the trigger character in the text. */
  start: number;
}

/** The picker trigger the caret is in: a word starting with `/` or `@` that the caret ends. */
export function activeTrigger(text: string, caret: number): Trigger | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  const word = text.slice(start, caret);
  const char = word[0];
  if (char !== '/' && char !== '@') return null;
  const query = word.slice(1);
  if (!/^[\w-]*$/.test(query)) return null;
  return { char, query, start };
}

/** Replaces the trigger word with `insert` and a space; returns the text and the new caret. */
export function replaceTrigger(
  text: string,
  trigger: Trigger,
  caret: number,
  insert: string,
): { text: string; caret: number } {
  const after = text.slice(caret);
  const spaced = after.startsWith(' ') ? insert : `${insert} `;
  return {
    text: text.slice(0, trigger.start) + spaced + after,
    caret: trigger.start + spaced.length + (after.startsWith(' ') ? 1 : 0),
  };
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/gi;

/** Links in the draft, in order, without duplicates. */
export function detectLinks(text: string): URL[] {
  const seen = new Set<string>();
  const links: URL[] = [];
  for (const [raw] of text.matchAll(URL_RE)) {
    try {
      const url = new URL(raw);
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      links.push(url);
    } catch {
      // Not a URL after all.
    }
  }
  return links;
}
