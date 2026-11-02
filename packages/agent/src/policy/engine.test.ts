import type { PolicyDecision, ToolPolicy } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import { gated, NeedsApproval } from '../gated.js';
import { createPolicy, evaluatePolicy, type PolicyInput } from './engine.js';
import type { ToolFacts } from './rules.js';
import { summarizeArgs } from './summary.js';

const builtin: ToolFacts = { group: 'builtin' };
const computer: ToolFacts = { group: 'computer' };
/** A connector tool; its hints are believed unless `hintsTrusted` is false (S-16). */
const mcp = (
  annotations?: ToolFacts['annotations'],
  override?: PolicyDecision,
  hintsTrusted = true,
): ToolFacts => ({
  group: 'connector',
  ...(annotations ? { annotations } : {}),
  connector: { slug: 'github', approvalOverride: override ?? null, hintsTrusted },
});

function decide(
  toolName: string,
  facts: ToolFacts,
  args: unknown = {},
  more: Partial<PolicyInput> = {},
) {
  return evaluatePolicy({ toolName, args, facts, trigger: 'message', ...more });
}

describe('policy engine', () => {
  it.each([
    ['ask_user', { group: 'conversation' }, {}, 'auto'],
    ['remember', { group: 'conversation' }, {}, 'auto'],
    ['create_artifact', { group: 'artifacts' }, {}, 'auto'],
    ['web_search', builtin, { query: 'x' }, 'auto'],
    ['web_fetch', builtin, { url: 'https://example.com' }, 'auto'],
    ['http_request', builtin, { url: 'https://api.example.com' }, 'auto'],
    ['http_request', builtin, { method: 'get', url: 'https://api.example.com' }, 'auto'],
    ['http_request', builtin, { method: 'POST', url: 'https://api.example.com' }, 'ask'],
    ['http_request', builtin, { method: 'DELETE', url: 'https://api.example.com' }, 'ask'],
    ['send_email', builtin, { to: ['a@b.c'] }, 'ask'],
    ['bash', computer, { command: 'npm test' }, 'ask'],
    ['write_file', computer, { path: 'a.ts' }, 'ask'],
    ['edit_file', computer, { path: 'a.ts' }, 'ask'],
    ['read_file', computer, { path: 'a.ts' }, 'auto'],
    ['list_files', computer, { path: '.' }, 'auto'],
    ['list_dir', computer, { path: '.' }, 'auto'],
    ['browser_snapshot', computer, {}, 'auto'],
    ['browser_click', computer, { ref: 'e1' }, 'auto'],
    ['computer', computer, { action: 'click' }, 'auto'],
    ['mystery_builtin', builtin, {}, 'ask'],
    ['screenshot', computer, {}, 'ask'],
  ] as const)('defaults: %s %j -> %s', (tool, facts, args, expected) => {
    const result = decide(tool, facts as ToolFacts, args);
    expect(result.decision).toBe(expected);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]!.rule).toBe('default');
    expect(result.reason).toBe(result.trace[0]!.why);
  });

  it('decides MCP tools from their annotations', () => {
    expect(decide('github__list_issues', mcp({ readOnlyHint: true }))).toMatchObject({
      decision: 'auto',
      trace: [{ rule: 'annotations', decision: 'auto' }],
      reason: 'github__list_issues is marked read-only, reaching outside OpenBots',
    });
    expect(
      decide('github__list_issues', mcp({ readOnlyHint: true, openWorldHint: false })).reason,
    ).toBe('github__list_issues is marked read-only');
    expect(decide('github__delete_repo', mcp({ destructiveHint: true }))).toMatchObject({
      decision: 'ask',
      reason: 'github__delete_repo is marked destructive',
    });
    expect(
      decide('github__create_issue', mcp({ readOnlyHint: false, destructiveHint: false })),
    ).toMatchObject({
      decision: 'ask',
      reason: 'github__create_issue is not marked read-only',
    });
    // No hints at all: MCP's own defaults say it may write.
    expect(decide('github__create_issue', mcp())).toMatchObject({
      decision: 'ask',
      trace: [{ rule: 'default' }],
    });
    // A built-in may declare the same hints.
    expect(
      decide('weather', { group: 'builtin', annotations: { readOnlyHint: true } }).decision,
    ).toBe('auto');
    // A rule for the name wins over hints.
    expect(
      decide('bash', { group: 'computer', annotations: { readOnlyHint: true } }).decision,
    ).toBe('ask');
  });

  it('believes read-only hints only from catalog or trusted connectors', () => {
    const custom = mcp({ readOnlyHint: true }, undefined, false);
    expect(decide('evil__exfiltrate', custom)).toMatchObject({
      decision: 'ask',
      trace: [{ rule: 'annotations', decision: 'ask' }],
      reason:
        'evil__exfiltrate says it is read-only, but its connector is not from the catalog or trusted',
    });
    // Facts without a connector record count as untrusted too.
    expect(
      decide('evil__exfiltrate', { group: 'connector', annotations: { readOnlyHint: true } })
        .decision,
    ).toBe('ask');
    expect(decide('github__list_issues', mcp({ readOnlyHint: true })).decision).toBe('auto');
    // A destructive hint is believed from anyone.
    expect(decide('evil__wipe', mcp({ destructiveHint: true }, undefined, false))).toMatchObject({
      decision: 'ask',
      reason: 'evil__wipe is marked destructive',
    });
    // The owner may still allow the tool by name.
    expect(
      decide(
        'evil__exfiltrate',
        custom,
        {},
        { toolPolicy: { tools: { evil__exfiltrate: 'auto' } } },
      ).decision,
    ).toBe('auto');
  });

  it('layers the Bot settings: group, then connector override, then tool', () => {
    const toolPolicy: ToolPolicy = { groups: { connector: 'deny' } };
    expect(
      decide('github__list_issues', mcp({ readOnlyHint: true }), {}, { toolPolicy }),
    ).toMatchObject({
      decision: 'deny',
      reason: 'Bot setting for connector tools',
    });
    const overridden = decide(
      'github__list_issues',
      mcp({ readOnlyHint: true }, 'ask'),
      {},
      {
        toolPolicy,
      },
    );
    expect(overridden.trace.map((s) => [s.rule, s.decision])).toEqual([
      ['annotations', 'auto'],
      ['group', 'deny'],
      ['connector', 'ask'],
    ]);
    expect(overridden.reason).toBe('Bot setting for the github connector');
    const own = decide(
      'github__list_issues',
      mcp(undefined, 'deny'),
      {},
      {
        toolPolicy: { ...toolPolicy, tools: { github__list_issues: 'auto' } },
      },
    );
    expect(own).toMatchObject({ decision: 'auto', reason: 'Bot setting for github__list_issues' });

    // Settings loosen as well as tighten.
    expect(decide('bash', computer, {}, { toolPolicy: { tools: { bash: 'auto' } } }).decision).toBe(
      'auto',
    );
    expect(
      decide('web_search', builtin, {}, { toolPolicy: { groups: { builtin: 'ask' } } }).decision,
    ).toBe('ask');
    expect(
      decide(
        'remember',
        { group: 'conversation' },
        {},
        { toolPolicy: { tools: { remember: 'deny' } } },
      ).decision,
    ).toBe('deny');
  });

  it('ignores a policy it cannot read', () => {
    expect(decide('bash', computer, {}, { toolPolicy: { bash: 'auto' } }).decision).toBe('ask');
    expect(decide('bash', computer, {}, { toolPolicy: 'yes' }).decision).toBe('ask');
  });

  it('makes webhook runs stricter by default, never looser', () => {
    const toolPolicy: ToolPolicy = { tools: { bash: 'auto', send_email: 'auto' } };
    expect(decide('bash', computer, {}, { toolPolicy }).decision).toBe('auto');
    const hooked = decide('bash', computer, {}, { toolPolicy, trigger: 'webhook' });
    expect(hooked).toMatchObject({ decision: 'ask', reason: 'Stricter rule for webhook runs' });
    expect(hooked.trace.map((s) => s.rule)).toEqual(['default', 'tool', 'trigger']);
    // Reads and conversation tools are left alone.
    expect(decide('web_search', builtin, {}, { trigger: 'webhook' }).decision).toBe('auto');
    expect(decide('ask_user', { group: 'conversation' }, {}, { trigger: 'webhook' }).decision).toBe(
      'auto',
    );
    // Routines carry no default override.
    expect(decide('bash', computer, {}, { toolPolicy, trigger: 'routine' }).decision).toBe('auto');
    // A trigger rule can deny outright, and cannot loosen.
    const strict: ToolPolicy = {
      ...toolPolicy,
      triggers: { routine: { tools: { send_email: 'deny', bash: 'auto' } } },
    };
    expect(
      decide('send_email', builtin, {}, { toolPolicy: strict, trigger: 'routine' }).decision,
    ).toBe('deny');
    expect(
      decide(
        'bash',
        computer,
        {},
        { toolPolicy: { triggers: { routine: { default: 'auto' } } }, trigger: 'routine' },
      ).decision,
    ).toBe('ask');
    // An owner entry for webhook runs keeps the default unless it sets one (S-15).
    for (const webhook of [{}, { tools: { send_email: 'deny' as const } }]) {
      expect(
        decide(
          'bash',
          computer,
          {},
          {
            toolPolicy: { ...toolPolicy, triggers: { webhook } },
            trigger: 'webhook',
          },
        ).decision,
      ).toBe('ask');
    }
    // The owner may lift the webhook default explicitly.
    expect(
      decide(
        'bash',
        computer,
        {},
        {
          toolPolicy: { ...toolPolicy, triggers: { webhook: { default: 'auto' } } },
          trigger: 'webhook',
        },
      ).decision,
    ).toBe('auto');
  });

  it.each([
    ['bot_dm', undefined, 'Stricter rule for bot_dm runs'],
    ['mention', 'bot', "Stricter rule for runs another Bot's message started"],
  ] as const)(
    'asks before tools that change something when another Bot started the run (%s)',
    (trigger, source, reason) => {
      const run = { trigger, ...(source ? { source } : {}) };
      const toolPolicy: ToolPolicy = { tools: { bash: 'auto', send_email: 'auto' } };
      expect(decide('bash', computer, {}, { toolPolicy, ...run })).toMatchObject({
        decision: 'ask',
        reason,
      });
      expect(decide('send_email', builtin, {}, { toolPolicy, ...run }).decision).toBe('ask');
      expect(
        decide('http_request', builtin, { method: 'POST', url: 'https://x.io' }, run).decision,
      ).toBe('ask');
      // Reads and conversation tools still run.
      expect(decide('web_search', builtin, {}, run).decision).toBe('auto');
      expect(decide('remember', { group: 'conversation' }, {}, run).decision).toBe('auto');
      // The owner can lift it, only explicitly, with the bot_dm entry.
      expect(
        decide(
          'bash',
          computer,
          {},
          { toolPolicy: { ...toolPolicy, triggers: { bot_dm: { default: 'auto' } } }, ...run },
        ).decision,
      ).toBe('auto');
    },
  );

  it.each(['bot_message', 'mention', 'message'])(
    "keeps the Bot's own settings for the owner's messages (%s)",
    (trigger) => {
      const toolPolicy: ToolPolicy = { tools: { bash: 'auto' } };
      // The owner's unaddressed group message is a bot_message run (plan 5.1), not data.
      expect(decide('bash', computer, {}, { toolPolicy, trigger }).decision).toBe('auto');
      expect(decide('bash', computer, {}, { toolPolicy, trigger, source: 'owner' })).toEqual({
        decision: 'auto',
        reason: 'Bot setting for bash',
        trace: [
          expect.objectContaining({ rule: 'default' }),
          expect.objectContaining({ rule: 'tool' }),
        ],
      });
    },
  );

  it('applies webhook rules to any run webhook data started, whatever its trigger', () => {
    const toolPolicy: ToolPolicy = { tools: { bash: 'auto' } };
    expect(
      decide('bash', computer, {}, { toolPolicy, trigger: 'routine', source: 'webhook' }),
    ).toMatchObject({ decision: 'ask', reason: 'Stricter rule for runs a webhook started' });
    expect(
      decide(
        'web_fetch',
        builtin,
        { url: 'https://evil.example/?q=1' },
        { trigger: 'routine', source: 'webhook' },
      ).decision,
    ).toBe('ask');
    expect(
      decide(
        'bash',
        computer,
        {},
        {
          toolPolicy: { ...toolPolicy, triggers: { webhook: { default: 'auto' } } },
          trigger: 'routine',
          source: 'webhook',
          triggerOverride: { groups: { computer: 'deny' } },
        },
      ),
    ).toMatchObject({ decision: 'deny', reason: 'Stricter rule for this webhook' });
  });

  it('asks before GET fetches in webhook runs unless the host is on the allowlist', () => {
    const fetches = [
      ['web_fetch', { url: 'https://evil.example/?q=secret' }],
      ['http_request', { url: 'https://evil.example/?q=secret' }],
      ['http_request', { method: 'HEAD', url: 'https://evil.example/' }],
    ] as const;
    for (const [tool, args] of fetches) {
      expect(decide(tool, builtin, args, { trigger: 'webhook' })).toMatchObject({
        decision: 'ask',
        reason:
          "Webhook runs ask before fetching from evil.example outside the Bot's domain allowlist",
      });
      // Other runs fetch as before.
      expect(decide(tool, builtin, args, { trigger: 'message' }).decision).toBe('auto');
      expect(decide(tool, builtin, args, { trigger: 'routine' }).decision).toBe('auto');
    }
    const allowlisted = { httpAllowlist: ['*.example.com', 'api.github.com'] };
    expect(
      decide(
        'web_fetch',
        builtin,
        { url: 'https://docs.example.com/a' },
        {
          trigger: 'webhook',
          toolPolicy: allowlisted,
        },
      ).decision,
    ).toBe('auto');
    expect(
      decide(
        'http_request',
        builtin,
        { url: 'https://api.github.com/repos' },
        {
          trigger: 'webhook',
          toolPolicy: allowlisted,
        },
      ).decision,
    ).toBe('auto');
    expect(
      decide(
        'web_fetch',
        builtin,
        { url: 'https://evil.example/' },
        {
          trigger: 'webhook',
          toolPolicy: allowlisted,
        },
      ).decision,
    ).toBe('ask');
    // A URL it cannot read asks too; lifting the webhook default does not lift this.
    expect(decide('web_fetch', builtin, { url: 'nope' }, { trigger: 'webhook' }).decision).toBe(
      'ask',
    );
    expect(
      decide(
        'web_fetch',
        builtin,
        { url: 'https://evil.example/' },
        {
          trigger: 'webhook',
          toolPolicy: { triggers: { webhook: { default: 'auto' } } },
        },
      ).decision,
    ).toBe('ask');
    // A stricter rule already in force is kept.
    expect(
      decide(
        'web_fetch',
        builtin,
        { url: 'https://evil.example/' },
        {
          trigger: 'webhook',
          triggerOverride: { groups: { builtin: 'deny' } },
        },
      ).decision,
    ).toBe('deny');
  });

  it('applies an override carried by what started the run (a webhook endpoint)', () => {
    const result = decide(
      'web_fetch',
      builtin,
      {},
      {
        trigger: 'webhook',
        triggerOverride: { groups: { builtin: 'deny' } },
      },
    );
    expect(result).toMatchObject({ decision: 'deny', reason: 'Stricter rule for this webhook' });
  });

  it('builds a Policy over a run, guessing facts for unknown tools', async () => {
    const policy = createPolicy({
      toolPolicy: { tools: { github__star: 'auto' } },
      facts: (name) => (name === 'bash' ? computer : undefined),
    });
    const run = { id: 'r', botId: 'b', chatId: 'c', trigger: 'message' };
    expect(await policy.evaluate(run, 'bash', { command: 'ls' })).toMatchObject({
      decision: 'ask',
    });
    expect(await policy.evaluate(run, 'github__star', {})).toMatchObject({ decision: 'auto' });
    expect(await policy.evaluate(run, 'github__fork', {})).toMatchObject({
      decision: 'ask',
      reason: 'github__fork is a connector tool without a read-only hint',
    });

    // `gated` turns `ask` into the approval widget, with the summary and the trace.
    const thrown = await gated({
      run,
      policy,
      toolName: 'bash',
      args: { command: 'rm -rf build' },
      onStart: () => {},
      execute: async () => 'ran',
    }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(NeedsApproval);
    expect((thrown as NeedsApproval).request.widget).toEqual({
      kind: 'approval',
      props: {
        tool_name: 'bash',
        args: { command: 'rm -rf build' },
        summary: '$ rm -rf build',
        reason: 'bash runs commands on the computer',
        trace: [{ rule: 'default', decision: 'ask', why: 'bash runs commands on the computer' }],
      },
    });
  });

  it('summarizes arguments in one readable line', () => {
    expect(summarizeArgs('bash', { command: 'npm   test\n --run' })).toBe('$ npm test --run');
    expect(summarizeArgs('http_request', { method: 'post', url: 'https://x.io/a' })).toBe(
      'POST https://x.io/a',
    );
    expect(summarizeArgs('send_email', { to: ['a@b.c', 'd@e.f'], subject: 'Hi' })).toBe(
      'Email to a@b.c, d@e.f: “Hi”',
    );
    expect(summarizeArgs('github__create_issue', { title: 'Bug', labels: ['a'], body: null })).toBe(
      'title: Bug, labels: ["a"]',
    );
    expect(summarizeArgs('x', { a: 1, b: 2, c: 3, d: 4, e: 5 })).toBe(
      'a: 1, b: 2, c: 3, d: 4, +1 more',
    );
    expect(summarizeArgs('x', { a: 'y'.repeat(300) })).toHaveLength(123);
  });
});
