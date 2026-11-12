import type { ToolNameMap } from '@openbots/models';
import type { MessagePart } from '@openbots/shared';
import {
  type AssistantContent,
  stepCountIs,
  streamText,
  tool,
  type Instructions,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from 'ai';
import { labelFor, thoughtLabel } from '../activity/labels.js';
import { FramedToolError, toolModelOutput } from '../context/framing.js';
import { gated, WaitFor } from '../gated.js';
import type { Policy, PolicyRun } from '../policy/index.js';
import { artifactCardPart } from '../tools/artifacts.js';
import { attachedFilePart } from '../tools/builtin.js';
import { shownWidgetPart, skillDraftPart } from '../tools/conversation.js';
import { SEARCH_TOOLS, type ToolMatch } from '../tools/search.js';
import {
  transcriptResult,
  type AnyAgentTool,
  type ModelTarget,
  type ToolContext,
  type ToolResultOutput,
} from '../tools/types.js';
import { ContextOverflowError, isContextOverflow } from './errors.js';
import { WAITING_RESULT, type CheckpointCall, type PendingWait } from './state.js';

// The loop (plan 5.5): one `streamText` call that runs up to `max_steps`
// model steps. Between steps `prepareStep` drains the steering inbox (plan
// 5.2); after each step `onStepFinish` records the activity log (I4). Every
// tool runs through `gated()`. `checkpoint` persists the messages before
// each step and each call around its run, so a crashed run can continue
// (K4). Text, reasoning, tool calls, results and widgets go to the run's
// streaming message through `sink`, in stream order.
//
// The loop knows nothing about the database: the worker supplies the model,
// the context, the sink and the callbacks, and acts on the outcome.

export const DEFAULT_MAX_STEPS = 40;
export const DEFAULT_MAX_RETRIES = 4;

export type RunStepType = 'llm' | 'tool_call' | 'tool_result' | 'approval' | 'steer' | 'error';

export interface StepRecord {
  type: RunStepType;
  label: string;
  payload?: unknown;
  tokensIn?: number | null;
  tokensOut?: number | null;
  durationMs?: number | null;
}

export interface RunSink {
  text(delta: string): Promise<void>;
  reasoning(delta: string): Promise<void>;
  /** Appends a whole part and returns its index in the message. */
  part(part: MessagePart): Promise<number>;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Model calls made. */
  steps: number;
}

/**
 * Persists the loop as it goes (K4, `RunCheckpoint`), so a run whose worker
 * dies continues from its last finished step. The loop awaits each call: a
 * tool runs only once its start is recorded.
 */
export interface RunCheckpointer {
  /** Before each model call: the messages it gets (steering included) and the usage so far. */
  step(messages: ModelMessage[], usage: UsageTotals): Promise<void>;
  /** A call the policy let run, just before it runs. */
  started(call: CheckpointCall): Promise<void>;
  /** A started call's result, as the model reads it. */
  finished(toolCallId: string, output: ToolResultOutput): Promise<void>;
  /** The step's reasoning, text and calls so far, recorded before its calls run. */
  reply?(content: StepReply): Promise<void>;
}

export type StepReply = Exclude<AssistantContent, string>;

/** How long a call waits for the loop to record its step before running anyway. */
const REPLY_WAIT_MS = 2_000;

export interface ExecuteRunInput {
  run: PolicyRun;
  model: LanguageModel;
  providerOptions?: Record<string, Record<string, unknown>>;
  temperature?: number;
  maxSteps?: number;
  maxRetries?: number;
  instructions: Instructions;
  messages: ModelMessage[];
  tools: Record<string, AnyAgentTool>;
  toolContext: ToolContext;
  policy: Policy;
  /** Provider spellings of tool names (`ResolvedModel.toolNames`); identity when absent. */
  toolNames?: ToolNameMap;
  /** The run's provider and model, for native tools (Anthropic computer use). */
  target?: ModelTarget;
  abortSignal: AbortSignal;
  sink: RunSink;
  /**
   * Bot state: `thinking`, or `working` with the in-progress label and the
   * tool's name (plan 6.1; the name lights the title-bar computer icon, I5).
   */
  setState(
    state: 'thinking' | 'working',
    currentAction: string | null,
    currentTool?: string | null,
  ): Promise<void>;
  recordStep(step: StepRecord): Promise<void>;
  /** Owner messages that arrived since the last call, already author-prefixed. */
  drainSteering(): Promise<string[]>;
  checkpoint?: RunCheckpointer;
}

export type RunOutcome =
  | { status: 'completed'; usage: UsageTotals; text: string }
  | { status: 'waiting'; usage: UsageTotals; wait: PendingWait; messages: ModelMessage[] }
  | { status: 'cancelled'; usage: UsageTotals };

const identityNames: ToolNameMap = {
  toProvider: (n) => n,
  fromProvider: (n) => n,
  renamed: new Map(),
};

export async function executeRun(input: ExecuteRunInput): Promise<RunOutcome> {
  const { run, sink, policy, toolContext, abortSignal } = input;
  const names = input.toolNames ?? identityNames;
  const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, steps: 0 };

  let wait: PendingWait | null = null;
  let stepStartedAt = Date.now();
  let lastMessages = input.messages;
  let priorResponses = 0;
  let tail: { index: number; message: ModelMessage } | null = null;
  let outputStarted = false;
  const argsById = new Map<string, unknown>();
  // The step as streamed, for the checkpoint (K4): a takeover replays its reasoning and text.
  let reply: StepReply = [];
  const open = new Map<string, { text: string; providerOptions?: unknown }>();
  const recorded = new Map<string, { done: Promise<void>; resolve: () => void }>();
  const recordedCall = (id: string) => {
    let entry = recorded.get(id);
    if (!entry) {
      let resolve!: () => void;
      const done = new Promise<void>((r) => (resolve = r));
      entry = { done, resolve };
      recorded.set(id, entry);
    }
    return entry;
  };
  /** Tools run after the step's stream ends, so its call is already on the way to the loop. */
  const awaitRecorded = async (id: string) => {
    if (!input.checkpoint?.reply) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      recordedCall(id).done,
      new Promise<void>((r) => (timer = setTimeout(r, REPLY_WAIT_MS))),
    ]);
    clearTimeout(timer);
  };
  const metadata = (md: unknown) => (md ? { providerOptions: md } : {});
  const toolMs = new Map<string, number>();
  const labelsOf = (name: string) => input.tools[name]?.label;

  // Many tools (plan 5.4): deferred ones are offered once `search_tools`
  // returned them, or once an earlier step of this run called them.
  const deferred = new Set(
    input.tools[SEARCH_TOOLS]
      ? Object.keys(input.tools).filter((name) => input.tools[name]!.deferred)
      : [],
  );
  const loaded = new Set<string>(calledTools(input.messages, names));
  const activeTools = () =>
    deferred.size
      ? Object.keys(input.tools)
          .filter((name) => !deferred.has(name) || loaded.has(name))
          .map((name) => names.toProvider(name))
      : undefined;

  const tools: ToolSet = {};
  for (const [name, agentTool] of Object.entries(input.tools)) {
    const execute = async (
      args: unknown,
      { toolCallId }: { toolCallId: string },
      sent: unknown = args,
    ) => {
      // A call in the same step as a question waits for the next run.
      if (wait) return { skipped: true, reason: 'The run is waiting for the owner' };
      const started = Date.now();
      let running = false;
      const finished = async (output: ToolResultOutput) => {
        if (running) await input.checkpoint?.finished(toolCallId, output);
      };
      try {
        const output = await gated({
          run,
          policy,
          toolName: name,
          args,
          onStart: async (label) => {
            running = true;
            await awaitRecorded(toolCallId);
            // Recorded before the tool runs, so a restart never runs it twice (K4).
            await input.checkpoint?.started({
              toolCallId,
              toolName: names.toProvider(name),
              input: sent,
            });
            await input.setState('working', label, name);
          },
          execute: () => agentTool.execute(args as never, toolContext),
          ...(agentTool.label ? { labels: agentTool.label } : {}),
        });
        if (name !== SEARCH_TOOLS) {
          await finished(toolModelOutput(name, agentTool, output));
          return output;
        }
        // Found tools are offered from the next step, in the provider's spelling.
        const found = (output as { tools?: ToolMatch[] }).tools ?? [];
        for (const match of found) loaded.add(match.name);
        const offered = { tools: found.map((m) => ({ ...m, name: names.toProvider(m.name) })) };
        await finished(toolModelOutput(name, agentTool, offered));
        return offered;
      } catch (error) {
        if (!(error instanceof WaitFor)) {
          // The model reads a thrown error framed like any result (P2, S-10).
          const framed = new FramedToolError(name, errorText({ error }), { cause: error });
          await finished({ type: 'error-text', value: framed.message });
          throw framed;
        }
        wait = { ...error.request, toolCallId, toolName: name, args };
        return WAITING_RESULT;
      } finally {
        toolMs.set(toolCallId, Date.now() - started);
        if (!wait) await input.setState('thinking', null);
      }
    };
    const toModelOutput = ({ output }: { output: unknown }) =>
      toolModelOutput(name, agentTool, output);
    const native = input.target ? agentTool.native?.(input.target) : undefined;
    tools[names.toProvider(name)] = native
      ? native.create({
          execute: (raw: never, options) => execute(native.toArgs(raw), options, raw),
          toModelOutput,
        })
      : tool({
          description: agentTool.description,
          inputSchema: agentTool.inputSchema,
          execute,
          toModelOutput,
        });
  }

  const onStepFinish = async (step: StepResult<ToolSet>) => {
    const durationMs = Date.now() - stepStartedAt;
    const stepUsage = tokens(step.usage);
    usage.steps += 1;
    usage.inputTokens += stepUsage.in;
    usage.outputTokens += stepUsage.out;
    usage.cachedInputTokens += stepUsage.cached;
    await input.recordStep({
      type: 'llm',
      label: thoughtLabel(durationMs),
      payload: {
        finishReason: step.finishReason,
        cachedInputTokens: stepUsage.cached,
        cacheWriteTokens: stepUsage.cacheWrite,
      },
      tokensIn: stepUsage.in,
      tokensOut: stepUsage.out,
      durationMs,
    });
    for (const call of step.toolCalls) {
      const name = names.fromProvider(call.toolName);
      const result = step.toolResults.find((r) => r.toolCallId === call.toolCallId);
      const failed = step.content.find(
        (c) => c.type === 'tool-error' && c.toolCallId === call.toolCallId,
      );
      const output = result
        ? result.output
        : failed
          ? { error: errorText(failed as { error?: unknown }) }
          : undefined;
      await input.recordStep({
        type: 'tool_call',
        label: labelFor(name, call.input, output ?? {}, labelsOf(name)),
        payload: {
          toolCallId: call.toolCallId,
          toolName: name,
          args: call.input,
          result: transcriptResult(input.tools[name], output),
        },
        durationMs: toolMs.get(call.toolCallId) ?? null,
      });
    }
  };

  const result = streamText({
    model: input.model,
    instructions: input.instructions,
    messages: input.messages,
    tools,
    temperature: input.temperature,
    providerOptions: input.providerOptions as never,
    stopWhen: [stepCountIs(input.maxSteps ?? DEFAULT_MAX_STEPS), () => wait !== null],
    maxRetries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
    abortSignal,
    onError: () => {},
    ...(deferred.size ? { activeTools: activeTools() } : {}),
    prepareStep: async ({ messages, responseMessages }) => {
      stepStartedAt = Date.now();
      priorResponses = responseMessages.length;
      // The SDK hands back what the last step sent, the loop's breakpoint included.
      if (tail) messages = messages.map((m, i) => (i === tail!.index ? tail!.message : m));
      const active = activeTools();
      const offer = active ? { activeTools: active } : {};
      const steer = await input.drainSteering();
      for (const text of steer) {
        await input.recordStep({
          type: 'steer',
          label: `Steered: ${text.replace(/^\[[^\]]*\]\s*/, '').slice(0, 60)}`,
          payload: { text },
        });
      }
      lastMessages = steer.length
        ? [...messages, ...steer.map((text) => ({ role: 'user' as const, content: text }))]
        : messages;
      // A queued group run can start after this Bot has already replied. Some
      // models treat a trailing assistant turn as prefill and reject it. Keep
      // history intact, use real steering when present, and leave tool-result
      // turns alone so native tool continuations retain their call/result pairs.
      if (lastMessages.at(-1)?.role === 'assistant') {
        lastMessages = [
          ...lastMessages,
          {
            role: 'user',
            content:
              '[system] Continue your turn using the conversation above. ' +
              'Your previous reply is already visible; avoid repeating it.',
          },
        ];
      }
      await input.checkpoint?.step(lastMessages, { ...usage });
      // As it was before the breakpoint, to put back when the breakpoint moves on.
      tail = lastMessages.length
        ? { index: lastMessages.length - 1, message: lastMessages.at(-1)! }
        : null;
      return { ...offer, messages: cacheTail(lastMessages) };
    },
    onStepFinish,
  });

  let text = '';
  let aborted = false;
  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'start-step':
        reply = [];
        open.clear();
        break;
      case 'text-start':
      case 'reasoning-start': {
        const block = { type: part.type === 'text-start' ? 'text' : 'reasoning', text: '' };
        Object.assign(block, metadata(part.providerMetadata));
        open.set(part.id, block);
        reply.push(block as StepReply[number]);
        break;
      }
      case 'text-end':
      case 'reasoning-end': {
        const block = open.get(part.id);
        if (block && part.providerMetadata) block.providerOptions = part.providerMetadata;
        break;
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const block = open.get(part.id);
        if (block) {
          block.text += part.text;
          if (part.providerMetadata) block.providerOptions = part.providerMetadata;
        }
        if (!part.text) break;
        outputStarted = true;
        if (part.type === 'reasoning-delta') {
          await sink.reasoning(part.text);
          break;
        }
        text += part.text;
        await sink.text(part.text);
        break;
      }
      case 'tool-call': {
        outputStarted = true;
        const name = names.fromProvider(part.toolName);
        argsById.set(part.toolCallId, part.input);
        if (input.checkpoint?.reply && !part.providerExecuted) {
          reply.push({
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            ...metadata(part.providerMetadata),
          } as StepReply[number]);
          await input.checkpoint.reply(structuredClone(reply));
        }
        recordedCall(part.toolCallId).resolve();
        await sink.part({
          type: 'tool_call',
          tool_call_id: part.toolCallId,
          tool_name: name,
          args: part.input,
          label: labelFor(name, part.input, undefined, labelsOf(name)),
        });
        break;
      }
      case 'tool-result': {
        const name = names.fromProvider(part.toolName);
        const pending = wait as PendingWait | null;
        if (pending && pending.toolCallId === part.toolCallId) {
          if (pending.posted) {
            // The widget waits elsewhere; this transcript says what was asked.
            await sink.part({
              type: 'tool_result',
              tool_call_id: part.toolCallId,
              tool_name: name,
              result: part.output,
              label: labelFor(name, part.input, part.output, labelsOf(name)),
            });
            pending.messageId = pending.posted.messageId;
            pending.partIndex = pending.posted.partIndex;
            break;
          }
          pending.partIndex = await sink.part({
            type: 'widget',
            kind: pending.widget.kind,
            props: pending.widget.props,
            state: { status: 'pending' },
          });
          break;
        }
        await sink.part({
          type: 'tool_result',
          tool_call_id: part.toolCallId,
          tool_name: name,
          result: transcriptResult(input.tools[name], part.output),
          label: labelFor(name, part.input, part.output, labelsOf(name)),
        });
        const widget = shownWidgetPart(name, part.input, part.output);
        if (widget) await sink.part(widget);
        const file = attachedFilePart(name, part.output);
        if (file) await sink.part(file);
        const card = artifactCardPart(name, part.output);
        if (card) await sink.part(card);
        const draft = skillDraftPart(name, part.output);
        if (draft) await sink.part(draft);
        break;
      }
      case 'tool-error': {
        const name = names.fromProvider(part.toolName);
        await sink.part({
          type: 'tool_result',
          tool_call_id: part.toolCallId,
          tool_name: name,
          result: { error: errorText(part) },
          is_error: true,
          label: labelFor(name, part.input, { error: true }, labelsOf(name)),
        });
        break;
      }
      case 'abort':
        aborted = true;
        break;
      case 'error':
        if (abortSignal.aborted) {
          aborted = true;
          break;
        }
        if (!outputStarted && isContextOverflow(part.error)) {
          throw new ContextOverflowError(part.error);
        }
        throw part.error;
    }
  }

  if (aborted || abortSignal.aborted) return { status: 'cancelled', usage };
  const pending = wait as PendingWait | null;
  if (pending) {
    // Every step's messages; `response.messages` holds only the last step's.
    const responses = await result.responseMessages;
    return {
      status: 'waiting',
      usage,
      wait: pending,
      messages: [...lastMessages, ...responses.slice(priorResponses)],
    };
  }
  return { status: 'completed', usage, text };
}

