import type { Message } from './model';

// A Bot message's parts as the transcript draws them, as on the web
// (apps/web/src/features/transcript/blocks.ts): a run of consecutive `tool_call` and
// `tool_result` parts folds into one activity block, where a call and its result are
// one step, and every other part is drawn in order.

type Part = Message['parts'][number];

export interface ActivityStep {
  id: string;
  label: string;
  done: boolean;
  error: boolean;
  args?: unknown;
  result?: unknown;
}

export type MessageBlock =
  | { kind: 'part'; index: number; part: Part }
  | { kind: 'activity'; index: number; steps: ActivityStep[] };

export function toBlocks(message: Pick<Message, 'parts' | 'status'>): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const streaming = message.status === 'streaming';
  let activity: Extract<MessageBlock, { kind: 'activity' }> | null = null;
  message.parts.forEach((part, index) => {
    if (part.type !== 'tool_call' && part.type !== 'tool_result') {
      activity = null;
      blocks.push({ kind: 'part', index, part });
      return;
    }
    if (!activity) {
      activity = { kind: 'activity', index, steps: [] };
      blocks.push(activity);
    }
    let step = activity.steps.find((item) => item.id === part.tool_call_id);
    if (!step) {
      // A call with no result in a finished message is not still running.
      step = { id: part.tool_call_id, label: '', done: !streaming, error: false };
      activity.steps.push(step);
    }
    if (part.type === 'tool_result') {
      step.done = true;
      step.error = Boolean(part.is_error);
      step.label = part.label ?? (step.label || part.tool_name);
      step.result = part.result;
    } else {
      if (!step.label || !step.done) step.label = part.label ?? part.tool_name;
      step.args = part.args;
    }
  });
  return blocks;
}
