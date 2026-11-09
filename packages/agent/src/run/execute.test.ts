import type { MessagePart } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import { assembleContext } from '../context/assemble.js';
import { defaultPolicy, type Policy } from '../policy/index.js';
import { promptText, scriptedModel, type ScriptedTurn } from '../testing.js';
import { toolsFor } from '../tools/index.js';
import type { MemoryItem, ToolContext } from '../tools/types.js';
import { ContextOverflowError } from './errors.js';
import {
  executeRun,
  type ExecuteRunInput,
  type RunCheckpointer,
  type StepRecord,
} from './execute.js';
import { toolCallMessages } from './call.js';
import {
  injectToolResult,
  INTERRUPTED_RESULT,
  resumeFromCheckpoint,
  trimContext,
  WAITING_RESULT,
  type RunCheckpoint,
} from './state.js';

const run = { id: 'run-1', botId: 'bot-1', chatId: 'chat-1', trigger: 'message' };

function harness(turns: ScriptedTurn[], overrides: Partial<ExecuteRunInput> = {}) {
  const model = scriptedModel(turns);
  const parts: MessagePart[] = [];
  const steps: StepRecord[] = [];
  const states: [string, string | null][] = [];
  const memories: MemoryItem[] = [];
  const steering: string[][] = [];
  const toolContext: ToolContext = {
    run,
    memory: {
      remember: async ({ kind, content }) => {
        const item = { id: `m${memories.length + 1}`, kind, content };
        memories.push(item);
        return item;
      },
      search: async (query) => memories.filter((m) => m.content.includes(query)),
    },
  };
  const appendText = (type: 'text' | 'reasoning', text: string) => {
    const last = parts.at(-1);
    if (last?.type === type) last.text += text;
    else parts.push({ type, text });
  };
  const input: ExecuteRunInput = {
    run,
    model,
    instructions: 'You are a test Bot.',
    messages: [{ role: 'user', content: '[@dana (owner)] hello' }],
    tools: toolsFor(toolContext),
    toolContext,
    policy: defaultPolicy,
    abortSignal: new AbortController().signal,
    sink: {
      text: async (t) => appendText('text', t),
      reasoning: async (t) => appendText('reasoning', t),
      part: async (p) => parts.push(p) - 1,
    },
    setState: async (state, action) => {
      states.push([state, action]);
    },
    recordStep: async (step) => {
      steps.push(step);
    },
    drainSteering: async () => steering.shift() ?? [],
    ...overrides,
  };
  return { model, input, parts, steps, states, memories, steering };
}

