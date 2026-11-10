import type { ToolPolicy } from './policy.js';

/** A named policy rule, shared by bot file tools and coding-agent permission prompts. */
export const CODING_EDITS_RULE = 'coding_edits';
export const ACCEPT_EDITS_HELP =
  'Accept file edits inside the worktree without asking. Shell scripts, access outside the worktree, network access, pushes, pull requests, installs and destructive commands can still require approval. Coding-agent sandbox changes apply on the next turn.';

export function acceptsEdits(policy: ToolPolicy = {}): boolean {
  return ['write_file', 'edit_file', CODING_EDITS_RULE].every(
    (name) => policy.tools?.[name] === 'auto',
  );
}

export function withAcceptEdits(policy: ToolPolicy, enabled: boolean): ToolPolicy {
  const decision = enabled ? 'auto' : 'ask';
  return {
    ...policy,
    tools: {
      ...policy.tools,
      write_file: decision,
      edit_file: decision,
      [CODING_EDITS_RULE]: decision,
    },
  };
}

/** Only dedicated edit tools; shell commands and MCP tools must keep their own approval. */
export function isFileEditTool(name: string): boolean {
  return [
    'write_file',
    'edit_file',
    'Edit',
    'MultiEdit',
    'Write',
    'NotebookEdit',
    'edit',
    'write',
    'fileChange',
    'file_change',
    'apply_patch',
  ].includes(name);
}
