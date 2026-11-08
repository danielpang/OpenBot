import { randomUUID } from 'node:crypto';
import type { ComputerAgentClient, CoderProcess } from '@openbots/computer';
import {
  SUBSCRIPTION_BRIDGE,
  SUBSCRIPTION_AUTH_ERROR,
  SUBSCRIPTION_CANCEL_GRACE_MS,
  type CoderAgent,
  type ModelCapabilities,
} from '@openbots/shared';
import type { LanguageModel } from 'ai';

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>;
type Options = Parameters<Model['doStream']>[0];
type Part =
  Awaited<ReturnType<Model['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never;

/** The bridge uses the pinned pi-ai runtime, not pi's coding loop. Tools stay on the server. */
export { SUBSCRIPTION_BRIDGE } from '@openbots/shared';

export function subscriptionContext(options: Options, provider: string, modelId: string) {
  const messages: Record<string, unknown>[] = [];
  const fileContent = (
    part: Extract<Options['prompt'][number], { role: 'user' }>['content'][number],
  ): Record<string, unknown> => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.data.type === 'text') return { type: 'text', text: part.data.text };
    if (part.mediaType.startsWith('image/') && part.data.type === 'data')
      return {
        type: 'image',
        mimeType: part.mediaType,
        data:
          typeof part.data.data === 'string'
            ? part.data.data
            : Buffer.from(part.data.data).toString('base64'),
      };
    throw new Error(`Subscription models cannot read this attachment (${part.mediaType})`);
  };
  const system: string[] = [];
  for (const message of options.prompt) {
    if (message.role === 'system') {
      system.push(message.content);
      continue;
    }
    const content: Record<string, unknown>[] = [];
    for (const part of message.content) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text });
      else if (part.type === 'file') content.push(fileContent(part));
      else if (part.type === 'tool-call') {
        content.push({
          type: 'toolCall',
          // No opaque reasoning state is persisted. Drop Responses item IDs, not call IDs,
          // so replay uses independent calls rather than references paired with rs_* items.
          id:
            provider === 'openai-codex' || provider === 'xai'
              ? part.toolCallId.split('|')[0]
              : part.toolCallId,
          name: part.toolName,
          arguments: part.input,
        });
      } else if (part.type === 'tool-result') {
        const output = part.output;
        messages.push({
          role: 'toolResult',
          toolCallId:
            provider === 'openai-codex' || provider === 'xai'
              ? part.toolCallId.split('|')[0]
              : part.toolCallId,
          toolName: part.toolName,
          content:
            output.type === 'content'
              ? output.value.map((p) => {
                  if (p.type === 'custom')
                    throw new Error(
                      'Subscription models cannot read provider-specific tool output',
                    );
                  return fileContent(p);
                })
              : [
                  {
                    type: 'text',
                    text:
                      'value' in output
                        ? typeof output.value === 'string'
                          ? output.value
                          : JSON.stringify(output.value)
                        : (output.reason ?? 'Tool execution denied'),
                  },
                ],
          isError: output.type.startsWith('error') || output.type === 'execution-denied',
          timestamp: 0,
        });
      }
    }
    if (message.role === 'assistant') {
      if (content.length)
        messages.push({
          role: 'assistant',
          content,
          provider,
          model: modelId,
          api:
            provider === 'openai-codex'
              ? 'openai-codex-responses'
              : provider === 'anthropic'
                ? 'anthropic-messages'
                : 'openai-responses',
          stopReason: content.some((p) => p.type === 'toolCall') ? 'toolUse' : 'stop',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: 0,
        });
    } else if (message.role === 'user') messages.push({ role: 'user', content, timestamp: 0 });
  }
  return {
    systemPrompt: system.join('\n\n'),
    messages,
    tools: options.tools?.map((t) => {
      if (t.type !== 'function') throw new Error('Subscription models require function tools');
      return { name: t.name, description: t.description ?? '', parameters: t.inputSchema };
    }),
  };
}

