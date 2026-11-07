import { describe, expect, it } from 'vitest';
import { acceptsEdits, withAcceptEdits } from './accept-edits.js';
import { coderActionDecision } from './coders.js';
import { resolveToolPolicy, ToolPolicySchema } from './policy.js';

describe('accept edits', () => {
  it('matches the ask-before-edits UI when no edit policy is saved', () => {
    expect(acceptsEdits({})).toBe(false);
    const policy = resolveToolPolicy({});
    expect(coderActionDecision(policy, 'owner', 'other', 'Edit')).toBe('ask');
    expect(coderActionDecision(policy, 'owner', 'other', 'fileChange')).toBe('ask');
    expect(coderActionDecision(policy, 'owner', 'other', 'commandExecution')).toBe('ask');
  });
  it('persists ordinary file tools and the coding rule without changing other policies', () => {
    const policy = withAcceptEdits(
      { tools: { bash: 'ask' }, coder: { actions: { pr: 'deny' } } },
      true,
    );
    expect(ToolPolicySchema.parse(policy)).toEqual(policy);
    expect(acceptsEdits(policy)).toBe(true);
    expect(policy.tools?.bash).toBe('ask');
    expect(policy.coder?.actions?.pr).toBe('deny');
    expect(acceptsEdits(withAcceptEdits(policy, false))).toBe(false);
    expect(withAcceptEdits(policy, false).tools?.edit_file).toBe('ask');
  });
  it('accepts only in-worktree edit prompts and preserves protected actions and trigger floors', () => {
    const on = resolveToolPolicy(withAcceptEdits({}, true));
    const off = resolveToolPolicy(withAcceptEdits({}, false));
    expect(coderActionDecision(on, 'owner', 'other', 'Edit')).toBe('auto');
    expect(coderActionDecision(off, 'owner', 'other', 'Edit')).toBe('ask');
    expect(coderActionDecision(off, 'owner', 'other', 'commandExecution')).toBe('ask');
    expect(coderActionDecision(on, 'webhook', 'other', 'Edit')).toBe('ask');
    for (const action of ['pr', 'push', 'install', 'destructive', 'outside_worktree'] as const) {
      expect(coderActionDecision(on, 'owner', action, 'Edit')).toBe('ask');
    }
    expect(
      coderActionDecision(
        resolveToolPolicy(withAcceptEdits({ coder: { actions: { other: 'deny' } } }, true)),
        'owner',
        'other',
        'Edit',
      ),
    ).toBe('deny');
  });
});
