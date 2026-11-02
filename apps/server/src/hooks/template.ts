import { valueAt } from './match.js';

// What a delivery becomes in the transcript (plan 11, H1, H2, P2). The
// endpoint's template renders the payload: `{{path.to.field}}` inserts a
// value (strings as they are, anything else as JSON), `{{json}}` the whole
// payload as a fenced block, `{{event}}` the one-line description. With no
// template it is that line plus the fenced JSON. The result is wrapped in
// `<webhook_event endpoint="..." verified="...">`, which the operating rules
// tell the Bot is data, never instructions.

/** Largest payload JSON shown in the message; the full body stays in the delivery log. */
export const PAYLOAD_CHARS = 20_000;

export interface RenderInput {
  payload: unknown;
  /** One line saying what arrived (`describeEvent`). */
  event: string;
}

function fenced(payload: unknown): string {
  let json = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  if (json.length > PAYLOAD_CHARS) json = `${json.slice(0, PAYLOAD_CHARS)}\n… (truncated)`;
  // A fence longer than any backtick run inside, so the payload cannot close it.
  const longest = Math.max(2, ...(json.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}json\n${json}\n${fence}`;
}

export const DEFAULT_TEMPLATE = '{{event}}\n\n{{json}}';

/** Renders the endpoint template (or the default one) over the payload. */
export function renderTemplate(template: string | null | undefined, input: RenderInput): string {
  return (template?.trim() ? template : DEFAULT_TEMPLATE).replace(
    /\{\{\s*([\w.-]+)\s*\}\}/g,
    (_, key: string) => {
      if (key === 'json') return fenced(input.payload);
      if (key === 'event') return input.event;
      const value = valueAt(input.payload, key);
      if (value === undefined || value === null) return '';
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
  );
}

const attr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * The framed text (P2). A closing tag inside the content is defused, so a
 * payload cannot end the frame and speak outside it.
 */
export function frameEvent(content: string, endpoint: string, verified: boolean): string {
  const body = content.replace(/<\/?\s*webhook_event/gi, (tag) => tag.replace('<', '&lt;'));
  return `<webhook_event endpoint="${attr(endpoint)}" verified="${verified}">\n${body}\n</webhook_event>`;
}