/** All credentials and refreshes remain on the owner's computer. No API-key fallback. */
export function subscriptionModel(
  client: () => Promise<ComputerAgentClient>,
  connection: { agent: CoderAgent; provider: string },
  modelId: string,
  reasoning?: boolean | 'low' | 'medium' | 'high',
  capabilities?: ModelCapabilities,
  onAuthState?: (failed: boolean) => Promise<void>,
): Model {
  const model: Model = {
    specificationVersion: 'v4',
    provider: `${connection.provider}.subscription`,
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      const { stream } = await model.doStream(options);
      const content: Awaited<ReturnType<Model['doGenerate']>>['content'] = [];
      let finish: Extract<Part, { type: 'finish' }> | undefined;
      for await (const part of stream) {
        if (part.type === 'text-delta') {
          const last = content.at(-1);
          if (last?.type === 'text') last.text += part.delta;
          else content.push({ type: 'text', text: part.delta });
        } else if (part.type === 'tool-call') content.push(part);
        else if (part.type === 'finish') finish = part;
        else if (part.type === 'error') throw part.error;
      }
      if (!finish) throw new Error('Subscription response ended before it finished');
      return {
        content,
        finishReason: finish.finishReason,
        usage: finish.usage,
        warnings: [],
        providerMetadata: { subscription: { billed: 'subscription' } },
      };
    },
    async doStream(options) {
      options.abortSignal?.throwIfAborted();
      const context = subscriptionContext(options, connection.provider, modelId);
      let process: CoderProcess | undefined;
      let settled = false;
      let pending = '';
      let cancelled = false;
      let requestSent = false;
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      let controller: ReadableStreamDefaultController<Part>;
      const stop = () => {
        if (!process) return;
        if (cancelled && requestSent) {
          process.signal('SIGTERM');
          cancelTimer ??= setTimeout(
            () => void process?.close().catch(() => {}),
            SUBSCRIPTION_CANCEL_GRACE_MS,
          );
          cancelTimer.unref();
        } else void process.close().catch(() => {});
      };
      const cleanup = () => {
        clearTimeout(timer);
        options.abortSignal?.removeEventListener('abort', abort);
        stop();
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        controller.error(error);
        cleanup();
      };
      const abort = () => {
        cancelled = true;
        fail(options.abortSignal?.reason ?? new Error('Subscription request cancelled'));
      };
      const stream = new ReadableStream<Part>({
        start(c) {
          controller = c;
          c.enqueue({ type: 'stream-start', warnings: [] });
        },
        cancel() {
          cancelled = true;
          settled = true;
          cleanup();
        },
      });
      const line = (text: string) => {
        if (settled || !text.trim()) return;
        try {
          const event = JSON.parse(text) as Part & { code?: string };
          if (event.type === 'error') {
            if (event.code === 'subscription_auth') void onAuthState?.(true).catch(() => {});
            fail(
              new Error(
                event.code === 'subscription_auth'
                  ? SUBSCRIPTION_AUTH_ERROR
                  : 'The subscription request failed. Check your connection, plan limits and selected model in Settings > Models.',
              ),
            );
            return;
          }
          controller.enqueue(event);
          if (event.type === 'finish') {
            void onAuthState?.(false).catch(() => {});
            settled = true;
            controller.close();
            cleanup();
          }
        } catch {
          fail(new Error('Invalid response from the subscription connection'));
        }
      };
      const timer = setTimeout(() => {
        cancelled = true;
        fail(new Error('The subscription request timed out'));
      }, 10 * 60_000);
      timer.unref();
      options.abortSignal?.addEventListener('abort', abort, { once: true });
      if (options.abortSignal?.aborted) abort();
      void (async () => {
        try {
          const agent = await client();
          if (settled) return;
          process = await agent.coder(
            {
              session_id: randomUUID(),
              user: 'coder',
              command: 'node',
              args: [SUBSCRIPTION_BRIDGE],
              git_credentials: false,
            },
            {
              stdout(data) {
                pending += data;
                if (pending.length > 16_000_000) {
                  fail(new Error('Subscription response exceeded its size limit'));
                  return;
                }
                let index: number;
                while ((index = pending.indexOf('\n')) >= 0) {
                  const value = pending.slice(0, index);
                  pending = pending.slice(index + 1);
                  line(value);
                }
              },
              stderr() {},
              credentialRequest() {},
              permissionRequest() {},
              exit() {
                clearTimeout(cancelTimer);
                if (pending.trim()) line(pending);
                if (settled) void process?.close().catch(() => {});
                if (!settled)
                  fail(
                    new Error(
                      'The subscription connection closed before completing. Check the connection in Settings > Models.',
                    ),
                  );
              },
            },
          );
          if (settled) {
            stop();
            return;
          }
          await process.started;
          if (settled) {
            stop();
            return;
          }
          requestSent = true;
          process.write(
            JSON.stringify({
              ...connection,
              modelId,
              context,
              capabilities,
              temperature: options.temperature,
              maxTokens: options.maxOutputTokens,
              reasoning: reasoning === true ? 'medium' : reasoning === false ? 'off' : reasoning,
              toolChoice: options.toolChoice,
            }) + '\n',
            { end: true },
          );
        } catch (error) {
          fail(error);
        }
      })();
      return { stream };
    },
  };
  return model;
}
