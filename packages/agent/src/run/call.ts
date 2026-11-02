import type { ModelMessage } from 'ai';
import type { ToolResultOutput } from '../tools/types.js';
import { labelFor } from '../activity/labels.js';
import { frameToolOutput } from '../context/framing.js';
import { gated, WaitFor } from '../gated.js';
import type { Policy, PolicyRun } from '../policy/index.js';
import { artifactCardPart } from '../tools/artifacts.js';
import { attachedFilePart } from '../tools/builtin.js';
import { transcriptResult, type AnyAgentTool, type ToolContext } from '../tools/types.js';
import type { ExecuteRunInput } from './execute.js';
import { WAITING_RESULT, type PendingWait } from './state.js';

// One tool call made outside the model loop (plan 5.6): the tool the owner
// approved, run when the waiting run resumes, or the call a widget action
// asks for (Send on an email draft goes through the policy, W2). Its parts go
// to the run's message and its step to the activity log, like a call the
// model made inside `executeRun`.

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface RunToolCallInput extends Pick<
  ExecuteRunInput,
  'sink' | 'setState' | 'recordStep'
> {
  run: PolicyRun;
  call: ToolCall;
  tools: Record<string, AnyAgentTool>;
  toolContext: ToolContext;
  /** Gates the call; null runs it as already approved by the owner. */
  policy: Policy | null;
  /** Posts the `tool_call` part first, for a call no model message carries yet. */
  announce: boolean;
}

export type ToolCallOutcome =
  { status: 'done'; output: unknown } | { status: 'waiting'; wait: PendingWait };

export async function runToolCall(input: RunToolCallInput): Promise<ToolCallOutcome> {
  const { call, sink } = input;
  const name = call.toolName;
  const tool = input.tools[name];
  const labels = tool?.label;
  if (input.announce) {
    await sink.part({
      type: 'tool_call',
      tool_call_id: call.toolCallId,
      tool_name: name,
      args: call.args,
      label: labelFor(name, call.args, undefined, labels),
    });
  }
  const started = Date.now();
  let output: unknown;
  let isError = false;
  try {
    const parsed = tool?.inputSchema.safeParse(call.args);
    if (!tool || !parsed) {
      output = { error: `The ${name} tool is not available to this Bot` };
      isError = true;
    } else if (!parsed.success) {
      output = { error: `Invalid arguments for ${name}: ${parsed.error.message}` };
      isError = true;
    } else {
      const execute = () => tool.execute(parsed.data as never, input.toolContext);
      if (input.policy) {
        output = await gated({
          run: input.run,
          policy: input.policy,
          toolName: name,
          args: parsed.data,
          onStart: (label) => input.setState('working', label, name),
          execute,
          ...(labels ? { labels } : {}),
        });
      } else {
        await input.setState('working', labelFor(name, parsed.data, undefined, labels), name);
        output = await execute();
      }
    }
  } catch (error) {
    if (error instanceof WaitFor) {
      const { posted } = error.request;
      if (posted) {
        // The widget waits elsewhere; this transcript says what was asked.
        await sink.part({
          type: 'tool_result',
          tool_call_id: call.toolCallId,
          tool_name: name,
          result: WAITING_RESULT,
          label: labelFor(name, call.args, WAITING_RESULT, labels),
        });
      }
      const partIndex = posted
        ? posted.partIndex
        : await sink.part({
            type: 'widget',
            kind: error.request.widget.kind,
            props: error.request.widget.props,
            state: { status: 'pending' },
          });
      return {
        status: 'waiting',
        wait: {
          ...error.request,
          toolCallId: call.toolCallId,
          toolName: name,
          args: call.args,
          partIndex,
          ...(posted ? { messageId: posted.messageId } : {}),
        },
      };
    }
    output = { error: error instanceof Error ? error.message : String(error) };
    isError = true;
  }
  await input.setState('thinking', null);
  await sink.part({
    type: 'tool_result',
    tool_call_id: call.toolCallId,
    tool_name: name,
    result: transcriptResult(tool, output),
    ...(isError ? { is_error: true } : {}),
    label: labelFor(name, call.args, isError ? { error: true } : output, labels),
  });
  const file = isError ? null : attachedFilePart(name, output);
  if (file) await sink.part(file);
  const card = isError ? null : artifactCardPart(name, output);
  if (card) await sink.part(card);
  await input.recordStep({
    type: 'tool_call',
    label: labelFor(name, call.args, output ?? {}, labels),
    payload: {
      toolCallId: call.toolCallId,
      toolName: name,
      args: call.args,
      result: transcriptResult(tool, output),
    },
    durationMs: Date.now() - started,
  });
  return { status: 'done', output };
}

/**
 * The model messages for a call made outside the loop: the assistant's call
 * and its result, or the waiting placeholder that `injectToolResult` replaces.
 * `providerName` is the provider's spelling of the tool name.
 */
export function toolCallMessages(
  call: ToolCall,
  providerName: string,
  output: unknown = WAITING_RESULT,
  encode?: (output: unknown) => ToolResultOutput | undefined,
): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: call.toolCallId,
          toolName: providerName,
          input: call.args,
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: call.toolCallId,
          toolName: providerName,
          output: encode?.(output) ?? frameToolOutput(providerName, output),
        },
      ],
    },
  ];
}
