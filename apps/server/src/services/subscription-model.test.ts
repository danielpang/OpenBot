import { createAgentClient, type ComputerAgentClient } from '@openbots/computer';
import { startFakeAgent, type FakeAgent } from '@openbots/computer/testing';
import { generateText, streamText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUBSCRIPTION_BRIDGE,
  subscriptionContext,
  subscriptionModel,
} from './subscription-model.js';

const finish = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 5, noCache: 4, cacheRead: 1, cacheWrite: 0 },
    outputTokens: { total: 2 },
  },
};
describe('subscription model transport', () => {
  let agent: FakeAgent;
  let client: ComputerAgentClient;
  beforeEach(async () => {
    agent = await startFakeAgent();
    client = createAgentClient({ url: agent.url, token: agent.token });
  });
  afterEach(() => agent.close());
  const model = () =>
    subscriptionModel(async () => client, { agent: 'codex', provider: 'openai-codex' }, 'gpt-5.5');
  const script = (parts: unknown[]) => {
    agent.coderScript = async (session) => {
      session.send({ type: 'started', pid: 1, session_dir: '/tmp/subscription' });
      await session.next('stdin');
      const data = parts.map((p) => JSON.stringify(p)).join('\n') + '\n';
      // Deliberately split in the middle of a JSON event.
      session.send({ type: 'stdout', data: data.slice(0, 17) });
      session.send({ type: 'stdout', data: data.slice(17) });
    };
  };
  it('streams and generates through the credential-owning computer with no secrets or coding permissions', async () => {
    script([
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: 'Hello' },
      { type: 'text-end', id: '0' },
      finish,
    ]);
    const result = await generateText({ model: model(), prompt: 'Hi', maxRetries: 0 });
    expect(result.text).toBe('Hello');
    expect(result.usage.inputTokens).toBe(5);
    expect(agent.coderStarts[0]).toMatchObject({
      command: 'node',
      args: [SUBSCRIPTION_BRIDGE],
      user: 'coder',
      git_credentials: false,
    });
    const request = agent.coderFrames.find((f) => f.type === 'stdin');
    expect(request?.type === 'stdin' && JSON.parse(request.data)).toMatchObject({
      agent: 'codex',
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      context: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] },
    });
  });
  it('returns tool calls to the existing server-side tool loop', async () => {
    script([
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input: '{"query":"hello"}' },
      { ...finish, finishReason: { unified: 'tool-calls', raw: 'toolUse' } },
    ]);
    const response = await model().doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Find it' }] }],
    });
    expect(response.content).toEqual([
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input: '{"query":"hello"}' },
    ]);
    expect(response.finishReason.unified).toBe('tool-calls');
  });
  it('surfaces subscription failures instead of trying an API key', async () => {
    script([{ type: 'error', error: 'Reconnect your subscription' }]);
    await expect(generateText({ model: model(), prompt: 'Hi', maxRetries: 0 })).rejects.toThrow(
      'subscription request failed',
    );
    expect(agent.coderStarts).toHaveLength(1);
  });
  it('records auth failures and recovery without forwarding raw credential-bearing errors', async () => {
    const state = vi.fn(async (_failed: boolean) => {});
    const connected = subscriptionModel(
      async () => client,
      { agent: 'codex', provider: 'openai-codex' },
      'gpt-5.5',
      undefined,
      undefined,
      state,
    );
    script([{ type: 'error', code: 'subscription_auth', error: 'secret-access secret-refresh' }]);
    await expect(connected.doGenerate({ prompt: [] })).rejects.toThrow(
      'Subscription is not signed in',
    );
    expect(state).toHaveBeenCalledWith(true);
    script([finish]);
    await connected.doGenerate({ prompt: [] });
    expect(state).toHaveBeenLastCalledWith(false);
  });

  it('fails an incomplete stream and closes its connection', async () => {
    agent.coderScript = async (session) => {
      session.send({ type: 'started', pid: 1, session_dir: '/tmp/subscription' });
      await session.next('stdin');
      session.send({ type: 'exit', code: 1, signal: null });
      session.close();
    };
    await expect(generateText({ model: model(), prompt: 'Hi', maxRetries: 0 })).rejects.toThrow(
      'closed before completing',
    );
  });
  it('cancels a request gracefully, allowing the credential owner to finish its refresh', async () => {
    agent.coderScript = async (session) => {
      session.send({ type: 'started', pid: 1, session_dir: '/tmp/subscription' });
      await session.next('stdin');
      await session.next('signal');
      session.send({ type: 'exit', code: 1, signal: null });
      session.close();
    };
    const controller = new AbortController();
    const { stream } = await model().doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      abortSignal: controller.signal,
    });
    const reader = stream.getReader();
    await reader.read();
    await vi.waitFor(() => expect(agent.coderFrames.some((f) => f.type === 'stdin')).toBe(true));
    controller.abort(new Error('Stopped by user'));
    await expect(reader.read()).rejects.toThrow('Stopped by user');
    await vi.waitFor(() =>
      expect(agent.coderFrames.some((f) => f.type === 'signal' && f.signal === 'SIGTERM')).toBe(
        true,
      ),
    );
    await vi.waitFor(() => expect(agent.coderSessions[0]?.closed).toBe(true));
  });
  it('does not open a connection for an already aborted request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Cancelled'));
    await expect(model().doStream({ prompt: [], abortSignal: controller.signal })).rejects.toThrow(
      'Cancelled',
    );
    expect(agent.coderStarts).toHaveLength(0);
  });

  it('supports streamed text in the AI SDK', async () => {
    script([
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: 'one' },
      { type: 'text-delta', id: '0', delta: ' two' },
      { type: 'text-end', id: '0' },
      finish,
    ]);
    const result = streamText({ model: model(), prompt: 'Hi', maxRetries: 0 });
    const chunks: string[] = [];
    for await (const chunk of result.textStream) chunks.push(chunk);
    expect(chunks.join('')).toBe('one two');
  });
});

