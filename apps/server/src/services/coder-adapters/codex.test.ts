import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CODER_ACTIONS, type CoderEvent } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import { ptySignIn } from '../__fixtures__/coders/adapters.js';
import { codexAdapter, codexBilling, codexParser, codexStatus, preamble } from './codex.js';
import { adapterFor, IGNORED_SESSION_ID } from './index.js';
import type {
  CoderLoginParse,
  CoderOutputParser,
  CoderSessionApproval,
  CoderSessionSpec,
} from './types.js';

// The Codex CLI adapter against the fixtures in services/__fixtures__/coders:
// `codex-needs-login.jsonl` (app-server with no sign-in) and `codex-login.txt`
// are captures of the pinned 0.166.0; `codex-success.jsonl` and
// `codex-approval.jsonl` are built from its generated protocol schema.

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../__fixtures__/coders');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

const WORKTREE = '/home/bot/repos/acme/relay/.worktrees/bot-fix-reconnect';
const VENDOR = '01a1ad70-3c2e-7a41-9b0d-5e8f2c4a6b10';
const REPO = '/home/bot/repos/acme/relay';

const spec = (over: Partial<CoderSessionSpec> = {}): CoderSessionSpec => ({
  sessionId: '00000000-0000-4000-8000-000000000001',
  agent: 'codex',
  mode: 'edit',
  prompt: 'Fix the reconnect loop',
  worktreePath: WORKTREE,
  repoFullName: 'acme/relay',
  branch: 'bot/fix-reconnect',
  base: 'main',
  maxTurns: 200,
  actions: { ...DEFAULT_CODER_ACTIONS },
  ...over,
});

const parse = (text: string, parser: CoderOutputParser = codexAdapter.parser()): CoderEvent[] => [
  ...text.split('\n').flatMap((line) => parser.line(line)),
  ...parser.end(),
];

const line = (value: unknown) => JSON.stringify(value);

/** The captured `initialize` answer: the first line of the needs-login capture. */
const INITIALIZE = fixture('codex-needs-login.jsonl').split('\n')[0]!;

/** A live session over a recorder: the frames it wrote, the events and the approvals. */
function session(over: CoderSessionSpec) {
  const writes: string[] = [];
  const events: CoderEvent[] = [];
  const approvals: CoderSessionApproval[] = [];
  const live = codexAdapter.session!(
    over,
    {
      write: (data) => writes.push(data),
      emit: (event) => events.push(event),
      approval: (request) => approvals.push(request),
    },
    { worktreePath: over.worktreePath },
  );
  return {
    session: live,
    events,
    approvals,
    frames: () => writes.map((w) => JSON.parse(w) as Record<string, unknown>),
    feed: (text: string) => {
      for (const l of text.split('\n')) live.onLine(l);
    },
  };
}

/** A transcript up to and with its first server request, and the rest. */
function splitAtRequest(text: string): [string, string] {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.includes('/requestApproval'));
  return [lines.slice(0, at + 1).join('\n'), lines.slice(at + 1).join('\n')];
}