describe('executeRun', () => {
  it('streams a prose reply and reports usage', async () => {
    const h = harness([[{ reasoning: 'hmm' }, { text: 'Hello there, Dana.' }]]);
    const outcome = await executeRun(h.input);
    expect(outcome).toMatchObject({
      status: 'completed',
      text: 'Hello there, Dana.',
      usage: { inputTokens: 101, outputTokens: 10, steps: 1 },
    });
    expect(h.parts).toEqual([
      { type: 'reasoning', text: 'hmm' },
      { type: 'text', text: 'Hello there, Dana.' },
    ]);
    expect(h.steps).toEqual([
      expect.objectContaining({
        type: 'llm',
        label: 'Thought briefly',
        tokensIn: 101,
        tokensOut: 10,
      }),
    ]);
  });

  it('continues a queued group run whose latest message is its own reply without assistant prefill', async () => {
    const context = assembleContext({
      bot: { name: 'Scout', handle: 'scout', label: null, description: '' },
      roster: [
        { name: 'Scout', handle: 'scout', kind: 'bot', self: true },
        { name: 'Researcher', handle: 'researcher', kind: 'bot' },
      ],
      skills: [],
      memories: [],
      summary: null,
      messages: [
        {
          seq: 1,
          author: { kind: 'owner', handle: 'dana' },
          parts: [{ type: 'text', text: 'Discuss this together.' }],
        },
        {
          seq: 2,
          author: { kind: 'bot', handle: 'researcher' },
          parts: [{ type: 'text', text: '@scout please review.' }],
        },
        {
          seq: 3,
          author: { kind: 'bot', handle: 'scout', self: true },
          parts: [{ type: 'text', text: 'Here is my review.' }],
        },
      ],
    });
    expect(context.messages.at(-1)!.role).toBe('assistant');
    const checkpoints: unknown[] = [];
    const h = harness([[{ text: 'Nothing further to add.' }]], {
      ...context,
      checkpoint: {
        step: async (messages) => {
          checkpoints.push(messages);
        },
        started: async () => {},
        finished: async () => {},
      },
    });

    expect(await executeRun(h.input)).toMatchObject({ status: 'completed' });
    const prompt = h.model.calls[0]!.prompt;
    expect(prompt.map((m) => m.role)).toEqual([
      'system',
      'system',
      'user',
      'user',
      'assistant',
      'user',
    ]);
    expect(prompt.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: expect.stringContaining('[system] Continue') }],
    });
    expect(checkpoints).toEqual([
      [
        ...context.messages,
        {
          role: 'user',
          content: expect.stringContaining('[system] Continue'),
        },
      ],
    ]);
    // Normalization must not mutate the transcript or duplicate on checkpoint resume.
    expect(context.messages).toHaveLength(3);
    const resumed = harness([[{ text: 'Done.' }]], {
      messages: checkpoints[0] as ExecuteRunInput['messages'],
    });
    await executeRun(resumed.input);
    expect(resumed.model.calls[0]!.prompt.slice(1)).toEqual(prompt.slice(2));
  });

  it('uses real steering instead of a synthetic continuation after an assistant message', async () => {
    const h = harness([[{ text: 'Following the new request.' }]], {
      messages: [
        { role: 'user', content: 'Review this.' },
        { role: 'assistant', content: 'Here is my review.' },
      ],
    });
    h.steering.push(['[@dana (owner)] Now summarize it.']);
    await executeRun(h.input);
    expect(h.model.calls[0]!.prompt.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(promptText(h.model.calls[0]!)).not.toContain('[system] Continue');
    expect(promptText(h.model.calls[0]!)).toContain('Now summarize it.');
  });

  it('runs a tool through gated(): working with the label, then a labeled step', async () => {
    const h = harness([
      [{ tool: 'remember', args: { kind: 'preference', content: 'Prefers tabs' }, id: 'c1' }],
      [{ text: 'Noted.' }],
    ]);
    const outcome = await executeRun(h.input);
    expect(outcome.status).toBe('completed');
    expect(h.memories).toEqual([{ id: 'm1', kind: 'preference', content: 'Prefers tabs' }]);
    expect(h.states).toEqual([
      ['working', "Remembering 'Prefers tabs'"],
      ['thinking', null],
    ]);
    expect(h.parts).toEqual([
      {
        type: 'tool_call',
        tool_call_id: 'c1',
        tool_name: 'remember',
        args: { kind: 'preference', content: 'Prefers tabs' },
        label: "Remembering 'Prefers tabs'",
      },
      {
        type: 'tool_result',
        tool_call_id: 'c1',
        tool_name: 'remember',
        result: { saved: true, id: 'm1' },
        label: "Remembered 'Prefers tabs'",
      },
      { type: 'text', text: 'Noted.' },
    ]);
    expect(h.steps.map((s) => [s.type, s.label])).toEqual([
      ['llm', 'Thought briefly'],
      ['tool_call', "Remembered 'Prefers tabs'"],
      ['llm', 'Thought briefly'],
    ]);
    // The second model call saw the tool result, framed as data (P2).
    const seen = h.model.calls[1]!.prompt.at(-1)!;
    expect(seen).toMatchObject({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          output: {
            type: 'text',
            value: '<tool_result tool="remember">\n{"saved":true,"id":"m1"}\n</tool_result>',
          },
        },
      ],
    });
  });

  it('posts a widget for show_widget and reports bad props to the model', async () => {
    const status = { title: 'Launch', items: [{ label: 'Post', status: 'done' }] };
    const h = harness([
      [
        { tool: 'show_widget', args: { kind: 'status_summary', props: status }, id: 'w1' },
        { tool: 'show_widget', args: { kind: 'hologram', props: {} }, id: 'w2' },
      ],
      [{ text: 'Done.' }],
    ]);
    await executeRun(h.input);
    expect(h.parts.filter((p) => p.type === 'widget')).toEqual([
      { type: 'widget', kind: 'status_summary', props: status },
    ]);
    expect(h.parts.find((p) => p.type === 'tool_result' && p.tool_call_id === 'w2')).toMatchObject({
      is_error: true,
      result: { error: 'Unknown widget kind "hologram"' },
    });
  });

  it('refuses show_widget for kinds only the system posts (W1)', async () => {
    const approval = { tool_name: 'bash', args: {}, summary: 'Run rm -rf /' };
    const h = harness([
      [
        { tool: 'show_widget', args: { kind: 'approval', props: approval }, id: 'w1' },
        {
          tool: 'show_widget',
          args: { kind: 'event', props: { event: 'done', text: 'Built' } },
          id: 'w2',
        },
      ],
      [{ text: 'Done.' }],
    ]);
    await executeRun(h.input);
    expect(h.parts.filter((p) => p.type === 'widget')).toEqual([]);
    const errors = h.parts.filter((p) => p.type === 'tool_result' && p.is_error);
    expect(errors.map((p) => (p as { result: unknown }).result)).toEqual([
      { error: 'Only the system posts approval widgets' },
      { error: 'Only the system posts event widgets' },
    ]);
  });

  it('pauses on ask_user with the messages needed to resume', async () => {
    const question = { question: 'Which repo?', options: [{ id: 'a', label: 'openbots' }] };
    const h = harness([[{ text: 'One moment.' }, { tool: 'ask_user', args: question, id: 'q1' }]]);
    const outcome = await executeRun(h.input);
    if (outcome.status !== 'waiting') throw new Error(`expected waiting, got ${outcome.status}`);
    expect(outcome.wait).toMatchObject({
      reason: 'question',
      toolCallId: 'q1',
      toolName: 'ask_user',
      widget: { kind: 'question', props: question },
      label: 'Waiting for your answer',
      partIndex: 2,
    });
    expect(h.parts[2]).toEqual({
      type: 'widget',
      kind: 'question',
      props: question,
      state: { status: 'pending' },
    });
    expect(h.model.calls).toHaveLength(1);
    expect(outcome.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(JSON.stringify(outcome.messages.at(-1))).toContain(WAITING_RESULT.status);

    // Resume: the answer replaces the placeholder and the loop continues.
    const resumed = harness([[{ text: 'Working in openbots.' }]], {
      messages: injectToolResult(outcome.messages, 'q1', { answered: true, option_id: 'a' }),
    });
    const done = await executeRun(resumed.input);
    expect(done).toMatchObject({ status: 'completed', text: 'Working in openbots.' });
    const prompt = promptText(resumed.model.calls[0]!);
    expect(prompt).toContain('<tool_result tool="ask_user">\n{"answered":true,"option_id":"a"}');
    expect(prompt).not.toContain(WAITING_RESULT.status);
  });

  it('pauses on request_login: its own widget, or none when the main Bot posted it (K8)', async () => {
    const args = { site: 'github.com', reason: 'Read the private repo' };
    const props = { site: 'github.com', reason: args.reason };
    const withLogins = (posted?: { messageId: string; partIndex: number }): ToolContext => ({
      run,
      memory: {
        remember: async () => ({ id: 'm', kind: 'fact', content: '' }),
        search: async () => [],
      },
      logins: {
        request: async ({ site }) => ({
          site,
          widget: { kind: 'login_request', props },
          ...(posted ? { posted } : {}),
        }),
      },
    });
    const step = [{ tool: 'request_login', args, id: 'l1' }];

    const here = withLogins();
    const local = harness([step], { toolContext: here, tools: toolsFor(here) });
    const waiting = await executeRun(local.input);
    expect(waiting).toMatchObject({
      status: 'waiting',
      wait: {
        reason: 'widget',
        toolName: 'request_login',
        label: 'Waiting for sign-in: github.com',
        partIndex: 1,
      },
    });
    expect(local.parts[1]).toMatchObject({ type: 'widget', kind: 'login_request', props });

    const posted = { messageId: 'main-message', partIndex: 0 };
    const there = withLogins(posted);
    const routed = harness([step], { toolContext: there, tools: toolsFor(there) });
    const elsewhere = await executeRun(routed.input);
    expect(elsewhere).toMatchObject({
      status: 'waiting',
      wait: { toolName: 'request_login', posted, messageId: 'main-message', partIndex: 0 },
    });
    expect(routed.parts.map((p) => p.type)).toEqual(['tool_call', 'tool_result']);
    expect(routed.parts[1]).toMatchObject({
      result: WAITING_RESULT,
      label: 'Asked for a sign-in to github.com',
    });
  });

  it('pauses for approval when the policy says ask', async () => {
    const ask: Policy = { evaluate: (_run, tool) => (tool === 'remember' ? 'ask' : 'auto') };
    const h = harness([[{ tool: 'remember', args: { kind: 'fact', content: 'x' }, id: 'r1' }]], {
      policy: ask,
    });
    const outcome = await executeRun(h.input);
    expect(outcome).toMatchObject({
      status: 'waiting',
      wait: { reason: 'approval', toolName: 'remember', widget: { kind: 'approval' } },
    });
    expect(h.memories).toEqual([]);
  });

  it('refuses a denied tool without running it', async () => {
    const deny: Policy = { evaluate: () => 'deny' };
    const h = harness(
      [[{ tool: 'remember', args: { kind: 'fact', content: 'x' }, id: 'r1' }], [{ text: 'Ok.' }]],
      { policy: deny },
    );
    await executeRun(h.input);
    expect(h.memories).toEqual([]);
    expect(h.parts[1]).toMatchObject({ result: { error: 'Denied by Bot policy' } });
  });

  it('injects steering messages between steps and records a steer step', async () => {
    const h = harness([
      [{ tool: 'search_memory', args: { query: 'x' }, id: 's1' }],
      [{ text: 'Switching to the blue one.' }],
    ]);
    h.steering.push([], ['[@dana (owner)] actually, use the blue one']);
    await executeRun(h.input);
    expect(h.steps.map((s) => s.type)).toEqual(['llm', 'tool_call', 'steer', 'llm']);
    expect(h.steps[2]!.label).toBe('Steered: actually, use the blue one');
    expect(promptText(h.model.calls[1]!)).toMatch(
      /<\/tool_result>>\nuser: \[@dana \(owner\)\] actually/,
    );
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    const h = harness([[{ tool: 'search_memory', args: { query: 'x' } }], [{ text: 'never' }]], {
      abortSignal: controller.signal,
      drainSteering: async () => {
        controller.abort();
        return [];
      },
    });
    const outcome = await executeRun(h.input);
    expect(outcome.status).toBe('cancelled');
    expect(h.parts.some((p) => p.type === 'text')).toBe(false);
  });

  it('classifies a context overflow before any output', async () => {
    const h = harness(
      [{ error: new Error('prompt is too long: 250000 tokens > 200000 maximum') }],
      {
        maxRetries: 0,
      },
    );
    await expect(executeRun(h.input)).rejects.toBeInstanceOf(ContextOverflowError);
  });

  it('checkpoints the messages before each step and each call around its run (K4)', async () => {
    const log: unknown[] = [];
    const h = harness(
      [
        [{ tool: 'remember', args: { kind: 'fact', content: 'x' }, id: 'c1' }],
        [{ text: 'Noted.' }],
      ],
      {
        checkpoint: {
          step: async (messages, usage) => {
            log.push(['step', messages.map((m) => m.role), usage.steps]);
          },
          started: async (call) => {
            // The tool has not run yet when its start is recorded.
            log.push(['started', call, h.memories.length]);
          },
          finished: async (id, output) => {
            log.push(['finished', id, output.type, h.memories.length]);
          },
        },
      },
    );
    await executeRun(h.input);
    expect(log).toEqual([
      ['step', ['user'], 0],
      [
        'started',
        { toolCallId: 'c1', toolName: 'remember', input: { kind: 'fact', content: 'x' } },
        0,
      ],
      ['finished', 'c1', 'text', 1],
      ['step', ['user', 'assistant', 'tool'], 1],
    ]);
  });

  it('records no start for a call the policy denied or held for approval', async () => {
    const started: string[] = [];
    const checkpoint = {
      step: async () => {},
      started: async (call: { toolCallId: string }) => {
        started.push(call.toolCallId);
      },
      finished: async () => {},
    };
    const ask: Policy = { evaluate: (_run, tool) => (tool === 'remember' ? 'ask' : 'deny') };
    const h = harness(
      [
        [
          { tool: 'search_memory', args: { query: 'x' }, id: 'd1' },
          { tool: 'remember', args: { kind: 'fact', content: 'x' }, id: 'a1' },
        ],
      ],
      { policy: ask, checkpoint },
    );
    expect((await executeRun(h.input)).status).toBe('waiting');
    expect(started).toEqual([]);
  });

  it('continues a checkpoint: finished calls keep results, cut-off ones are unknown (K4)', async () => {
    const remember = { kind: 'fact', content: 'x' };
    const rebuilt = resumeFromCheckpoint({
      messages: [{ role: 'user', content: '[@dana (owner)] hello' }],
      calls: [
        {
          toolCallId: 'done1',
          toolName: 'remember',
          input: remember,
          output: { type: 'text', value: 'saved it' },
        },
        { toolCallId: 'cut1', toolName: 'search_memory', input: { query: 'x' } },
      ],
    });
    expect(rebuilt.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    const h = harness([[{ text: 'Checking whether the search went through.' }]], {
      messages: rebuilt,
    });
    expect(await executeRun(h.input)).toMatchObject({ status: 'completed' });
    const prompt = promptText(h.model.calls[0]!);
    expect(prompt).toContain('saved it');
    expect(prompt).toContain(INTERRUPTED_RESULT.message);
    expect(h.memories).toEqual([]);

    // A call made outside the loop is already in the messages, with a placeholder.
    const outside = resumeFromCheckpoint({
      messages: toolCallMessages(
        { toolCallId: 'o1', toolName: 'remember', args: remember },
        'remember',
      ),
      calls: [{ toolCallId: 'o1', toolName: 'remember', input: remember, inMessages: true }],
    });
    expect(outside).toHaveLength(2);
    expect(JSON.stringify(outside)).not.toContain(WAITING_RESULT.status);
    expect(JSON.stringify(outside)).toContain('interrupted_by_restart');
  });

  const none = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, steps: 0 };

  it("keeps a cut-off step's reasoning and text for the takeover (K4)", async () => {
    // A checkpoint store like the server's: what a crash right after the tool ran would leave.
    let current: RunCheckpoint = {
      messageId: 'm',
      messages: [],
      calls: [],
      seenSeq: 0,
      usage: none,
    };
    let atCrash: RunCheckpoint | undefined;
    const checkpoint: RunCheckpointer = {
      step: async (messages) => {
        current = { ...current, messages, calls: [] };
        delete current.reply;
      },
      started: async (call) => {
        current.calls.push(call);
      },
      finished: async (id, output) => {
        current.calls.find((c) => c.toolCallId === id)!.output = output;
        atCrash ??= structuredClone(current);
      },
      reply: async (content) => {
        current.reply = content;
      },
    };
    const h = harness(
      [
        [
          { reasoning: 'Save it first.', signature: 'sig-1' },
          { text: 'Saving.' },
          { tool: 'remember', args: { kind: 'fact', content: 'x' }, id: 'c1' },
        ],
        [{ text: 'Noted.' }],
      ],
      { checkpoint },
    );
    await executeRun(h.input);
    const rebuilt = resumeFromCheckpoint(atCrash!);
    expect(rebuilt.at(-2)).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Save it first.',
          providerOptions: { anthropic: { signature: 'sig-1' } },
        },
        { type: 'text', text: 'Saving.' },
        expect.objectContaining({ type: 'tool-call', toolCallId: 'c1', toolName: 'remember' }),
      ],
    });
    expect(rebuilt.at(-1)).toMatchObject({ role: 'tool', content: [{ toolCallId: 'c1' }] });
  });

  it('stops at max_steps', async () => {
    const loop = Array.from({ length: 5 }, (_, i) => [
      { tool: 'search_memory', args: { query: `q${i}` } },
    ]);
    const h = harness(loop, { maxSteps: 2 });
    await executeRun(h.input);
    expect(h.model.calls).toHaveLength(2);
  });
});

