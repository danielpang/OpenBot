/**
 * What a Bot shows while it works on a reply and has no text to stream yet:
 * a thinking orb and a line of office slang that changes every few seconds.
 * Shared by the web, desktop and phone transcripts.
 */

export const THINKING_PHRASES = [
  'Circling back…',
  'Boiling the ocean…',
  'Finding the needle in the haystack…',
  'Moving the needle…',
  'Touching base…',
  'Running it up the flagpole…',
  'Peeling the onion…',
  'Picking the low hanging fruit…',
  'Drilling down…',
  'Getting the ducks in a row…',
  'Taking this offline…',
  'Putting a pin in it…',
  'Double clicking on that…',
  'Aligning on next steps…',
  'Herding the cats…',
  'Pinging the stakeholders…',
  'Thinking outside the box…',
  'Shifting the paradigm…',
  'Leveraging synergies…',
  'Socializing the idea…',
  'Opening a new workstream…',
  'Blue sky thinking…',
  'Squaring the circle…',
  'Parking it in the parking lot…',
] as const;

/** How long each phrase stays before the next. */
export const THINKING_PHRASE_MS = 2800;

/**
 * The phrase shown `step` changes after a reply starts. `seed` (the message id)
 * picks where a reply starts in the list, so replies side by side differ and a
 * re-render never jumps to another phrase.
 */
export function thinkingPhrase(seed: string, step: number): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return THINKING_PHRASES[(hash + step) % THINKING_PHRASES.length]!;
}

/**
 * True while a reply streams but its newest part is not text being written:
 * before the first word, and while it reads, searches or runs a tool.
 */
export function showsThinking(message: {
  status: string;
  parts: readonly { type: string; text?: unknown }[];
}): boolean {
  if (message.status !== 'streaming') return false;
  const last = message.parts.at(-1);
  return !(last?.type === 'text' && typeof last.text === 'string' && last.text.trim() !== '');
}