describe('codex adapter', () => {
  it('is registered', () => {
    expect(adapterFor('codex')).toBe(codexAdapter);
    expect(codexAdapter.versionArgs).toEqual(['--version']);
    expect(codexAdapter.resumeCommand(VENDOR)).toBe(`codex resume ${VENDOR}`);
    // Only a UUID reaches the terminal's preset.
    expect(codexAdapter.resumeCommand('x; rm -rf ~')).toBe('codex');
    expect(ptySignIn(codexAdapter).hosts).toEqual([
      'auth.openai.com',
      'chatgpt.com',
      'openai.com',
      'platform.openai.com',
    ]);
  });

  it('launches app-server with the sandbox, the approval policy and the provider as overrides', () => {
    const plan = codexAdapter.launch(
      spec({
        repoPath: `${REPO}/`,
        gitIdentity: { name: 'Relay Bot', email: 'dana@example.com' },
      }),
    );
    expect(plan.command).toBe('codex');
    expect(plan.args).toEqual([
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      'approval_policy="on-request"',
      '-c',
      'approvals_reviewer="user"',
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'sandbox_workspace_write.network_access=false',
      '-c',
      `sandbox_workspace_write.writable_roots=["${REPO}/.git"]`,
      '-c',
      'model_provider="openai"',
    ]);
    // app-server has no --ignore-user-config, and the prompt goes over stdin.
    expect(plan.args).not.toContain('--ignore-user-config');
    expect(plan.args.join(' ')).not.toContain('Fix the reconnect loop');
    expect(plan.env).toEqual({
      GIT_AUTHOR_NAME: 'Relay Bot',
      GIT_AUTHOR_EMAIL: 'dana@example.com',
      GIT_COMMITTER_NAME: 'Relay Bot',
      GIT_COMMITTER_EMAIL: 'dana@example.com',
    });
    expect(plan.stdin).toBeUndefined();
    expect(plan.pty).toBeFalsy();
    expect(codexAdapter.transport).toBe('jsonrpc');
  });

  it('plans read-only with nothing more writable, and names a key provider for an API key', () => {
    const plan = codexAdapter.launch(spec({ mode: 'plan', repoPath: REPO })).args;
    expect(plan).toContain('sandbox_mode="read-only"');
    expect(plan.join(' ')).not.toContain('writable_roots');
    expect(preamble(spec({ mode: 'plan' }))).toContain('change nothing');
    expect(preamble(spec())).not.toContain('change nothing');
    const keyed = codexAdapter.launch(
      spec({ apiKeyProvider: 'openai', apiKeyBaseUrl: 'https://llm.example.com/v1' }),
    ).args;
    expect(keyed).toContain(
      'model_providers.openbots={name="OpenAI",env_key="OPENAI_API_KEY",wire_api="responses",base_url="https://llm.example.com/v1"}',
    );
    expect(keyed).toContain('model_provider="openbots"');
    expect(keyed).not.toContain('model_provider="openai"');
  });

  it('writes the handshake and the turn in order, each after the answer before it', () => {
    const s = session(spec({ repoPath: REPO, model: 'gpt-5-codex' }));
    expect(s.frames()).toEqual([
      {
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'openbots', title: 'OpenBots', version: '1.0.0' },
          capabilities: expect.objectContaining({
            experimentalApi: false,
            optOutNotificationMethods: expect.arrayContaining(['item/agentMessage/delta']),
          }),
        },
      },
    ]);
    s.feed(`${INITIALIZE}\n`);
    expect(s.frames().slice(1)).toEqual([
      { method: 'initialized' },
      {
        id: 2,
        method: 'thread/start',
        params: {
          cwd: WORKTREE,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandbox: 'workspace-write',
          model: 'gpt-5-codex',
        },
      },
    ]);
    s.feed(line({ id: 2, result: { thread: { id: VENDOR } } }));
    const turn = s.frames()[3]!;
    expect(turn).toMatchObject({
      id: 3,
      method: 'turn/start',
      params: {
        threadId: VENDOR,
        approvalPolicy: 'on-request',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [`${REPO}/.git`],
          networkAccess: false,
        },
      },
    });
    const text = (turn.params as { input: { type: string; text: string }[] }).input[0]!;
    expect(text.type).toBe('text');
    expect(text.text.endsWith('\n\nFix the reconnect loop')).toBe(true);
    expect(text.text).toContain('ask the owner to install dependencies');
    expect(s.frames()).toHaveLength(4);
  });

  it('resumes a vendor thread, and starts a new one when it is gone', () => {
    const s = session(spec({ resumeId: VENDOR, mode: 'plan' }));
    s.feed(`${INITIALIZE}\n`);
    expect(s.frames()[2]).toEqual({
      id: 2,
      method: 'thread/resume',
      params: {
        threadId: VENDOR,
        excludeTurns: true,
        cwd: WORKTREE,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
      },
    });
    s.feed(line({ id: 2, result: { thread: { id: VENDOR } } }));
    expect(s.frames()[3]).toMatchObject({
      method: 'turn/start',
      params: { threadId: VENDOR, sandboxPolicy: { type: 'readOnly', networkAccess: false } },
    });

    // As app-server answers an id it has no rollout for (VERIFIED).
    const gone = session(spec({ resumeId: VENDOR }));
    gone.feed(`${INITIALIZE}\n`);
    gone.feed(
      line({ error: { code: -32600, message: `no rollout found for thread id ${VENDOR}` }, id: 2 }),
    );
    expect(gone.events).toEqual([
      {
        type: 'text',
        text: `Codex could not continue its earlier thread (no rollout found for thread id ${VENDOR}), so it starts a new one`,
      },
    ]);
    expect(gone.frames()[3]).toMatchObject({ id: 3, method: 'thread/start' });

    // A resume id that is not a UUID never reaches the protocol: a new thread.
    const odd = session(spec({ resumeId: '--last' }));
    odd.feed(`${INITIALIZE}\n`);
    expect(odd.frames()[2]).toMatchObject({ method: 'thread/start' });
  });

  it('reads a successful turn in order, with usage and the result', () => {
    expect(parse(fixture('codex-success.jsonl'))).toEqual([
      {
        type: 'text',
        text: "Thinking: Inspecting the reconnect loop I'll read src/link.ts to see how the backoff resets after a successful connect.",
      },
      { type: 'command', command: 'sed -n 1,120p src/link.ts', exit_code: 0 },
      {
        type: 'text',
        text: "The backoff never resets after a successful connect, so I'll reset `delay` in the open handler.",
      },
      { type: 'file_change', path: 'src/link.ts', kind: 'edit' },
      { type: 'file_change', path: 'test/link.test.ts', kind: 'create' },
      { type: 'command', command: 'npm test', exit_code: 0 },
      {
        type: 'command',
        command: 'git commit -am "fix: reset reconnect backoff after a successful connect"',
        exit_code: 0,
      },
      {
        type: 'text',
        text: 'Reset the reconnect backoff after a successful connect in src/link.ts, added test/link.test.ts, and committed on bot/fix-reconnect. All 23 tests pass.',
      },
      { type: 'usage', input_tokens: 48213, output_tokens: 1874, billed: 'unknown' },
      {
        type: 'result',
        ok: true,
        summary:
          'Reset the reconnect backoff after a successful connect in src/link.ts, added test/link.test.ts, and committed on bot/fix-reconnect. All 23 tests pass.',
        vendor_session_id: VENDOR,
      },
    ]);
  });

  it("counts only this process: a resumed thread's earlier tokens are taken off", () => {
    const usage = (total: [number, number], last: [number, number]) =>
      line({
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            total: { inputTokens: total[0], outputTokens: total[1] },
            last: { inputTokens: last[0], outputTokens: last[1] },
          },
        },
      });
    const events = parse(
      [
        usage([10_100, 600], [100, 50]),
        usage([10_400, 700], [300, 100]),
        line({ method: 'turn/completed', params: { turn: { status: 'completed' } } }),
      ].join('\n'),
      codexParser({ billing: 'subscription' }),
    );
    expect(events[0]).toEqual({
      type: 'usage',
      input_tokens: 400,
      output_tokens: 150,
      billed: 'subscription',
    });
    expect(codexBilling('Logged in using ChatGPT\n')).toBe('subscription');
    expect(codexBilling('Logged in using an API key - sk-proj-***')).toBe('api');
    expect(codexBilling('Not logged in')).toBe('unknown');
  });

  it('reads a missing login as a failed turn that needs a sign-in', () => {
    // A capture of app-server with no sign-in: ten retries, then the turn fails on the 401.
    const events = parse(fixture('codex-needs-login.jsonl'));
    expect(events.map((e) => e.type)).toEqual(['error', 'result']);
    const [error, result] = events;
    expect((error as { message: string }).message).toMatch(/^unexpected status 401 Unauthorized/);
    expect(result).toMatchObject({
      type: 'result',
      ok: false,
      vendor_session_id: '01a1aecd-e1f2-76a0-ab15-5aa137cebe79',
    });
    const said = (result as { error?: string }).error!;
    expect(said).toContain('401 Unauthorized');
    expect(codexAdapter.needsLogin!(said)).toBe(true);
    expect(codexAdapter.needsLogin!('Not logged in')).toBe(true);
    expect(codexAdapter.needsLogin!('Tests failed: 3 of 23')).toBe(false);
    // The error code, when Codex's words lack it, so the runner can read it.
    const coded = parse(
      line({
        method: 'turn/completed',
        params: {
          turn: {
            status: 'failed',
            error: { message: 'Slow down', codexErrorInfo: 'rateLimitExceeded' },
          },
        },
      }),
    );
    expect(coded.at(-1)).toMatchObject({ ok: false, error: 'Slow down (rateLimitExceeded)' });
    expect(codexAdapter.rateLimited!('Slow down (rateLimitExceeded)')).toBe(true);
  });

  it('reports a turn that never completed as not ok, and nothing for an empty stream', () => {
    const events = parse(
      [
        line({ method: 'thread/started', params: { thread: { id: VENDOR } } }),
        line({ method: 'turn/started', params: { turn: { id: 't', status: 'inProgress' } } }),
      ].join('\n'),
    );
    expect(events).toEqual([
      {
        type: 'result',
        ok: false,
        summary: 'Codex did not finish',
        vendor_session_id: VENDOR,
        error: 'Codex did not finish',
      },
    ]);
    expect(parse('')).toEqual([]);
    expect(parse('not json\n{"method":')).toEqual([]);
    const interrupted = parse(
      line({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } }),
    );
    expect(interrupted.at(-1)).toMatchObject({ ok: false, error: 'Codex was interrupted' });
  });

  it('drops a thread id that is not a UUID', () => {
    const events = parse(
      [
        line({ method: 'thread/started', params: { thread: { id: '../../etc/passwd' } } }),
        line({ method: 'turn/completed', params: { turn: { status: 'completed' } } }),
      ].join('\n'),
    );
    expect(events[0]).toEqual({ type: 'text', text: IGNORED_SESSION_ID });
    expect(events.at(-1)).toEqual({ type: 'result', ok: true, summary: '' });
  });

  it('maps tool calls, deletes, failed commands and drops plans, retries and empty reasoning', () => {
    const items = [
      { type: 'reasoning', id: 'r', summary: ['   '], content: [] },
      { type: 'plan', id: 'p', text: '1. read' },
      { type: 'mcpToolCall', server: 'docs', tool: 'search', arguments: { q: 'backoff' } },
      { type: 'webSearch', id: 'w', query: 'exponential backoff', action: null },
      {
        type: 'fileChange',
        id: 'f',
        status: 'completed',
        changes: [{ path: `${WORKTREE}/old.ts`, kind: { type: 'delete' }, diff: '' }],
      },
      {
        type: 'fileChange',
        id: 'g',
        status: 'declined',
        changes: [{ path: 'x', kind: { type: 'add' } }],
      },
      {
        type: 'commandExecution',
        id: 'c',
        command: "/bin/bash -lc 'npm install left-pad'",
        aggregatedOutput: 'npm error network request failed\nnpm error code EAI_AGAIN\n',
        exitCode: 1,
        status: 'failed',
      },
      {
        type: 'commandExecution',
        id: 'd',
        command: 'rm -rf /',
        exitCode: null,
        status: 'declined',
      },
    ];
    const events = parse(
      [
        ...items.map((item) => line({ method: 'item/completed', params: { item } })),
        line({
          method: 'error',
          params: { error: { message: 'Reconnecting... 2/5' }, willRetry: true },
        }),
        line({ method: 'warning', params: { message: 'Falling back from WebSockets' } }),
      ].join('\n'),
      codexParser({ worktreePath: WORKTREE }),
    );
    expect(events).toEqual([
      { type: 'tool_use', name: 'docs.search', summary: '{"q":"backoff"}' },
      { type: 'tool_use', name: 'web_search', summary: 'exponential backoff' },
      { type: 'file_change', path: 'old.ts', kind: 'delete' },
      {
        type: 'command',
        command: 'npm install left-pad',
        exit_code: 1,
        summary: 'npm error code EAI_AGAIN',
      },
      { type: 'command', command: 'rm -rf /', summary: 'Declined' },
      { type: 'result', ok: false, summary: 'Codex did not finish', error: 'Codex did not finish' },
    ]);
  });

  it('relays Codex Apps PR approval to the owner and returns a one-call MCP decision', () => {
    for (const decision of ['allow', 'deny'] as const) {
      const s = session(spec());
      s.feed(
        line({
          id: 42,
          method: 'mcpServer/elicitation/request',
          params: {
            mode: 'form',
            serverName: 'codex_apps',
            message: 'Allow GitHub to create a pull request?',
            _meta: {
              codex_approval_kind: 'mcp_tool_call',
              tool_title: 'create_pull_request',
              persist: ['always'],
              tool_params: {
                repository_full_name: 'acme/relay',
                title: 'Fix reconnect',
                head: 'fix',
                base: 'main',
                draft: true,
              },
            },
            requestedSchema: { type: 'object', properties: {} },
          },
        }),
      );
      expect(s.approvals).toHaveLength(1);
      expect(s.approvals[0]).toMatchObject({
        request_id: 'codex-42',
        action: 'pr',
        title: 'Create pull request',
        input: { draft: true },
      });
      expect(s.frames()).toHaveLength(1); // initialize only; still waiting for the owner
      s.session.answer('codex-42', decision);
      expect(s.frames().slice(1)).toEqual([
        {
          id: 42,
          result: {
            action: decision === 'allow' ? 'accept' : 'decline',
            content: decision === 'allow' ? {} : null,
          },
        },
      ]);
      s.session.answer('codex-42', decision);
      expect(s.frames()).toHaveLength(2);
    }
  });

  it('does not invent answers to non-empty MCP forms', () => {
    const s = session(spec());
    s.feed(
      line({
        id: 42,
        method: 'mcpServer/elicitation/request',
        params: {
          mode: 'form',
          _meta: { codex_approval_kind: 'mcp_tool_call', tool_title: 'create_pull_request' },
          requestedSchema: { type: 'object', properties: { password: { type: 'string' } } },
        },
      }),
    );
    expect(s.approvals).toHaveLength(0);
    expect(s.frames().at(-1)).toMatchObject({ error: { code: -32601 } });
  });

  it('uses a read-only sandbox when edit acceptance is disabled', () => {
    expect(codexAdapter.launch(spec({ acceptEdits: false })).args).toContain(
      'sandbox_mode="read-only"',
    );
    expect(codexAdapter.launch(spec({ acceptEdits: true })).args).toContain(
      'sandbox_mode="workspace-write"',
    );
    expect(codexAdapter.launch(spec({ acceptEdits: true, mode: 'plan' })).args).toContain(
      'sandbox_mode="read-only"',
    );
  });

  it('raises a command approval classified, and answers it with accept or decline', () => {
    const s = session(spec());
    const [before, rest] = splitAtRequest(fixture('codex-approval.jsonl'));
    s.feed(before);
    expect(s.approvals).toEqual([
      {
        request_id: 'codex-0',
        tool_name: 'commandExecution',
        input: {
          command: 'npm install --save-dev vitest',
          cwd: WORKTREE,
          reason: 'Install vitest from the npm registry, which needs the network',
        },
        action: 'install',
        title: 'Run: npm install --save-dev vitest',
        detail: 'Install vitest from the npm registry, which needs the network',
      },
    ]);
    const sent = s.frames().length;
    s.session.answer('codex-0', 'allow');
    expect(s.frames().slice(sent)).toEqual([{ id: 0, result: { decision: 'accept' } }]);
    // An answer is sent once; a second, or one for nothing asked, sends nothing.
    s.session.answer('codex-0', 'deny');
    s.session.answer('codex-9', 'allow');
    expect(s.frames()).toHaveLength(sent + 1);
    s.feed(rest);
    expect(s.events.at(-1)).toMatchObject({
      type: 'result',
      ok: true,
      summary: 'Installed vitest as a dev dependency.',
    });
    // After the result nothing more is written.
    s.session.end();
    expect(s.frames()).toHaveLength(sent + 1);

    const no = session(spec());
    no.feed(splitAtRequest(fixture('codex-approval.jsonl'))[0]);
    no.session.answer('codex-0', 'deny', 'The owner said no');
    expect(no.frames().at(-1)).toEqual({ id: 0, result: { decision: 'decline' } });
  });

  it('raises a file change approval with the paths item/started named, and a network ask as an install', () => {
    const s = session(spec());
    s.feed(`${INITIALIZE}\n`);
    s.feed(
      [
        line({
          method: 'item/started',
          params: {
            item: {
              type: 'fileChange',
              id: 'call_9',
              status: 'inProgress',
              changes: [
                { path: `${WORKTREE}/src/link.ts`, kind: { type: 'update' } },
                { path: '/etc/hosts', kind: { type: 'update' } },
              ],
            },
          },
        }),
        line({
          id: 'req-7',
          method: 'item/fileChange/requestApproval',
          params: { itemId: 'call_9', reason: 'Needs to edit /etc/hosts' },
        }),
        line({
          id: 8,
          method: 'item/commandExecution/requestApproval',
          params: {
            itemId: 'x',
            command: 'curl https://example.com',
            networkApprovalContext: { host: 'example.com', protocol: 'https' },
          },
        }),
      ].join('\n'),
    );
    expect(s.approvals[0]).toEqual({
      request_id: 'codex-req-7',
      tool_name: 'fileChange',
      input: {
        paths: [`${WORKTREE}/src/link.ts`, '/etc/hosts'],
        reason: 'Needs to edit /etc/hosts',
      },
      action: 'outside_worktree',
      title: 'Edit outside the worktree: /etc/hosts',
      detail: 'Needs to edit /etc/hosts',
    });
    expect(s.approvals[1]).toMatchObject({
      request_id: 'codex-8',
      action: 'install',
      title: 'Reach example.com over the network: curl https://example.com',
      input: { command: 'curl https://example.com', network: 'example.com' },
    });
    s.session.answer('codex-req-7', 'deny');
    expect(s.frames().at(-1)).toEqual({ id: 'req-7', result: { decision: 'decline' } });
  });

  it('refuses a server request it does not serve, so Codex does not wait on it', () => {
    const s = session(spec());
    s.feed(line({ id: 4, method: 'item/tool/requestUserInput', params: { questions: [] } }));
    expect(s.frames().at(-1)).toEqual({
      id: 4,
      error: { code: -32601, message: 'OpenBots does not answer item/tool/requestUserInput' },
    });
    expect(s.approvals).toEqual([]);
  });

  it('fails when app-server refuses the handshake or the thread', () => {
    const init = session(spec());
    init.feed(line({ id: 1, error: { code: -32600, message: 'bad params' } }));
    expect(init.events.at(-1)).toMatchObject({
      type: 'result',
      ok: false,
      error: 'Codex refused to start: bad params',
    });
    const thread = session(spec());
    thread.feed(`${INITIALIZE}\n`);
    thread.feed(line({ id: 2, error: { code: -32600, message: 'cwd is not a directory' } }));
    expect(thread.events.at(-1)).toMatchObject({
      ok: false,
      error: 'Codex could not start a thread: cwd is not a directory',
    });
    expect(thread.frames().map((f) => f.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
    ]);
  });

  it('signs in with a device code: the link and the code, nothing to paste', () => {
    expect(ptySignIn(codexAdapter).login()).toEqual({
      command: 'codex',
      args: ['login', '--device-auth'],
      timeoutMs: 15 * 60_000,
    });
    const parsed = ptySignIn(codexAdapter).parseLogin(fixture('codex-login.txt'), {});
    expect(parsed).toEqual({
      url: 'https://auth.openai.com/codex/device',
      deviceCode: '1PVB-90DS9',
      awaitingCode: false,
    });
    // Chunk by chunk, the same.
    let state: CoderLoginParse = {};
    for (const chunk of fixture('codex-login.txt').split('\n')) {
      state = ptySignIn(codexAdapter).parseLogin(`${chunk}\n`, state);
    }
    expect(state).toEqual(parsed);
    expect(ptySignIn(codexAdapter).parseLogin('Successfully logged in\n', state)).toMatchObject({
      signedIn: true,
    });
    expect(ptySignIn(codexAdapter).parseLogin('Not logged in\n', state).signedIn).toBeUndefined();
    expect(ptySignIn(codexAdapter).parseLogin('Error: device code expired\n', state).error).toBe(
      'Error: device code expired',
    );
    expect(ptySignIn(codexAdapter).parseLogin('Access denied by the user\n', state).error).toBe(
      'Access denied by the user',
    );
  });

  it('reads `codex login status` as a plan or a key, never keeping the line', () => {
    expect(codexStatus('Not logged in\n')).toEqual({ signedIn: false });
    expect(codexStatus('\u001b[32mLogged in using ChatGPT\u001b[0m\n')).toEqual({
      signedIn: true,
      authKind: 'subscription',
      label: 'ChatGPT',
    });
    // An API key login: never the masked key or the status line.
    expect(codexStatus('Logged in using an API key - sk-proj-***ABCD\n')).toEqual({
      signedIn: true,
      authKind: 'api_key',
      label: 'API key through Codex',
    });
  });
});
