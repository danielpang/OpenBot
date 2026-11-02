import type { ModelMessage } from 'ai';
import { frameToolOutput } from '../context/framing.js';
import type { ToolResultOutput } from '../tools/types.js';
import type { WaitingReason, WaitRequest } from '../gated.js';
import type { UsageTotals } from './execute.js';

// What `runs.state` holds while a run waits (plan 5.6): the model messages so
// far, the tool call the owner has to answer, and the steering watermark.
// Everything is JSON, so a run paused by one worker resumes in another, or
// after a restart.

export interface PendingWait {
  reason: WaitingReason;
  toolCallId: string;
  toolName: string;
  args: unknown;
  widget: { kind: string; props: unknown };
  label: string;
  /** Where the widget part landed, once posted. */
  messageId?: string;
  partIndex?: number;
  /** Posted in another Bot's transcript before the run paused (K8). */
  posted?: WaitRequest['posted'];
}

export interface SerializedRunState {
  version: 1;
  messages: ModelMessage[];
  pending: PendingWait;
  /** The last transcript seq the run has seen; later owner messages steer it. */
  seenSeq: number;
  /** The tool result to inject when the run resumes; set by the action that answers it. */
  resume?: { output: unknown };
  /** How many leading `messages` came from the transcript (`trimContext`). */
  contextLength?: number;
}

/** The placeholder a waiting tool returns; replaced by the answer on resume. */
export const WAITING_RESULT = { status: 'waiting_for_owner' } as const;

/**
 * The serialized messages with the waiting call's result replaced by
 * `output`, encoded by the tool's `toModelOutput` when it has one (a
 * screenshot as an image part) and framed as data otherwise.
 */
export function injectToolResult(
  messages: ModelMessage[],
  toolCallId: string,
  output: unknown,
  encode?: (output: unknown) => ToolResultOutput | undefined,
): ModelMessage[] {
  let found = false;
  const next = messages.map((m) => {
    if (m.role !== 'tool') return m;
    return {
      ...m,
      content: m.content.map((part) => {
        if (part.type !== 'tool-result' || part.toolCallId !== toolCallId) return part;
        found = true;
        return { ...part, output: encode?.(output) ?? frameToolOutput(part.toolName, output) };
      }),
    };
  });
  if (!found) throw new Error(`no tool result for call ${toolCallId} in the saved run state`);
  return next;
}

/**
 * What `runs.state` holds while a run runs (K4): the model messages as of
 * the last step boundary and the tool calls started since. A worker that
 * takes the run over after a crash continues from there
 * (`resumeFromCheckpoint`). A call whose result was not recorded is never
 * run again; the model is told its outcome is unknown instead.
 */
export interface RunCheckpoint {
  /** The message the run was streaming into. */
  messageId: string;
  messages: ModelMessage[];
  /** Calls started after `messages`, in the order they started. */
  calls: CheckpointCall[];
  seenSeq: number;
  /** The model calls' usage so far, across restarts. */
  usage: UsageTotals;
  /** How many leading `messages` came from the transcript (`trimContext`). */
  contextLength?: number;
}

/**
 * A resumed or taken-over run's messages without the oldest half of their
 * transcript part, for one retry after a context overflow (plan 5.7). The
 * first `contextLength` messages came from the transcript; everything after
 * them is the run's own work (tool calls that already ran, steering) and is
 * kept whole, so nothing the run did is forgotten and done again. The cut
 * lands on a user message, so no tool call loses its result and the model
 * still reads a user turn first. Null when there is nothing left to drop.
 */
export function trimContext(
  messages: ModelMessage[],
  contextLength: number,
): { messages: ModelMessage[]; contextLength: number } | null {
  const end = Math.min(contextLength, messages.length);
  for (let i = Math.max(1, Math.floor(end / 2)); i < end; i++) {
    if (messages[i]!.role === 'user') {
      return { messages: messages.slice(i), contextLength: end - i };
    }
  }
  return null;
}

export interface CheckpointCall {
  toolCallId: string;
  /** As the model messages spell it (the provider's name). */
  toolName: string;
  /** As the model sent them. */
  input: unknown;
  /** The result as the model reads it, once the call finished. */
  output?: ToolResultOutput;
  /** The call and a placeholder result are in `messages` already (a call made outside the loop). */
  inMessages?: boolean;
}

/** The result of a call that a restart cut off (K4). */
export const INTERRUPTED_RESULT = {
  error: 'interrupted_by_restart',
  message:
    'The server restarted while this call was running, so whether it finished is unknown. Check its effect before you try it again.',
} as const;

/**
 * The messages to continue a checkpointed run with: each call that finished
 * keeps its result, and each one a restart cut off gets INTERRUPTED_RESULT,
 * so the model decides what to do rather than the call running twice.
 */
export function resumeFromCheckpoint(
  checkpoint: Pick<RunCheckpoint, 'messages' | 'calls'>,
): ModelMessage[] {
  const resultOf = (call: CheckpointCall): ToolResultOutput =>
    call.output ?? frameToolOutput(call.toolName, INTERRUPTED_RESULT, true);
  const inside = new Map(
    checkpoint.calls.filter((c) => c.inMessages).map((c) => [c.toolCallId, c] as const),
  );
  const messages = checkpoint.messages.map((m) => {
    if (m.role !== 'tool' || !inside.size) return m;
    return {
      ...m,
      content: m.content.map((part) => {
        const call = part.type === 'tool-result' ? inside.get(part.toolCallId) : undefined;
        return call ? { ...part, output: resultOf(call) } : part;
      }),
    };
  });
  const after = checkpoint.calls.filter((c) => !c.inMessages);
  if (!after.length) return messages;
  return [
    ...messages,
    {
      role: 'assistant',
      content: after.map((c) => ({
        type: 'tool-call' as const,
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        input: c.input,
      })),
    },
    {
      role: 'tool',
      content: after.map((c) => ({
        type: 'tool-result' as const,
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        output: resultOf(c),
      })),
    },
  ];
}
