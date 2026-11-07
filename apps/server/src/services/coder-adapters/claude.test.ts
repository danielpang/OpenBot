import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODER_PERMISSION_MCP } from '@openbots/computer';
import { DEFAULT_CODER_ACTIONS, type CoderEvent } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import { ptySignIn } from '../__fixtures__/coders/adapters.js';
import { claudeAdapter, claudeStatus } from './claude.js';
import { preamble } from './common.js';
import { adapterFor, IGNORED_SESSION_ID } from './index.js';
import type { CoderLoginParse, CoderSessionSpec } from './types.js';

// The Claude Code adapter against hand-made stream-json fixtures
// (services/__fixtures__/coders). Refresh them from the pinned CLI version.

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../__fixtures__/coders');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

const WORKTREE = '/home/bot/repos/acme/relay/.worktrees/bot-fix-reconnect';
const VENDOR = '7f1c2a90-4b1e-4c55-9a7e-0d2f6c1b8e11';

const spec = (over: Partial<CoderSessionSpec> = {}): CoderSessionSpec => ({
  sessionId: '00000000-0000-4000-8000-000000000001',
  agent: 'claude',
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

const parse = (text: string): CoderEvent[] => {
  const parser = claudeAdapter.parser();
  return [...text.split('\n').flatMap((line) => parser.line(line)), ...parser.end()];
};

/** The values after a flag, up to the next flag. */
const valuesOf = (args: string[], flag: string) => {
  const at = args.indexOf(flag);
  if (at < 0) return [];
  const rest = args.slice(at + 1);
  const end = rest.findIndex((a) => a.startsWith('--'));
  return end < 0 ? rest : rest.slice(0, end);
};

describe('claude adapter', () => {
  it('is registered', () => {
    expect(adapterFor('claude')).toBe(claudeAdapter);
    expect(claudeAdapter.versionArgs).toEqual(['--version']);
    expect(claudeAdapter.resumeCommand(VENDOR)).toBe(`claude --resume ${VENDOR}`);
    // Only a UUID reaches the terminal's preset.
    expect(claudeAdapter.resumeCommand('x; rm -rf ~')).toBe('claude');
    expect(ptySignIn(claudeAdapter).hosts).toEqual([
      'claude.com',
      'claude.ai',
      'platform.claude.com',
      'console.anthropic.com',
      'anthropic.com',
    ]);
  });

  it('launches headless with the permission server inline, push and the web refused', () => {
    const plan = claudeAdapter.launch(
      spec({ gitIdentity: { name: 'Relay Bot', email: 'dana@example.com' } }),
    );
    expect(plan.command).toBe('claude');
    const { args } = plan;
    expect(args[0]).toBe('-p');
    expect(valuesOf(args, '--output-format')).toEqual(['stream-json']);
    expect(args).toContain('--verbose');
    expect(valuesOf(args, '--max-turns')).toEqual(['200']);
    expect(valuesOf(args, '--permission-mode')).toEqual(['acceptEdits']);
    expect(valuesOf(args, '--permission-prompt-tool')).toEqual([
      'mcp__openbots__permission_prompt',
    ]);
    // Nothing is pre-allowed: in-worktree edits are accepted by acceptEdits,
    // and every Bash command (`git diff --no-index /var/lib/openbots/...`,
    // `git log --output=/x`) and every edit or read outside the worktree
    // reaches the permission tool, where `classify` decides.
    expect(args).not.toContain('--allowedTools');
    const denied = new Set(valuesOf(args, '--disallowedTools'));
    const rules = args.filter((a) => !denied.has(a));
    expect(rules.some((a) => /^(?:Bash|Edit|Write|MultiEdit|NotebookEdit)(?:\(|$)/.test(a))).toBe(
      false,
    );
    expect(valuesOf(args, '--disallowedTools')).toEqual([
      'Bash(git push*)',
      'Bash(git push)',
      'WebFetch',
      'WebSearch',
      'Read(/var/lib/openbots/**)',
      'Grep(/var/lib/openbots/**)',
      'Glob(/var/lib/openbots/**)',
    ]);
    const config = JSON.parse(valuesOf(args, '--mcp-config')[0]!);
    expect(config).toEqual({
      mcpServers: {
        openbots: {
          command: 'node',
          args: [CODER_PERMISSION_MCP],
          env: { OPENBOTS_CODER_SOCKET: '{{session_dir}}/permission.sock' },
        },
      },
    });
    expect(args).not.toContain('--resume');
    // The prompt comes last, after `--`, with the OpenBots preamble first.
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe(`${preamble(spec())}\n\nFix the reconnect loop`);
    expect(args.at(-1)).toContain('Do not push');
    expect(args.at(-1)).toContain(WORKTREE);
    expect(plan.env).toMatchObject({
      GIT_AUTHOR_NAME: 'Relay Bot',
      GIT_AUTHOR_EMAIL: 'dana@example.com',
      GIT_COMMITTER_NAME: 'Relay Bot',
      GIT_COMMITTER_EMAIL: 'dana@example.com',
    });
  });

  it('asks for a Co-Authored-By trailer naming the owner on every commit', () => {
    const plain = preamble(spec());
    expect(plain).not.toContain('Co-Authored-By');
    const credited = preamble(
      spec({ coAuthor: { name: 'Dana Scully', email: 'dana@example.com' } }),
    );
    expect(credited).toContain(
      'End every commit message with this trailer line: Co-Authored-By: Dana Scully <dana@example.com>',
    );
  });

  it('resumes, sets the model, and leaves installs to classify even when the policy says auto', () => {
    const { args } = claudeAdapter.launch(
      spec({
        resumeId: VENDOR,
        model: 'claude-opus-4-1',
        actions: { ...DEFAULT_CODER_ACTIONS, install: 'auto' },
      }),
    );
    expect(valuesOf(args, '--resume')).toEqual([VENDOR]);
    expect(valuesOf(args, '--model')).toEqual(['claude-opus-4-1']);
    // The policy answers `install` as auto at the permission tool, not by a prefix rule.
    expect(args).not.toContain('--allowedTools');
    // A forged id never reaches argv.
    const forged = claudeAdapter.launch(spec({ resumeId: '--dangerously-skip-permissions' }));
    expect(forged.args).not.toContain('--resume');
    expect(forged.args).not.toContain('--dangerously-skip-permissions');
  });

  it('only reads in plan mode', () => {
    const { args } = claudeAdapter.launch(spec({ mode: 'plan' }));
    expect(valuesOf(args, '--permission-mode')).toEqual(['plan']);
    // Plan mode reads the worktree on its own; nothing is pre-allowed.
    expect(args).not.toContain('--allowedTools');
    expect(valuesOf(args, '--disallowedTools')).toEqual(
      expect.arrayContaining([
        'Edit',
        'Write',
        'ExitPlanMode',
        'WebFetch',
        'WebSearch',
        'Read(/var/lib/openbots/**)',
      ]),
    );
    expect(args.at(-1)).toContain('do not edit files');
  });

  it('parses a successful session', () => {
    const events = parse(fixture('claude-success.jsonl'));
    expect(events).toEqual([
      { type: 'text', text: "I'll look at the reconnect loop first." },
      { type: 'tool_use', name: 'Read', summary: `${WORKTREE}/src/link.ts` },
      { type: 'file_change', path: 'src/link.ts', kind: 'edit' },
      { type: 'command', command: 'pnpm test' },
      { type: 'command', command: 'git commit -am "Back off between relay reconnects"' },
      {
        type: 'text',
        text: 'The reconnect loop now backs off between attempts. Verify that the relay reconnects after a network drop.',
      },
      {
        type: 'usage',
        input_tokens: 40 + 5120 + 26820,
        output_tokens: 257,
        cost_usd: 0.0912,
        // `apiKeySource: none` in the init line: a plan login.
        billed: 'subscription',
      },
      {
        type: 'result',
        ok: true,
        summary:
          'The reconnect loop now backs off between attempts. Verify that the relay reconnects after a network drop.',
        vendor_session_id: VENDOR,
      },
    ]);
  });

  it('accepts only a UUID as the session id, and says so when it drops one', () => {
    const parser = claudeAdapter.parser();
    expect(
      parser.line(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x --model y' })),
    ).toEqual([{ type: 'text', text: IGNORED_SESSION_ID }]);
    const forged = parser.line(
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: '$(id)' }),
    );
    expect(forged[0]).toEqual({ type: 'text', text: IGNORED_SESSION_ID });
    expect(forged.find((e) => e.type === 'result')).not.toHaveProperty('vendor_session_id');
    // A good init id is kept when the result's is forged.
    const kept = claudeAdapter.parser();
    kept.line(JSON.stringify({ type: 'system', subtype: 'init', session_id: VENDOR }));
    const result = kept
      .line(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 'bad' }))
      .find((e) => e.type === 'result');
    expect(result).toMatchObject({ vendor_session_id: VENDOR });
  });

  it('attaches exit codes to failed commands, ignores stray lines and reads the turn limit', () => {
    const events = parse(fixture('claude-failed-command.jsonl'));
    expect(events).toContainEqual({
      type: 'file_change',
      path: 'test/limits.test.ts',
      kind: 'create',
    });
    expect(events).toContainEqual({
      type: 'command',
      command: 'npm test',
      exit_code: 1,
      summary: 'FAIL test/limits.test.ts',
    });
    expect(events).toContainEqual({ type: 'tool_use', name: 'Grep', summary: 'maxSessions' });
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ billed: 'api', cost_usd: 0.034 });
    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({
      ok: false,
      error: 'Stopped after 3 turns',
      vendor_session_id: '2c3d4e5f-0000-4000-8000-000000000002',
    });
  });

  it('reads an unsigned CLI as a failed result the runner marks needs_login', () => {
    const events = parse(fixture('claude-not-logged-in.jsonl'));
    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({ ok: false, summary: 'Invalid API key · Please run /login' });
    expect(claudeAdapter.needsLogin!('Invalid API key · Please run /login')).toBe(true);
    expect(claudeAdapter.needsLogin!('API Error: 401 {"type":"error"}')).toBe(true);
    expect(claudeAdapter.needsLogin!('Tests failed in link.test.ts')).toBe(false);
  });

  it('bills by cost when the stream has no init line', () => {
    const parser = claudeAdapter.parser();
    const free = parser.line(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }));
    expect(free[0]).toMatchObject({ type: 'usage', billed: 'subscription' });
    const paid = claudeAdapter
      .parser()
      .line(
        JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0.5 }),
      );
    expect(paid[0]).toMatchObject({ type: 'usage', billed: 'api', cost_usd: 0.5 });
  });

  it('plans the sign-in and reads the link, the paste prompt, a refused code and success', () => {
    const signIn = ptySignIn(claudeAdapter);
    expect(signIn.login()).toEqual({
      command: 'claude',
      args: ['auth', 'login', '--claudeai'],
      env: { BROWSER: '/bin/true' },
      timeoutMs: 600_000,
    });
    let state: CoderLoginParse = {};
    // The verified output: an OSC 8 link around the same text, then the prompt.
    state = signIn.parseLogin(fixture('claude-login.txt'), state);
    expect(state.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&/);
    expect(state.url).toMatch(/&state=[\w-]+$/);
    expect(state.url).not.toContain('\u001b');
    expect(state.awaitingCode).toBe(true);
    expect(state.signedIn).toBeUndefined();
    // A later link does not replace the first.
    state = signIn.parseLogin('see https://example.com/other', state);
    expect(state.url).toMatch(/^https:\/\/claude\.com\//);
    // A code without its `#state` is refused, and the prompt waits again: not an end.
    state = signIn.parseLogin(
      'Invalid code. Please make sure the full code was copied.\r\nPaste code here if prompted > ',
      state,
    );
    expect(state.notice).toBe('Invalid code. Please make sure the full code was copied.');
    expect(state.error).toBeUndefined();
    expect(state.awaitingCode).toBe(true);
    state = signIn.parseLogin(fixture('claude-login-done.txt'), state);
    expect(state.signedIn).toBe(true);
    expect(state.awaitingCode).toBe(false);
    expect(state.notice).toBeUndefined();
    expect(signIn.parseLogin('Login failed: the code expired\n', {}).error).toBe(
      'the code expired',
    );
  });

  it('reads `claude auth status`', () => {
    const status = (over: object) =>
      JSON.stringify({ apiProvider: 'firstParty', ...over }, null, 2);
    expect(claudeStatus(status({ loggedIn: false, authMethod: 'none' }))).toEqual({
      signedIn: false,
    });
    expect(claudeStatus(status({ loggedIn: true, authMethod: 'claude.ai' }))).toEqual({
      signedIn: true,
      authKind: 'subscription',
      label: 'Claude account',
    });
    expect(
      claudeStatus(status({ loggedIn: true, authMethod: 'claude.ai', email: 'dana@example.com' })),
    ).toMatchObject({ label: 'dana@example.com' });
    expect(claudeStatus(status({ loggedIn: true, authMethod: 'oauth_token' }))).toEqual({
      signedIn: true,
      authKind: 'api_key',
      label: 'Token from the environment',
    });
    expect(claudeStatus('not json')).toBeNull();
    expect(claudeAdapter.needsLogin!('Not logged in · Please run /login')).toBe(true);
    expect(claudeAdapter.needsLogin!('Failed to authenticate. API Error: 401')).toBe(true);
  });

  it('classes a push and an edit outside the worktree', () => {
    expect(
      claudeAdapter.classify(
        'Bash',
        { command: 'git push origin bot/x' },
        { worktreePath: WORKTREE },
      ),
    ).toMatchObject({ action: 'push', title: 'Run: git push origin bot/x' });
    expect(
      claudeAdapter.classify('Edit', { file_path: '/etc/hosts' }, { worktreePath: WORKTREE }),
    ).toMatchObject({ action: 'outside_worktree', title: 'Edit outside the worktree: /etc/hosts' });
    // A read of the sign-in files is the strictest class, and the web asks.
    expect(
      claudeAdapter.classify(
        'Read',
        { file_path: '/var/lib/openbots/coders/claude/.credentials.json' },
        { worktreePath: WORKTREE },
      ).action,
    ).toBe('destructive');
    expect(
      claudeAdapter.classify(
        'WebFetch',
        { url: 'https://x.example/?q=1' },
        { worktreePath: WORKTREE },
      ),
    ).toMatchObject({ action: 'outside_worktree', title: 'Fetch: https://x.example/?q=1' });
    expect(
      claudeAdapter.classify('WebSearch', { query: 'leak' }, { worktreePath: WORKTREE }).action,
    ).toBe('outside_worktree');
    // Script runners are no longer pre-allowed; they class as `other`.
    expect(
      claudeAdapter.classify('Bash', { command: 'make build' }, { worktreePath: WORKTREE }).action,
    ).toBe('other');
    expect(
      claudeAdapter.classify(
        'Edit',
        { file_path: `${WORKTREE}/src/a.ts` },
        { worktreePath: WORKTREE },
      ).action,
    ).toBe('other');
  });
});
