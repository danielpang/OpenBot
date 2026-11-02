import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

type DoStream = Extract<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doStream'],
  (...args: never[]) => unknown
>;
type LanguageModelV4CallOptions = Parameters<DoStream>[0];
type LanguageModelV4StreamPart =
  Awaited<ReturnType<DoStream>>['stream'] extends ReadableStream<infer P> ? P : never;

// A recorded-provider double for run-loop tests: each model call plays the
// next scripted turn (text, reasoning, tool calls, or a provider error) as a
// stream, and every call's prompt is kept for assertions.

export type ScriptedChunk =
  { text: string } | { reasoning: string } | { tool: string; args: unknown; id?: string };

export type ScriptedTurn =
  ScriptedChunk[] | { error: unknown } | ((options: LanguageModelV4CallOptions) => ScriptedChunk[]);

export interface ScriptedModel extends MockLanguageModelV4 {
  calls: LanguageModelV4CallOptions[];
}

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

let toolCallCounter = 0;

export function scriptedModel(
  turns: ScriptedTurn[],
  { modelId = 'scripted', chunkDelayMs = 0 } = {},
): ScriptedModel {
  const calls: LanguageModelV4CallOptions[] = [];
  const next = (options: LanguageModelV4CallOptions) => {
    calls.push(options);
    const turn = turns[calls.length - 1] ?? [{ text: '' }];
    if (!Array.isArray(turn) && typeof turn !== 'function') throw turn.error;
    return typeof turn === 'function' ? turn(options) : turn;
  };
  const model = new MockLanguageModelV4({
    modelId,
    doGenerate: async (options) => {
      const chunks = next(options);
      const text = chunks.map((c) => ('text' in c ? c.text : '')).join('');
      return {
        content: text ? [{ type: 'text', text }] : [],
        finishReason: { unified: 'stop', raw: undefined },
        usage: usage(100 + calls.length, 10),
        warnings: [],
      };
    },
    doStream: async (options) => {
      const chunks = next(options);
      const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      let hasTool = false;
      chunks.forEach((chunk, i) => {
        if ('text' in chunk) {
          parts.push({ type: 'text-start', id: `t${i}` });
          for (const word of chunk.text.split(/(?<= )/)) {
            parts.push({ type: 'text-delta', id: `t${i}`, delta: word });
          }
          parts.push({ type: 'text-end', id: `t${i}` });
        } else if ('reasoning' in chunk) {
          parts.push({ type: 'reasoning-start', id: `r${i}` });
          parts.push({ type: 'reasoning-delta', id: `r${i}`, delta: chunk.reasoning });
          parts.push({ type: 'reasoning-end', id: `r${i}` });
        } else {
          hasTool = true;
          parts.push({
            type: 'tool-call',
            toolCallId: chunk.id ?? `call_${++toolCallCounter}`,
            toolName: chunk.tool,
            input: JSON.stringify(chunk.args),
          });
        }
      });
      parts.push({
        type: 'finish',
        finishReason: { unified: hasTool ? 'tool-calls' : 'stop', raw: undefined },
        usage: usage(100 + calls.length, 10),
      });
      return {
        stream: simulateReadableStream({
          chunks: parts,
          initialDelayInMs: chunkDelayMs || null,
          chunkDelayInMs: chunkDelayMs || null,
        }),
      };
    },
  }) as ScriptedModel;
  model.calls = calls;
  return model;
}

/**
 * The text of every message in a recorded call's prompt, for assertions. A
 * tool result framed as text (P2) shows its text; any other output its JSON.
 */
export function promptText(options: LanguageModelV4CallOptions): string {
  return options.prompt
    .map((m) => {
      if (typeof m.content === 'string') return `${m.role}: ${m.content}`;
      return `${m.role}: ${m.content
        .map((c) =>
          c.type === 'text'
            ? c.text
            : c.type === 'tool-call'
              ? `<call ${c.toolName}>`
              : c.type === 'tool-result'
                ? `<result ${resultText(c.output)}>`
                : `<${c.type}>`,
        )
        .join(' ')}`;
    })
    .join('\n');
}

function resultText(output: { type: string; value?: unknown }): string {
  return (output.type === 'text' || output.type === 'error-text') &&
    typeof output.value === 'string'
    ? output.value
    : JSON.stringify(output);
}
