import type { AnyAgentTool, ToolResultOutput } from '../tools/types.js';

// Data framing (P2). Whatever does not come from the owner reaches the model
// inside a tag that names it as data: fetched pages (<fetched_page>), webhook
// payloads (<webhook_event>, framed by the server), other Bots' messages
// (<bot_message>), the text of attached files (<attachment>) and every tool
// result (<tool_result>). Framed text is
// defused first, so it can neither close or open a frame nor imitate the
// author prefix the transcript puts on the owner's messages.

/** The tags that mark data; text inside a frame cannot spell any of them. */
export const DATA_TAGS = [
  'fetched_page',
  'webhook_event',
  'bot_message',
  'tool_result',
  'attachment',
] as const;
export type DataTag = (typeof DATA_TAGS)[number];

/** Tools whose string result is already a frame of its own (`web_fetch`'s <fetched_page>). */
const SELF_FRAMED = new Set(['web_fetch']);

// Spaces and the invisible characters that can hide inside a look-alike.
const GAP = '[\\s\\u200b-\\u200d\\u2060\\ufeff]*';
const OPEN_ANGLE = '[<\\uff1c\\ufe64]';
const OPEN_SQUARE = '[\\[\\uff3b\\u3010]';
const CLOSE_SQUARE = '[\\]\\uff3d\\u3011]';

// The two gaps never meet, so a long run of spaces after `<` is read once.
const TAG_PATTERN = new RegExp(`${OPEN_ANGLE}${GAP}(?:\\/${GAP})?(${DATA_TAGS.join('|')})`, 'giu');
/** `[@dana (owner)]`, `[@x (bot)]` and their full-width spellings. */
const HANDLE_PREFIX = new RegExp(
  `${OPEN_SQUARE}${GAP}[@\\uff20][^\\]\\uff3d\\u3011\\n]{0,200}?[(\\uff08]${GAP}(owner|user|bot)${GAP}[)\\uff09]${GAP}${CLOSE_SQUARE}`,
  'giu',
);
/** `[webhook]`, `[routine]`, `[system]`. */
const KIND_PREFIX = new RegExp(
  `${OPEN_SQUARE}${GAP}(webhook|routine|system)${GAP}${CLOSE_SQUARE}`,
  'giu',
);

/** Escapes author-prefix look-alikes, so data cannot pass for the owner speaking. */
export function defusePrefixes(text: string): string {
  return text
    .replace(HANDLE_PREFIX, (match) => `&#91;${match.slice(1)}`)
    .replace(KIND_PREFIX, (match) => `&#91;${match.slice(1)}`);
}

/**
 * Escapes frame-tag look-alikes and author prefixes. `keep` leaves one tag
 * alone, for text whose own frame was made (and defused) upstream.
 */
export function defuse(text: string, keep?: DataTag): string {
  const tags = text.replace(TAG_PATTERN, (match, name: string) =>
    name.toLowerCase() === keep ? match : `&lt;${match.slice(1)}`,
  );
  return defusePrefixes(tags);
}

/** An attribute value: one line, no quotes or angle brackets. */
export function frameAttr(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[<>"&]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** `<tag a="b">\n<defused body>\n</tag>`. */
export function frameData(tag: DataTag, attrs: Record<string, string>, body: string): string {
  const attrText = Object.entries(attrs)
    .map(([name, value]) => ` ${name}="${frameAttr(value)}"`)
    .join('');
  return `<${tag}${attrText}>\n${defuse(body)}\n</${tag}>`;
}

/** A tool result as the model reads it: JSON (or the text result) inside <tool_result>. */
export function frameToolOutput(
  toolName: string,
  output: unknown,
  error = false,
): ToolResultOutput {
  if (!error && SELF_FRAMED.has(toolName) && typeof output === 'string') {
    return { type: 'text', value: output };
  }
  const value = frameToolResult(toolName, output, error);
  return error ? { type: 'error-text', value } : { type: 'text', value };
}

function frameToolResult(toolName: string, output: unknown, error: boolean): string {
  const body = typeof output === 'string' ? output : JSON.stringify(output ?? null);
  const attrs: Record<string, string> = error
    ? { tool: toolName, error: 'true' }
    : { tool: toolName };
  return frameData('tool_result', attrs, body);
}

/** The tool's own encoding of a result (a screenshot as an image), or the framed result. */
export function toolModelOutput(
  toolName: string,
  tool: Pick<AnyAgentTool, 'toModelOutput'> | undefined,
  output: unknown,
): ToolResultOutput {
  return tool?.toModelOutput?.(output) ?? frameToolOutput(toolName, output);
}

/**
 * A tool's thrown error, carrying the message the model reads already framed
 * as <tool_result error="true"> (S-10): the AI SDK sends the model an
 * error's `toString()`, so that is the frame alone. `text` is the plain
 * message, for the transcript, whose replay frames it the same way.
 */
export class FramedToolError extends Error {
  constructor(
    toolName: string,
    readonly text: string,
    options?: ErrorOptions,
  ) {
    super(frameToolResult(toolName, { error: text }, true), options);
    this.name = 'FramedToolError';
  }

  override toString(): string {
    return this.message;
  }
}
