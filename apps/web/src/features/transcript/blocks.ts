import type { Message, MessagePart } from './api.js';

// A Bot message's parts as the transcript draws them (C2, principle 6):
// consecutive `tool_call` and `tool_result` parts fold into one compact
// activity line labelled by the step label, reasoning folds away, and
// everything else renders in order.

type PartOf<T extends MessagePart['type']> = Extract<MessagePart, { type: T }>;

export interface ActivityItem {
  id: string;
  /** The tool's name, `<connector slug>__<tool>` for a connector's tool. */
  tool: string;
  label: string;
  done: boolean;
  error: boolean;
}

export type Block =
  | { kind: 'text'; index: number; text: string }
  | { kind: 'reasoning'; index: number; text: string }
  | { kind: 'activity'; index: number; items: ActivityItem[] }
  | { kind: 'image'; index: number; part: PartOf<'image'> }
  | { kind: 'file'; index: number; part: PartOf<'file'> }
  | { kind: 'widget'; index: number; part: PartOf<'widget'> }
  | { kind: 'event'; index: number; part: PartOf<'event'> }
  | { kind: 'artifact'; index: number; part: PartOf<'artifact'> }
  | { kind: 'skill_ref'; index: number; part: PartOf<'skill_ref'> };

export function toBlocks(message: Pick<Message, 'parts' | 'status'>): Block[] {
  const blocks: Block[] = [];
  const streaming = message.status === 'streaming';
  let activity: Extract<Block, { kind: 'activity' }> | null = null;

  message.parts.forEach((part, index) => {
    if (!part) return;
    if (part.type === 'tool_call' || part.type === 'tool_result') {
      if (!activity) {
        activity = { kind: 'activity', index, items: [] };
        blocks.push(activity);
      }
      const id = part.tool_call_id;
      let item = activity.items.find((i) => i.id === id);
      if (!item) {
        item = { id, tool: part.tool_name, label: '', done: !streaming, error: false };
        activity.items.push(item);
      }
      if (part.type === 'tool_result') {
        item.done = true;
        item.error = Boolean(part.is_error);
        item.label = part.label ?? (item.label || part.tool_name);
      } else if (!item.label || !item.done) {
        item.label = part.label ?? part.tool_name;
      }
      return;
    }
    activity = null;
    switch (part.type) {
      case 'text':
        if (part.text) blocks.push({ kind: 'text', index, text: part.text });
        break;
      case 'reasoning':
        if (part.text) blocks.push({ kind: 'reasoning', index, text: part.text });
        break;
      default:
        blocks.push({ kind: part.type, index, part } as Block);
    }
  });
  return blocks;
}

/** Whether a message is only event rows, drawn without a bubble or author (W3). */
export function isEventOnly(message: Pick<Message, 'parts'>): boolean {
  return message.parts.length > 0 && message.parts.every((p) => p.type === 'event');
}
