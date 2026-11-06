import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CODER_ACTIONS, type CoderEvent } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import { codexAdapter, codexBilling, codexParser, preamble } from './codex.js';
import { adapterFor, IGNORED_SESSION_ID } from './index.js';
import type { CoderLoginParse, CoderOutputParser, CoderSessionSpec } from './types.js';

// The Codex CLI adapter against the fixtures in services/__fixtures__/coders:
// `codex-needs-login.jsonl` and `codex-login.txt` are captures of the pinned
// 0.166.0, `codex-success.jsonl` is built from its item shapes.

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

describe('codex adapter', () => {
  it('is registered', () => {
    expect(adapterFor('codex')).toBe(codexAdapter);
    expect(codexAdapter.versionArgs).toEqual(['--version']);
    expect(codexAdapter.resumeCommand(VENDOR)).toBe(`codex resume ${VENDOR}`);
    // Only a UUID reaches the terminal's preset.
    expect(codexAdapter.resumeCommand('x; rm -rf ~')).toBe('codex');
    expect(codexAdapter.loginHosts).toEqual([
      'auth.openai.com',
      'chatgpt.com',
      'openai.com',
      'platform.openai.com',
    ]);
  });

  it('launches exec in the worktree with the workspace-write sandbox and no approvals', () => {
    const plan = codexAdapter.launch(
      spec({
        gitIdentity: { name: 'Relay Bot', email: 'dana@example.com' },
        coAuthor: { name: 'Dana', email: 'dana@example.com' },
      }),
    );
    expect(plan.command).toBe('codex');
    const prompt = plan.args.at(-1)!;
    expect(plan.args).toEqual([
      'exec',
      '--json',
      '-s',
      'workspace-write',
      '-C',
      WORKTREE,
      '--skip-git-repo-check',
      '--ignore-user-config',
      '-c',
      'sandbox_workspace_write.network_access=false',
      '-c',
      'approval_policy="never"',
      '--',
      prompt,
    ]);
    // `-a` is rejected by exec, and the network is off, said explicitly.
    expect(plan.args).not.toContain('-a');
    expect(prompt.endsWith('\n\nFix the reconnect loop')).toBe(true);
    expect(prompt).toContain('ask the owner to install dependencies');
    expect(prompt).toContain('Co-Authored-By: Dana <dana@example.com>');
    expect(plan.env).toEqual({
      GIT_AUTHOR_NAME: 'Relay Bot',
      GIT_AUTHOR_EMAIL: 'dana@example.com',
      GIT_COMMITTER_NAME: 'Relay Bot',
      GIT_COMMITTER_EMAIL: 'dana@example.com',
    });
    expect(plan.stdin).toBeUndefined();
    expect(plan.pty).toBeFalsy();
  });

  it('launches pr mode like edit mode, with a model when one is set', () => {
    const { args } = codexAdapter.launch(spec({ mode: 'pr', model: 'gpt-5-codex' }));
    expect(args.slice(0, 4)).toEqual(['exec', '--json', '-s', 'workspace-write']);
    expect(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2)).toEqual(['-m', 'gpt-5-codex']);
    expect(args.indexOf('-m')).toBeLessThan(args.indexOf('--'));
  });

  it('plans in the read-only sandbox and says to change nothing', () => {
    const { args } = codexAdapter.launch(spec({ mode: 'plan' }));
    expect(args.slice(args.indexOf('-s'), args.indexOf('-s') + 2)).toEqual(['-s', 'read-only']);
    expect(args.at(-1)).toContain('change nothing');
    expect(preamble(spec())).not.toContain('change nothing');
  });

  it('resumes with -c for the sandbox, never -s or -C', () => {
    const { args } = codexAdapter.launch(spec({ resumeId: VENDOR, model: 'gpt-5-codex' }));
    const prompt = args.at(-1)!;
    expect(args).toEqual([
      'exec',
      'resume',
      VENDOR,
      '--json',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '-c',
      'sandbox_workspace_write.network_access=false',
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_mode="workspace-write"',
      '-m',
      'gpt-5-codex',
      '--',
      prompt,
    ]);
    expect(prompt.endsWith('Fix the reconnect loop')).toBe(true);
    const plan = codexAdapter.launch(spec({ mode: 'plan', resumeId: VENDOR }));
    expect(plan.args).toContain('sandbox_mode="read-only"');
  });

  it("lets the sandbox write the checkout's .git, where the worktree's commits go", () => {
    const { args } = codexAdapter.launch(spec({ repoPath: `${REPO}/` }));
    expect(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2)).toEqual([
      '--add-dir',
      `${REPO}/.git`,
    ]);
    expect(args.indexOf('--add-dir')).toBeLessThan(args.indexOf('--'));
    // `exec resume` has no --add-dir: the sandbox's own writable_roots, as TOML.
    const resumed = codexAdapter.launch(spec({ repoPath: REPO, resumeId: VENDOR })).args;
    expect(resumed).not.toContain('--add-dir');
    expect(resumed).toContain(`sandbox_workspace_write.writable_roots=["${REPO}/.git"]`);
    // A plan changes nothing, so nothing more is writable.
    for (const over of [{}, { resumeId: VENDOR }]) {
      const plan = codexAdapter.launch(spec({ repoPath: REPO, mode: 'plan', ...over })).args;
      expect(plan).not.toContain('--add-dir');
      expect(plan.join(' ')).not.toContain('writable_roots');
    }
    // Every launch drops the user's config.toml.
    expect(codexAdapter.launch(spec({ mode: 'plan' })).args).toContain('--ignore-user-config');
  });

  it('starts afresh when the resume id is not a UUID', () => {
    const { args } = codexAdapter.launch(spec({ resumeId: '--last' }));
    expect(args).not.toContain('resume');
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
  });

  it('parses a successful session in order, with usage and the result', () => {
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

  it('bills by the login kind it is given', () => {
    const events = parse(fixture('codex-success.jsonl'), codexParser({ billing: 'subscription' }));
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ billed: 'subscription' });
    expect(codexBilling('Logged in using ChatGPT\n')).toBe('subscription');
    expect(codexBilling('Logged in using an API key - sk-proj-***')).toBe('api');
    expect(codexBilling('Not logged in')).toBe('unknown');
  });

  it('reads a missing login as a failed turn that needs a sign-in', () => {
    const events = parse(fixture('codex-needs-login.jsonl'));
    // The retries and the transport fallback are not failures; the last
    // error and the failed turn say the same thing once.
    expect(events.map((e) => e.type)).toEqual(['error', 'result']);
    const [error, result] = events;
    expect(error).toMatchObject({ type: 'error' });
    expect((error as { message: string }).message).toMatch(/^unexpected status 401 Unauthorized/);
    expect(result).toMatchObject({
      type: 'result',
      ok: false,
      vendor_session_id: '01a1ad5f-b5bb-71d3-bc7a-2ea7665db158',
    });
    const said = (result as { error?: string }).error!;
    expect(said).toContain('401 Unauthorized');
    expect(codexAdapter.needsLogin!(said)).toBe(true);
    expect(codexAdapter.needsLogin!('Not logged in')).toBe(true);
    expect(codexAdapter.needsLogin!('Tests failed: 3 of 23')).toBe(false);
  });

  it('reports a turn that never completed as not ok, and nothing for an empty stream', () => {
    const events = parse(
      [line({ type: 'thread.started', thread_id: VENDOR }), line({ type: 'turn.started' })].join(
        '\n',
      ),
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
    expect(parse('not json\n{"type":')).toEqual([]);
  });

  it('drops a thread id that is not a UUID', () => {
    const events = parse(
      [
        line({ type: 'thread.started', thread_id: '../../etc/passwd' }),
        line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }),
      ].join('\n'),
    );
    expect(events[0]).toEqual({ type: 'text', text: IGNORED_SESSION_ID });
    expect(events.at(-1)).toEqual({ type: 'result', ok: true, summary: '' });
  });

  it('maps tool calls, deletes, failed commands and drops todo lists and empty reasoning', () => {
    const items = [
      { type: 'reasoning', text: '   ' },
      { type: 'todo_list', items: [{ text: 'a', completed: false }] },
      { type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: { q: 'backoff' } },
      { type: 'web_search', query: 'exponential backoff' },
      { type: 'file_change', changes: [{ path: `${WORKTREE}/old.ts`, kind: 'delete' }] },
      {
        type: 'command_execution',
        command: "/bin/bash -lc 'npm install left-pad'",
        aggregated_output: 'npm error network request failed\nnpm error code EAI_AGAIN\n',
        exit_code: 1,
        status: 'failed',
      },
    ];
    const events = parse(
      items.map((item) => line({ type: 'item.completed', item })).join('\n'),
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
      { type: 'result', ok: false, summary: 'Codex did not finish', error: 'Codex did not finish' },
    ]);
  });

  it('signs in with a device code: the link and the code, nothing to paste', () => {
    expect(codexAdapter.login()).toEqual({
      command: 'codex',
      args: ['login', '--device-auth'],
      timeoutMs: 15 * 60_000,
    });
    const parsed = codexAdapter.parseLogin(fixture('codex-login.txt'), {});
    expect(parsed).toEqual({
      url: 'https://auth.openai.com/codex/device',
      deviceCode: '1PVB-90DS9',
      awaitingCode: false,
    });
    // Chunk by chunk, the same.
    let state: CoderLoginParse = {};
    for (const chunk of fixture('codex-login.txt').split('\n')) {
      state = codexAdapter.parseLogin(`${chunk}\n`, state);
    }
    expect(state).toEqual(parsed);
    expect(codexAdapter.parseLogin('Successfully logged in\n', state)).toMatchObject({
      signedIn: true,
    });
    expect(codexAdapter.parseLogin('Not logged in\n', state).signedIn).toBeUndefined();
    expect(codexAdapter.parseLogin('Error: device code expired\n', state).error).toBe(
      'Error: device code expired',
    );
    expect(codexAdapter.parseLogin('Access denied by the user\n', state).error).toBe(
      'Access denied by the user',
    );
  });
});