describe('subscription prompt conversion', () => {
  it('drops Responses item IDs, while preserving matching tool-call IDs for replay', () => {
    const context = subscriptionContext(
      {
        prompt: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolName: 'lookup',
                toolCallId: 'call_test|fc_paired_with_reasoning',
                input: {},
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolName: 'lookup',
                toolCallId: 'call_test|fc_paired_with_reasoning',
                output: { type: 'text', value: 'Found' },
              },
            ],
          },
        ],
      },
      'openai-codex',
      'gpt-5.5',
    );
    expect(context.messages[0]).toMatchObject({ content: [{ id: 'call_test' }] });
    expect(context.messages[1]).toMatchObject({ toolCallId: 'call_test' });
    expect(JSON.stringify(context)).not.toContain('fc_paired');
  });
  it('preserves history, tool schemas, screenshots and denied tool results', () => {
    const context = subscriptionContext(
      {
        prompt: [
          { role: 'system', content: 'Be useful' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look' },
              {
                type: 'file',
                mediaType: 'image/png',
                data: { type: 'data', data: new Uint8Array([1, 2]) },
              },
            ],
          },
          {
            role: 'assistant',
            content: [{ type: 'tool-call', toolName: 'screenshot', toolCallId: '1', input: {} }],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolName: 'screenshot',
                toolCallId: '1',
                output: {
                  type: 'content',
                  value: [
                    { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'cG5n' } },
                  ],
                },
              },
              {
                type: 'tool-result',
                toolName: 'bash',
                toolCallId: '2',
                output: { type: 'execution-denied', reason: 'Not approved' },
              },
            ],
          },
        ],
        tools: [
          { type: 'function', name: 'screenshot', inputSchema: { type: 'object', properties: {} } },
        ],
      },
      'openai-codex',
      'gpt-5.5',
    );
    expect(context.systemPrompt).toBe('Be useful');
    expect(context.messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'Look' },
        { type: 'image', data: 'AQI=', mimeType: 'image/png' },
      ],
    });
    expect(context.messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'toolCall', id: '1', name: 'screenshot', arguments: {} }],
    });
    expect(context.messages[2]).toMatchObject({
      role: 'toolResult',
      content: [{ type: 'image', data: 'cG5n', mimeType: 'image/png' }],
    });
    expect(context.messages[3]).toMatchObject({
      role: 'toolResult',
      isError: true,
      content: [{ type: 'text', text: 'Not approved' }],
    });
    expect(context.tools?.[0]).toMatchObject({
      name: 'screenshot',
      parameters: { type: 'object' },
    });
  });
});
