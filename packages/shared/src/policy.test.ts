import { describe, expect, it } from 'vitest';
import {
  CoderModelNameSchema,
  DEFAULT_TOOL_POLICY,
  resolveToolPolicy,
  SOURCE_TRIGGER,
  sourceOfTrigger,
  stricterDecision,
  ToolPolicySchema,
} from './policy.js';

describe('tool policy', () => {
  it('accepts per-tool, per-group and per-trigger settings', () => {
    const policy = {
      tools: { bash: 'auto', github__delete_repo: 'deny' },
      groups: { connector: 'ask' },
      triggers: { routine: { default: 'ask', tools: { send_email: 'deny' } } },
    };
    expect(ToolPolicySchema.parse(policy)).toEqual(policy);
    expect(ToolPolicySchema.parse({})).toEqual({});
  });

  it('refuses unknown keys, groups and decisions', () => {
    expect(ToolPolicySchema.safeParse({ bash: 'ask' }).success).toBe(false);
    expect(ToolPolicySchema.safeParse({ tools: { bash: 'maybe' } }).success).toBe(false);
    expect(ToolPolicySchema.safeParse({ groups: { email: 'ask' } }).success).toBe(false);
    expect(ToolPolicySchema.safeParse({ triggers: { cron: {} } }).success).toBe(false);
  });

  it('drops only the coder key that does not parse, and keeps the rest of the policy', () => {
    const stored = {
      tools: { bash: 'deny' },
      coder: {
        enabled: true,
        defaultAgent: 'codex',
        allowedRepos: ['acme/relay'],
        models: { codex: '--dangerously-bypass-approvals-and-sandbox' },
      },
    };
    expect(ToolPolicySchema.safeParse(stored).success).toBe(false);
    const policy = resolveToolPolicy(stored);
    expect(policy.tools).toEqual({ bash: 'deny' });
    expect(policy.coder).toEqual({
      enabled: true,
      defaultAgent: 'codex',
      allowedRepos: ['acme/relay'],
    });
    // Another bad coder key: only it goes.
    expect(
      resolveToolPolicy({ coder: { enabled: 'yes', models: { pi: 'anthropic/claude' } } }).coder,
    ).toEqual({ models: { pi: 'anthropic/claude' } });
    expect(resolveToolPolicy({ coder: 'on' }).coder).toEqual({});
    // A policy that is bad elsewhere still counts as empty, coder and all.
    const elsewhere = resolveToolPolicy({ tools: { bash: 'maybe' }, coder: { enabled: false } });
    expect(elsewhere).toEqual({ ...DEFAULT_TOOL_POLICY, httpAllowlist: null, coder: {} });
  });

  it('fills in the defaults, keeping the webhook rule unless the owner replaces it', () => {
    const empty = { ...DEFAULT_TOOL_POLICY, httpAllowlist: null, coder: {} };
    expect(resolveToolPolicy(null)).toEqual(empty);
    expect(resolveToolPolicy({ bash: 'auto' })).toEqual(empty);
    expect(resolveToolPolicy({ tools: { bash: 'auto' } })).toMatchObject({
      tools: { bash: 'auto' },
      triggers: { webhook: { default: 'ask' } },
    });
    expect(resolveToolPolicy({ triggers: { webhook: { default: 'auto' } } }).triggers).toEqual({
      webhook: { default: 'auto' },
      bot_dm: { default: 'ask' },
    });
  });

  it('asks by default in runs other Bots start, like webhook runs', () => {
    const { triggers } = resolveToolPolicy(null);
    expect(triggers.bot_dm).toEqual({ default: 'ask' });
    // `bot_message` is the owner's own unaddressed group message (plan 5.1): no floor.
    expect(triggers.bot_message).toBeUndefined();
    expect(triggers.mention).toBeUndefined();
    expect(triggers.webhook).toEqual({ default: 'ask' });
    expect(triggers.message).toBeUndefined();
    expect(triggers.routine).toBeUndefined();
  });

  it('merges trigger overrides deeply, keeping the default unless the owner sets one', () => {
    const { triggers } = resolveToolPolicy({
      triggers: {
        webhook: { tools: { send_email: 'deny' } },
        bot_dm: {},
        routine: { groups: { computer: 'ask' } },
      },
    });
    expect(triggers.webhook).toEqual({ default: 'ask', tools: { send_email: 'deny' } });
    expect(triggers.bot_dm).toEqual({ default: 'ask' });
    expect(triggers.routine).toEqual({ groups: { computer: 'ask' } });
    expect(
      resolveToolPolicy({
        triggers: { bot_message: { default: 'deny', groups: { builtin: 'ask' } } },
      }).triggers.bot_message,
    ).toEqual({ default: 'deny', groups: { builtin: 'ask' } });
  });

  it('takes the source a run came from by who wrote it, the trigger only as a fallback', () => {
    expect(sourceOfTrigger('webhook')).toBe('webhook');
    expect(sourceOfTrigger('bot_dm')).toBe('bot');
    for (const trigger of ['message', 'mention', 'bot_message', 'routine', 'resume']) {
      expect(sourceOfTrigger(trigger)).toBe('owner');
    }
    expect(SOURCE_TRIGGER).toEqual({ bot: 'bot_dm', webhook: 'webhook' });
  });

  it('keeps an http_request domain allowlist of hosts and wildcard domains', () => {
    const policy = ToolPolicySchema.parse({ httpAllowlist: ['API.github.com', '*.example.com'] });
    expect(policy.httpAllowlist).toEqual(['api.github.com', '*.example.com']);
    expect(resolveToolPolicy(policy).httpAllowlist).toEqual(['api.github.com', '*.example.com']);
    expect(resolveToolPolicy({ httpAllowlist: [] }).httpAllowlist).toEqual([]);
    for (const bad of ['https://x.io', 'x.io:443', 'a.*.io', '*']) {
      expect(ToolPolicySchema.safeParse({ httpAllowlist: [bad] }).success).toBe(false);
    }
  });

  it('keeps the coder settings and the coder group (CA9)', () => {
    const coder = {
      enabled: false,
      defaultAgent: 'codex',
      actions: { push: 'auto', install: 'deny' },
      allowedRepos: ['openbots/relay'],
      models: { codex: 'gpt-5.3-codex', pi: 'anthropic/claude-sonnet-4-5:high' },
    };
    const policy = ToolPolicySchema.parse({ groups: { coder: 'ask' }, coder });
    expect(policy).toEqual({ groups: { coder: 'ask' }, coder });
    expect(resolveToolPolicy(policy)).toMatchObject({ groups: { coder: 'ask' }, coder });
    for (const bad of [
      { coder: { defaultAgent: 'cursor' } },
      { coder: { actions: { merge: 'ask' } } },
      { coder: { allowedRepos: ['https://github.com/a/b'] } },
      { coder: { extra: true } },
      { coder: { models: { cursor: 'gpt-5' } } },
      { coder: { models: { codex: '' } } },
      { coder: { models: { codex: 'x'.repeat(101) } } },
      { coder: { models: { codex: '--dangerously-bypass-approvals-and-sandbox' } } },
      { coder: { models: { pi: 'gpt 5' } } },
    ]) {
      expect(ToolPolicySchema.safeParse(bad).success).toBe(false);
    }
  });

  it('carries per-agent model overrides through resolution (CA9)', () => {
    const resolved = resolveToolPolicy({ coder: { models: { claude: ' claude-opus-4-5 ' } } });
    expect(resolved.coder.models).toEqual({ claude: 'claude-opus-4-5' });
    expect(resolveToolPolicy({}).coder.models).toBeUndefined();
    expect(CoderModelNameSchema.parse('x'.repeat(100))).toHaveLength(100);
  });

  it('orders decisions auto < ask < deny', () => {
    expect(stricterDecision('auto', 'ask')).toBe('ask');
    expect(stricterDecision('deny', 'ask')).toBe('deny');
    expect(stricterDecision('ask', 'auto')).toBe('ask');
  });
});