describe('trimContext (plan 5.7)', () => {
  const user = (text: string) => ({ role: 'user' as const, content: text });
  const said = (text: string) => ({ role: 'assistant' as const, content: text });
  const own = [
    ...toolCallMessages({ toolCallId: 'c1', toolName: 'bash', args: {} }, 'bash', { ok: 1 }),
    user('steer'),
  ];

  it("drops the oldest half of the transcript part at a user message, keeping the run's own work", () => {
    const transcript = [user('u1'), said('a1'), user('u2'), said('a2'), user('u3'), said('a3')];
    const trimmed = trimContext([...transcript, ...own], transcript.length);
    expect(trimmed).toEqual({
      messages: [user('u3'), said('a3'), ...own],
      contextLength: 2,
    });
    // Once more: nothing past the first message is a user turn to start from.
    expect(trimContext(trimmed!.messages, trimmed!.contextLength)).toBeNull();
  });

  it('never cuts into the run, nor between a call and its result', () => {
    const replayed = [
      user('u1'),
      ...toolCallMessages({ toolCallId: 'old', toolName: 'bash', args: {} }, 'bash', { ok: 0 }),
      said('done'),
    ];
    // No user turn in the later half of the transcript part: no cut.
    expect(trimContext([...replayed, ...own], replayed.length)).toBeNull();
    expect(trimContext([user('u1'), ...own], 1)).toBeNull();
  });
});
