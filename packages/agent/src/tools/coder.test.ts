import { describe, expect, it } from 'vitest';
import { labelFor } from '../activity/labels.js';
import { WaitFor } from '../gated.js';
import { createPolicy } from '../policy/index.js';
import {
  CODE_TASK_PROMPT_MAX,
  CODER_UNAVAILABLE,
  CodeTaskInputSchema,
  defaultCoderAgent,
  type CoderAccountView,
  type CoderServices,
  type CoderStartInput,
  type CoderStarted,
  type RepoRef,
} from './coder.js';
import { toolFacts, toolsFor } from './index.js';
import type { ToolContext } from './types.js';

// code_task (I9): the tool's input and defaults, the wait on the posted
// widget, its errors as tool results, and its policy default.

const run = { id: 'run-1', botId: 'bot-1', chatId: 'chat-1', trigger: 'message' };
const memory = {
  remember: async () => ({ id: 'm', kind: 'fact' as const, content: '' }),
  search: async () => [],
};
const SESSION = '7f3a2c1e-9b8d-4e6f-a5c4-3b2a1f0e9d8c';

const relay: RepoRef = {
  id: 'repo-1',
  full_name: 'danielpang/openbots-relay',
  default_branch: 'main',
  path: '/home/coder/repos/danielpang/openbots-relay',
  description: 'The relay',
  state: 'ready',
};

function coder(
  more: { accounts?: CoderAccountView[]; started?: Partial<CoderStarted> } & Partial<
    Pick<CoderServices, 'defaultAgent' | 'start'>
  > = {},
) {
  const started: CoderStartInput[] = [];
  const services: CoderServices = {
    ...(more.defaultAgent ? { defaultAgent: more.defaultAgent } : {}),
    repos: async () => [relay],
    accounts: async () => more.accounts ?? [],
    start:
      more.start ??
      (async (input) => {
        started.push(input);
        return {
          sessionId: SESSION,
          posted: { messageId: 'm-1', partIndex: 2 },
          label: 'Coding: openbots-relay with Claude Code',
          props: { session_id: SESSION, repo: input.repo },
          ...more.started,
        };
      }),
  };
  return { services, started };
}

const ctx = (services?: CoderServices): ToolContext => ({
  run,
  memory,
  ...(services ? { coder: services } : {}),
});

async function call(args: unknown, context: ToolContext) {
  const tool = toolsFor(context).code_task!;
  const parsed = tool.inputSchema.parse(args);
  return tool.execute(parsed as never, context).catch((e: unknown) => e);
}

