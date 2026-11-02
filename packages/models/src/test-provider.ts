import type { ProviderTestResult } from '@openbots/shared';
import { stepCountIs, streamText, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { errorMessage } from './discover.js';

// "Test" (plan 5.9, L3): a tiny streamed completion, then a tool-call round
// trip. Failures are results, not exceptions, so the UI can say what works.

export interface ProviderTestOptions {
  modelId: string;
  timeoutMs?: number;
}

async function drain(
  stream: AsyncIterable<{ type: string; error?: unknown }>,
  onFirst: () => void,
) {
  let first = true;
  for await (const part of stream) {
    if (part.type === 'error') throw part.error;
    if (first && part.type !== 'start' && part.type !== 'start-step') {
      first = false;
      onFirst();
    }
  }
}

export async function testModel(
  model: LanguageModel,
  { modelId, timeoutMs = 30_000 }: ProviderTestOptions,
): Promise<ProviderTestResult> {
  const result: ProviderTestResult = {
    model_id: modelId,
    streaming: false,
    tools: false,
    latency_ms: null,
    error: null,
  };

  // 16 output tokens rather than 1: OpenAI's Responses API rejects fewer.
  const started = Date.now();
  try {
    const stream = streamText({
      model,
      prompt: 'Reply with the single word: ok',
      maxOutputTokens: 16,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutMs),
      onError: () => {},
    });
    await drain(stream.fullStream, () => {
      result.latency_ms = Date.now() - started;
    });
    result.streaming = true;
  } catch (err) {
    result.error = `Streaming failed: ${errorMessage(err)}`;
    return result;
  }

  let called = false;
  try {
    const stream = streamText({
      model,
      prompt: 'Use the add tool to add 2 and 3, then reply with the sum.',
      tools: {
        add: tool({
          description: 'Adds two numbers',
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: async ({ a, b }) => {
            called = true;
            return a + b;
          },
        }),
      },
      stopWhen: stepCountIs(2),
      maxOutputTokens: 1024,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutMs),
      onError: () => {},
    });
    await drain(stream.fullStream, () => {});
    result.tools = called;
    if (!called) result.error = 'Tool calling failed: the model answered without calling the tool';
  } catch (err) {
    result.error = `Tool calling failed: ${errorMessage(err)}`;
  }
  return result;
}
