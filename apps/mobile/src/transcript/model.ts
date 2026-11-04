import type { components } from '@openbots/api-client';
export type Message = components['schemas']['Message'];
export type Attachment = { uri: string; name: string; mime: string };

/** Replace only the unfinished mention at the cursor; earlier mentions stay intact. */
export function activeMention(
  text: string,
  cursor = text.length,
): { start: number; end: number; query: string } | null {
  const before = text.slice(0, cursor);
  const match = /(?:^|\s)@([a-zA-Z0-9_-]*)$/.exec(before);
  if (!match) return null;
  return { start: cursor - match[1]!.length - 1, end: cursor, query: match[1]!.toLowerCase() };
}
export function insertMention(text: string, handle: string, cursor = text.length) {
  const mention = activeMention(text, cursor);
  return mention
    ? text.slice(0, mention.start) + `@${handle} ` + text.slice(mention.end)
    : `${text}${text && !text.endsWith(' ') ? ' ' : ''}@${handle} `;
}
export function mergeMessages(current: readonly Message[], incoming: readonly Message[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const previous = byId.get(message.id);
    if (!previous || message.updatedSeq >= previous.updatedSeq) byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => b.seq - a.seq);
}
export function formatBytes(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