// Prompt caching for the loop. The context's own breakpoints (context/
// assemble.ts) cover the tools, the instructions and the transcript; this one
// covers the run's work. It sits on the last message of each step's request,
// so the next step reads everything this one sent from the cache and pays in
// full only for what was added since. Anthropic allows four breakpoints and
// finds the previous step's entry by looking back from the newest, so this
// one moves: only the last message carries it. Other providers ignore it.
const CACHE_TAIL = { type: 'ephemeral' } as const;
/** Breakpoints the context may bring on its messages: four, less the instructions' and the loop's. */
const CONTEXT_BREAKPOINTS = 2;

const breakpoint = (message: ModelMessage) => message.providerOptions?.anthropic?.cacheControl;

function withBreakpoint(message: ModelMessage, value: typeof CACHE_TAIL | undefined) {
  const { cacheControl: _, ...anthropic } = message.providerOptions?.anthropic ?? {};
  const { anthropic: __, ...others } = message.providerOptions ?? {};
  const providerOptions = {
    ...others,
    ...(value || Object.keys(anthropic).length
      ? { anthropic: { ...anthropic, ...(value ? { cacheControl: value } : {}) } }
      : {}),
  };
  const { providerOptions: ___, ...bare } = message;
  return (
    Object.keys(providerOptions).length ? { ...bare, providerOptions } : bare
  ) as ModelMessage;
}

/**
 * The messages with the loop's breakpoint on the last one, and the context's
 * kept to the newest two, so a request never carries more than Anthropic takes.
 */
export function cacheTail(messages: ModelMessage[]): ModelMessage[] {
  const marked = messages.flatMap((m, i) => (breakpoint(m) ? [i] : []));
  const drop = new Set(marked.slice(0, -CONTEXT_BREAKPOINTS));
  const last = messages.length - 1;
  return messages.map((m, i) =>
    i === last ? withBreakpoint(m, CACHE_TAIL) : drop.has(i) ? withBreakpoint(m, undefined) : m,
  );
}

/** Tools the model already called in these messages; a resumed run keeps offering them. */
function calledTools(messages: ModelMessage[], names: ToolNameMap): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const c of m.content) if (c.type === 'tool-call') out.push(names.fromProvider(c.toolName));
  }
  return out;
}

function tokens(usage: LanguageModelUsage) {
  return {
    in: usage.inputTokens ?? 0,
    out: usage.outputTokens ?? 0,
    cached: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWrite: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

function errorText(part: { error?: unknown }): string {
  const error = part.error;
  if (error instanceof FramedToolError) return error.text;
  return error instanceof Error ? error.message : String(error);
}
