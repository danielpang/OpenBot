import { describe, expect, it } from 'vitest';
import {
  CODER_AGENT_LABELS,
  CODER_AGENTS,
  CODER_PROVIDER_KINDS,
  coderProviderFits,
  coderActionDecision,
  CoderControlSchema,
  coderEnabled,
  CoderEventSchema,
  CoderFeedLineSchema,
  CodingSessionResultSchema,
  DEFAULT_CODER_ACTIONS,
  isCoderTool,
} from './coders.js';
import { CoderAgentSchema, resolveToolPolicy } from './index.js';

const SESSION = '00000000-0000-4000-8000-000000000001';

describe('coding agents', () => {
  it('names every agent', () => {
    expect(CODER_AGENTS).toEqual(['claude', 'codex', 'pi']);
    expect(Object.keys(CODER_AGENT_LABELS)).toEqual([...CODER_AGENTS]);
    expect(CODER_AGENT_LABELS.claude).toBe('Claude Code');
    // Re-exported from policy.ts, the same schema either way.
    expect(CoderAgentSchema.options).toBe(CODER_AGENTS);
  });

  it('parses control messages and refuses unknown ones', () => {
    const approval = {
      type: 'approval',
      sessionId: SESSION,
      approvalId: SESSION,
      decision: 'approved',
    };
    expect(CoderControlSchema.parse(approval)).toEqual(approval);
    expect(CoderControlSchema.safeParse({ type: 'stop', sessionId: SESSION }).success).toBe(true);
    expect(CoderControlSchema.safeParse({ type: 'stop', sessionId: 'x' }).success).toBe(false);
    expect(CoderControlSchema.safeParse({ ...approval, decision: 'maybe' }).success).toBe(false);
    expect(CoderControlSchema.safeParse({ type: 'pause', sessionId: SESSION }).success).toBe(false);
  });

  it('parses the normal form of every event kind', () => {
    const events = [
      { type: 'text', text: 'Looking at the relay' },
      { type: 'tool_use', name: 'Read', summary: 'src/relay.ts' },
      { type: 'file_change', path: 'src/relay.ts', kind: 'edit', added: 3, removed: 1 },
      { type: 'command', command: 'pnpm test', exit_code: 0 },
      {
        type: 'approval_request',
        request_id: 'r1',
        action_class: 'push',
        title: 'Push bot/fix-relay',
        tool_name: 'Bash',
        input: { command: 'git push' },
      },
      { type: 'usage', input_tokens: 10, output_tokens: 5, billed: 'subscription' },
      { type: 'result', ok: true, summary: 'Fixed', vendor_session_id: 'v1' },
      { type: 'error', message: 'Rate limited' },
    ];
    for (const event of events) expect(CoderEventSchema.parse(event)).toEqual(event);
    expect(
      CoderEventSchema.safeParse({
        type: 'approval_request',
        request_id: 'r',
        action_class: 'merge',
        title: 't',
      }).success,
    ).toBe(false);
  });

  it('keeps feed lines short', () => {
    const line = { t: '2026-11-05T10:00:00.000Z', type: 'text', text: 'ok' };
    expect(CoderFeedLineSchema.parse(line)).toEqual(line);
    expect(CoderFeedLineSchema.safeParse({ ...line, text: 'x'.repeat(501) }).success).toBe(false);
    expect(CoderFeedLineSchema.safeParse({ ...line, type: 'other' }).success).toBe(false);
  });

  it('parses a session result', () => {
    const result = {
      summary: 'Fixed the reconnect loop',
      changed_files: [{ path: 'a.ts', added: 1, removed: 0, kind: 'edit' }],
      commits: [{ sha: 'abc123', title: 'Fix reconnect' }],
      branch: 'bot/fix-relay',
      base: 'main',
      worktree_path: '/home/bot/repos/openbots/relay/.worktrees/bot-fix-relay',
      pr_url: 'https://github.com/openbots/relay/pull/1',
    };
    expect(CodingSessionResultSchema.parse(result)).toEqual(result);
  });

  it('knows its tool', () => {
    expect(isCoderTool('code_task')).toBe(true);
    expect(isCoderTool('bash')).toBe(false);
    expect(isCoderTool(null)).toBe(false);
  });

  it('decides action classes by default, by the Bot, and by who started the run', () => {
    const empty = resolveToolPolicy(null);
    for (const action of Object.keys(
      DEFAULT_CODER_ACTIONS,
    ) as (keyof typeof DEFAULT_CODER_ACTIONS)[]) {
      expect(coderActionDecision(empty, 'owner', action)).toBe(DEFAULT_CODER_ACTIONS[action]);
    }
    expect(coderActionDecision(empty, 'owner', 'other')).toBe('auto');
    expect(coderActionDecision(empty, 'owner', 'push')).toBe('ask');
    // Runs other Bots and webhooks start ask for everything by default (P2).
    expect(coderActionDecision(empty, 'webhook', 'other')).toBe('ask');
    expect(coderActionDecision(empty, 'bot', 'other')).toBe('ask');

    const own = resolveToolPolicy({ coder: { actions: { push: 'auto', install: 'deny' } } });
    expect(coderActionDecision(own, 'owner', 'push')).toBe('auto');
    expect(coderActionDecision(own, 'owner', 'install')).toBe('deny');
    expect(coderActionDecision(own, 'webhook', 'push')).toBe('ask');
    expect(coderActionDecision(own, 'webhook', 'install')).toBe('deny');

    // The owner lifts a floor only with an explicit default: 'auto'.
    const lifted = resolveToolPolicy({
      coder: { actions: { push: 'auto' } },
      triggers: { webhook: { default: 'auto' } },
    });
    expect(coderActionDecision(lifted, 'webhook', 'push')).toBe('auto');
    expect(coderActionDecision(lifted, 'webhook', 'pr')).toBe('ask');
    expect(coderActionDecision(lifted, 'bot', 'push')).toBe('ask');

    // A trigger entry's coder group or code_task rule is more specific than its default.
    const strict = resolveToolPolicy({
      triggers: { webhook: { default: 'auto', groups: { coder: 'deny' } } },
    });
    expect(coderActionDecision(strict, 'webhook', 'other')).toBe('deny');
  });

  it('is on unless turned off', () => {
    expect(coderEnabled(resolveToolPolicy(null))).toBe(true);
    expect(coderEnabled(resolveToolPolicy({ coder: { enabled: false } }))).toBe(false);
    expect(coderEnabled(resolveToolPolicy({ groups: { coder: 'deny' } }))).toBe(false);
  });
});

