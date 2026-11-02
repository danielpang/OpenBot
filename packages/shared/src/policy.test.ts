import { describe, expect, it } from 'vitest';
import {
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

  it('fills in the defaults, keeping the webhook rule unless the owner replaces it', () => {
    const empty = { ...DEFAULT_TOOL_POLICY, httpAllowlist: null };
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

  it('orders decisions auto < ask < deny', () => {
    expect(stricterDecision('auto', 'ask')).toBe('ask');
    expect(stricterDecision('deny', 'ask')).toBe('deny');
    expect(stricterDecision('ask', 'auto')).toBe('ask');
  });
});
