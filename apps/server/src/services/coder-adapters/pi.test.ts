import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODER_PI_EXTENSION } from '@openbots/computer';
import { DEFAULT_CODER_ACTIONS, type CoderEvent } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../errors.js';
import { preamble } from './claude.js';
import { adapterFor, IGNORED_SESSION_ID } from './index.js';
import { TERMINAL_LOGIN_INSTRUCTIONS } from '../coder-login.js';
import { piAdapter, piLoginInTerminal } from './pi.js';
import type { CoderSessionSpec } from './types.js';

// The pi adapter against the fixtures in services/__fixtures__/coders: two
// captured from pi 1.5.0 (no credential, a rejected key) and one built from
// its documented event shapes (a successful run).

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../__fixtures__/coders');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

const WORKTREE = '/home/bot/repos/acme/relay/.worktrees/bot-fix-reconnect';
const SESSION = '00000000-0000-4000-8000-000000000001';

const spec = (over: Partial<CoderSessionSpec> = {}): CoderSessionSpec => ({
  sessionId: SESSION,
  agent: 'pi',
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
  const parser = piAdapter.parser();
  return [...text.split('\n').flatMap((line) => parser.line(line)), ...parser.end()];
};

const valueOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('pi adapter', () => {
  it('is registered', () => {
    expect(adapterFor('pi')).toBe(piAdapter);
    expect(piAdapter.versionArgs).toEqual(['pi', '--version']);
    expect(piAdapter.loginHosts).toEqual([]);
    expect(piAdapter.resumeCommand(SESSION)).toBe(`pi --session ${SESSION}`);
    expect(piAdapter.resumeCommand('x; rm -rf ~')).toBe('pi');
  });

  it('launches pi headless with the OpenBots extension and its own session id', () => {
    const plan = piAdapter.launch(
      spec({
        model: 'anthropic/claude-sonnet-4-5',
        gitIdentity: { name: 'Relay Bot', email: 'bot@example.com' },
        coAuthor: { name: 'Ada', email: 'ada@example.com' },
      }),
    );
    expect(plan.command).toBe('pi');
    const { args } = plan;
    expect(args.slice(0, 3)).toEqual(['-p', '--mode', 'json']);
    expect(valueOf(args, '--session-id')).toBe(SESSION);
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--session');
    expect(args).toContain('--no-extensions');
    expect(valueOf(args, '-e')).toBe(CODER_PI_EXTENSION);
    expect(args).toContain('--no-mcp');
    expect(args).toContain('--no-approve');
    expect(valueOf(args, '--tools')).toBe('read,bash,edit,write,grep,find,ls');
    expect(valueOf(args, '--model')).toBe('anthropic/claude-sonnet-4-5');
    // The prompt is last, after `--`, so the agent fills no placeholder in it.
    expect(args.at(-2)).toBe('--');
    const prompt = args.at(-1)!;
    expect(
      prompt.startsWith(preamble(spec({ coAuthor: { name: 'Ada', email: 'ada@example.com' } }))),
    ).toBe(true);
    expect(prompt).toContain('Co-Authored-By: Ada <ada@example.com>');
    expect(prompt.endsWith('Fix the reconnect loop')).toBe(true);
    expect(plan.env).toMatchObject({
      OPENBOTS_CODER_MODE: 'edit',
      GIT_AUTHOR_NAME: 'Relay Bot',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
      GIT_COMMITTER_NAME: 'Relay Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.com',
    });
  });

  it('resumes with the same session id', () => {
    const resumed = piAdapter.launch(spec({ resumeId: SESSION, prompt: 'Now add a test' }));
    expect(valueOf(resumed.args, '--session-id')).toBe(SESSION);
    expect(resumed.args).not.toContain('--continue');
    expect(resumed.args.at(-1)!.endsWith('Now add a test')).toBe(true);
    // A forged vendor id never reaches argv.
    const forged = piAdapter.launch(spec({ resumeId: '--api-key=x' }));
    expect(valueOf(forged.args, '--session-id')).toBe(SESSION);
    expect(forged.args).not.toContain('--api-key=x');
    expect(piAdapter.launch(spec()).args).not.toContain('--model');
  });

  it("names the api_key account's provider with the Bot's model, in pi's provider/model form", () => {
    const keyed = piAdapter.launch(spec({ apiKeyProvider: 'google', model: 'gemini-2.5-pro' }));
    expect(valueOf(keyed.args, '--provider')).toBe('google');
    expect(valueOf(keyed.args, '--model')).toBe('google/gemini-2.5-pro');
    // A model already in the provider's form keeps it.
    const prefixed = piAdapter.launch(spec({ apiKeyProvider: 'xai', model: 'xai/grok-4' })).args;
    expect(valueOf(prefixed, '--model')).toBe('xai/grok-4');
    // pi refuses --provider without --model: with no override, neither.
    const bare = piAdapter.launch(spec({ apiKeyProvider: 'anthropic' })).args;
    expect(bare).not.toContain('--provider');
    expect(bare).not.toContain('--model');
    // A plan sign-in (no provider) passes the model as it is.
    const plan = piAdapter.launch(spec({ model: 'sonnet:high' })).args;
    expect(plan).not.toContain('--provider');
    expect(valueOf(plan, '--model')).toBe('sonnet:high');
  });

  it("bills the usage by the account's kind", () => {
    for (const billing of ['api', 'subscription', 'unknown'] as const) {
      const parser = piAdapter.parser({ billing });
      const events = [
        ...fixture('pi-success.jsonl')
          .split('\n')
          .flatMap((line) => parser.line(line)),
        ...parser.end(),
      ];
      expect(events.find((e) => e.type === 'usage')).toMatchObject({ billed: billing });
    }
  });

  it('plans with the read tools only, and tells the extension', () => {
    const plan = piAdapter.launch(spec({ mode: 'plan' }));
    expect(valueOf(plan.args, '--tools')).toBe('read,grep,find,ls');
    expect(plan.env.OPENBOTS_CODER_MODE).toBe('plan');
    expect(plan.args.at(-1)).toContain('do not edit files');
  });

  it('parses a successful run', () => {
    const events = parse(fixture('pi-success.jsonl'));
    expect(events).toEqual([
      { type: 'text', text: "I'll look at the reconnect loop first." },
      { type: 'tool_use', name: 'read', summary: 'src/link.ts' },
      { type: 'file_change', path: 'src/link.ts', kind: 'edit', added: 1, removed: 0 },
      { type: 'file_change', path: 'test/link.test.ts', kind: 'create' },
      { type: 'command', command: 'npm test' },
      {
        type: 'text',
        text: 'Reset the reconnect backoff after a successful connect in src/link.ts and added test/link.test.ts. All 23 tests pass.',
      },
      {
        type: 'usage',
        input_tokens: 3120 + 3400 + 3072 + 3700 + 3328 + 3900 + 3584,
        output_tokens: 64 + 210 + 40 + 36,
        cost_usd: 0,
        billed: 'unknown',
      },
      {
        type: 'result',
        ok: true,
        summary:
          'Reset the reconnect backoff after a successful connect in src/link.ts and added test/link.test.ts. All 23 tests pass.',
        vendor_session_id: '01a1ad71-0f4b-7c22-8e5a-6d3b9a1c2e40',
      },
    ]);
    // Thinking is dropped.
    expect(JSON.stringify(events)).not.toContain('Read the file first.');
  });

  it('fails a run the provider refused, though pi exits 0', () => {
    const events = parse(fixture('pi-invalid-key.jsonl'));
    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({
      type: 'result',
      ok: false,
      vendor_session_id: '01a1ad61-14ca-72f2-99f9-6018bfb5289a',
    });
    const error = result?.type === 'result' ? result.error! : '';
    expect(error).toMatch(/^401 /);
    expect(error).toContain('authentication_error');
    expect(piAdapter.needsLogin!(error)).toBe(true);
    expect(events.filter((e) => e.type === 'result')).toHaveLength(1);
  });

  it('leaves a run with no credential to the exit code and stderr', () => {
    expect(parse(fixture('pi-needs-login.jsonl'))).toEqual([]);
    expect(
      piAdapter.needsLogin!(
        'No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key.',
      ),
    ).toBe(true);
    expect(piAdapter.needsLogin!('No API key found for anthropic.')).toBe(true);
    expect(piAdapter.needsLogin!('ENOENT: no such file')).toBe(false);
    expect(piAdapter.needsLogin!('Tests failed: 3 of 40')).toBe(false);
  });

  it('reports a run that started but never ended', () => {
    const lines = fixture('pi-success.jsonl').split('\n').slice(0, 6).join('\n');
    expect(parse(lines).at(-1)).toMatchObject({
      type: 'result',
      ok: false,
      error: 'pi did not finish',
    });
  });

  it('drops a session id that is not a UUID', () => {
    const events = parse(
      [
        '{"type":"session","version":3,"id":"../../etc/passwd","cwd":"/x"}',
        '{"type":"agent_start"}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done"}],"stopReason":"stop"}}',
        '{"type":"agent_end","messages":[]}',
      ].join('\n'),
    );
    expect(events[0]).toEqual({ type: 'text', text: IGNORED_SESSION_ID });
    expect(events.at(-1)).toEqual({ type: 'result', ok: true, summary: 'Done' });
  });

  it('names a failed command and skips a blocked edit', () => {
    const events = parse(
      [
        '{"type":"agent_start"}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"b","name":"bash","arguments":{"command":"npm test"}},{"type":"toolCall","id":"e","name":"edit","arguments":{"path":"/etc/hosts","edits":[]}}],"stopReason":"toolUse"}}',
        '{"type":"tool_execution_end","toolCallId":"b","toolName":"bash","result":{"content":[{"type":"text","text":"1 test failed\\n\\nCommand exited with code 1"}]},"isError":true}',
        '{"type":"tool_execution_end","toolCallId":"e","toolName":"edit","result":{"content":[{"type":"text","text":"Not now"}]},"isError":true}',
      ].join('\n'),
    );
    expect(events.slice(0, 2)).toEqual([
      { type: 'command', command: 'npm test' },
      { type: 'command', command: 'npm test', exit_code: 1, summary: '1 test failed' },
    ]);
    expect(events.some((e) => e.type === 'file_change')).toBe(false);
  });

  it('classifies tool calls in pi terms', () => {
    const ctx = { worktreePath: WORKTREE };
    expect(piAdapter.classify('bash', { command: 'npm test' }, ctx)).toMatchObject({
      action: 'other',
      title: 'Run: npm test',
    });
    expect(piAdapter.classify('bash', { command: 'git push origin HEAD' }, ctx).action).toBe(
      'push',
    );
    expect(piAdapter.classify('bash', { command: 'npm install left-pad' }, ctx).action).toBe(
      'install',
    );
    expect(piAdapter.classify('edit', { path: 'src/link.ts', edits: [] }, ctx)).toEqual({
      action: 'other',
      title: 'edit: src/link.ts',
    });
    expect(piAdapter.classify('write', { path: '/etc/hosts', content: '' }, ctx)).toMatchObject({
      action: 'outside_worktree',
      title: 'Write outside the worktree: /etc/hosts',
    });
    expect(
      piAdapter.classify('read', { path: '/var/lib/openbots/coders/pi/auth.json' }, ctx).action,
    ).toBe('destructive');
    expect(piAdapter.classify('grep', { pattern: 'TODO' }, ctx)).toEqual({
      action: 'other',
      title: 'grep: TODO',
    });
    expect(piAdapter.classify('ls', { path: '../..' }, ctx).action).toBe('outside_worktree');
    expect(piAdapter.classify('codemode', {}, ctx)).toEqual({
      action: 'other',
      title: 'Use codemode',
    });
  });

  it('signs in from the terminal only', () => {
    let thrown: unknown;
    try {
      piAdapter.login();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect(thrown).toMatchObject({
      status: 409,
      code: 'CODER_LOGIN_IN_TERMINAL',
      message: TERMINAL_LOGIN_INSTRUCTIONS.pi,
    });
    // The adapter and the sign-in card say the same thing.
    expect(piLoginInTerminal()).toBe(TERMINAL_LOGIN_INSTRUCTIONS.pi);
    const state = { url: 'https://x' };
    expect(piAdapter.parseLogin('anything', state)).toBe(state);
  });
});