describe('coderProviderFits', () => {
  it('matches each agent to the keys it can use', () => {
    const native = (kind: 'anthropic' | 'openai' | 'google' | 'xai' | 'custom') =>
      ({ kind, protocol: 'native' }) as const;
    expect(coderProviderFits('claude', native('anthropic'))).toBe(true);
    expect(coderProviderFits('claude', { kind: 'custom', protocol: 'anthropic_compatible' })).toBe(
      true,
    );
    expect(coderProviderFits('claude', native('openai'))).toBe(false);
    expect(coderProviderFits('claude', { kind: 'custom', protocol: 'openai_compatible' })).toBe(
      false,
    );
    expect(coderProviderFits('codex', native('openai'))).toBe(true);
    expect(coderProviderFits('codex', { kind: 'custom', protocol: 'openai_compatible' })).toBe(
      true,
    );
    expect(coderProviderFits('codex', native('anthropic'))).toBe(false);
    for (const kind of ['anthropic', 'openai', 'google', 'xai'] as const) {
      expect(coderProviderFits('pi', native(kind))).toBe(true);
    }
    expect(coderProviderFits('pi', native('custom'))).toBe(false);
    expect(coderProviderFits('pi', { kind: 'custom', protocol: 'openai_compatible' })).toBe(false);
    expect(CODER_PROVIDER_KINDS.pi.message).toBe(
      'pi can use Anthropic, OpenAI, Google and xAI keys; custom endpoints are not supported yet',
    );
  });
});