describe('code_task input', () => {
  it('needs a repository and a prompt, and checks mode, agent and session id', () => {
    const ok = CodeTaskInputSchema.safeParse({ repo: ' a/b ', prompt: ' Fix it ' });
    expect(ok.success && ok.data).toEqual({ repo: 'a/b', prompt: 'Fix it' });
    for (const bad of [
      { prompt: 'Fix it' },
      { repo: 'a/b', prompt: '  ' },
      { repo: 'a/b', prompt: 'x'.repeat(CODE_TASK_PROMPT_MAX + 1) },
      { repo: 'a/b', prompt: 'x', mode: 'push' },
      { repo: 'a/b', prompt: 'x', agent: 'cursor' },
      { repo: 'a/b', prompt: 'x', session_id: 'not-a-uuid' },
    ]) {
      expect(CodeTaskInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(
      CodeTaskInputSchema.safeParse({ repo: 'a/b', prompt: 'x'.repeat(CODE_TASK_PROMPT_MAX) })
        .success,
    ).toBe(true);
  });
});

describe('code_task', () => {
  it('is offered only with coding agents', () => {
    expect(toolsFor(ctx())).not.toHaveProperty('code_task');
    expect(toolFacts(ctx(coder().services)).get('code_task')).toEqual({
      group: 'coder',
      annotations: { readOnlyHint: false, destructiveHint: false },
    });
  });

  it('starts the session and waits on the widget the server posted', async () => {
    const { services, started } = coder();
    const thrown = await call(
      {
        agent: 'codex',
        repo: 'DanielPang/OpenBots-Relay',
        prompt: 'Fix the reconnect loop',
        mode: 'pr',
        branch: 'bot/relay',
        base: 'develop',
        session_id: SESSION,
      },
      ctx(services),
    );
    expect(thrown).toBeInstanceOf(WaitFor);
    expect((thrown as WaitFor).request).toEqual({
      reason: 'widget',
      widget: {
        kind: 'coding_session',
        props: { session_id: SESSION, repo: 'danielpang/openbots-relay' },
      },
      label: 'Coding: openbots-relay with Claude Code',
      posted: { messageId: 'm-1', partIndex: 2 },
    });
    expect(started).toEqual([
      {
        agent: 'codex',
        repo: 'danielpang/openbots-relay',
        prompt: 'Fix the reconnect loop',
        mode: 'pr',
        branch: 'bot/relay',
        base: 'develop',
        session_id: SESSION,
      },
    ]);
  });

  it('defaults to edit mode and the default agent, and finds a repository by id', async () => {
    const { services, started } = coder({ defaultAgent: 'pi' });
    await call({ repo: 'repo-1', prompt: 'Add a test' }, ctx(services));
    expect(started).toEqual([
      { agent: 'pi', repo: 'danielpang/openbots-relay', prompt: 'Add a test', mode: 'edit' },
    ]);
  });

  it('waits on a sign-in widget when the server returns one', async () => {
    const { services } = coder({ started: { kind: 'coder_login', label: 'Waiting for sign-in' } });
    const thrown = await call({ repo: relay.full_name, prompt: 'x' }, ctx(services));
    expect((thrown as WaitFor).request).toMatchObject({
      widget: { kind: 'coder_login' },
      label: 'Waiting for sign-in',
    });
  });

  it('says so when there are no coding agents or the repository is unknown', async () => {
    const tool = toolsFor(ctx(coder().services)).code_task!;
    await expect(tool.execute({ repo: 'a/b', prompt: 'x' } as never, ctx())).rejects.toThrow(
      CODER_UNAVAILABLE,
    );
    const { services, started } = coder();
    const unknown = await call({ repo: 'someone/else', prompt: 'x' }, ctx(services));
    expect((unknown as Error).message).toBe(
      'Unknown repository someone/else. Your repositories: danielpang/openbots-relay.',
    );
    const none = { ...services, repos: async () => [] };
    expect(((await call({ repo: 'a/b', prompt: 'x' }, ctx(none))) as Error).message).toMatch(
      /you have no repositories yet/,
    );
    expect(started).toEqual([]);
  });

  it("passes the server's refusal on as the tool's error", async () => {
    const { services } = coder({
      start: async () => {
        throw new Error('Coding agents are turned off for this Bot');
      },
    });
    const thrown = await call({ repo: relay.full_name, prompt: 'x' }, ctx(services));
    expect(thrown).not.toBeInstanceOf(WaitFor);
    expect((thrown as Error).message).toBe('Coding agents are turned off for this Bot');
  });
});

describe('defaultCoderAgent', () => {
  it("takes the Bot's default, else the first agent signed in, else Claude Code", async () => {
    const accounts: CoderAccountView[] = [
      { agent: 'claude', authKind: 'none' },
      { agent: 'pi', authKind: 'api_key' },
      { agent: 'codex', authKind: 'subscription' },
    ];
    expect(await defaultCoderAgent(coder({ defaultAgent: 'pi', accounts }).services)).toBe('pi');
    expect(await defaultCoderAgent(coder({ accounts }).services)).toBe('codex');
    expect(await defaultCoderAgent(coder().services)).toBe('claude');
  });
});

describe('code_task policy and label', () => {
  it('runs by default, but asks in a webhook run', () => {
    const facts = toolFacts(ctx(coder().services));
    const policy = createPolicy({ facts: (n) => facts.get(n) });
    expect(policy.evaluate(run, 'code_task', {})).toMatchObject({ decision: 'auto' });
    expect(policy.evaluate({ ...run, trigger: 'webhook' }, 'code_task', {})).toMatchObject({
      decision: 'ask',
    });
    const off = createPolicy({
      facts: (n) => facts.get(n),
      toolPolicy: { groups: { coder: 'deny' } },
    });
    expect(off.evaluate(run, 'code_task', {})).toMatchObject({ decision: 'deny' });
  });

  it('reads "Coding: <repo> with <agent>", the same once the session ends', () => {
    const args = { agent: 'claude', repo: 'danielpang/openbots-relay', prompt: 'x' };
    expect(labelFor('code_task', args)).toBe('Coding: openbots-relay with Claude Code');
    expect(labelFor('code_task', args, { status: 'settled' })).toBe(
      'Coding: openbots-relay with Claude Code',
    );
    expect(labelFor('code_task', { repo: 'openbots-relay.git' })).toBe('Coding: openbots-relay');
    expect(labelFor('code_task', {})).toBe('Coding: a repository');
  });
});
