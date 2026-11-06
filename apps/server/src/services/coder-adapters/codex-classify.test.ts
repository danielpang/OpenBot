import { describe, expect, it } from 'vitest';
import { codexAdapter, unwrapShell } from './codex.js';

// Codex raises no permission prompts in `exec` mode; `classify` holds the
// interface with Claude Code's classifier, a command read as Bash and a file
// change as an Edit of each path.

const context = { worktreePath: '/home/bot/repos/acme/relay/.worktrees/bot-fix-reconnect' };
const classOf = (toolName: string, input: unknown) =>
  codexAdapter.classify(toolName, input, context).action;

describe('codex classify', () => {
  it('reads Codex commands through their shell wrapper', () => {
    expect(unwrapShell("/bin/bash -lc 'npm test'")).toBe('npm test');
    expect(unwrapShell('git status')).toBe('git status');
    expect(unwrapShell("bash -lc 'a' && rm -rf /")).toBe("bash -lc 'a' && rm -rf /");
  });

  it('classes commands as Claude Code does', () => {
    expect(classOf('command_execution', { command: "/bin/bash -lc 'git status'" })).toBe('other');
    expect(classOf('command_execution', { command: "/bin/bash -lc 'git push origin x'" })).toBe(
      'push',
    );
    expect(classOf('commandExecution', { command: ['npm', 'install', 'x'] })).toBe('install');
    expect(classOf('command_execution', { command: 'rm -rf build' })).toBe('destructive');
    expect(classOf('command_execution', { command: 'cat ~/.ssh/id_rsa' })).toBe('outside_worktree');
  });

  it('classes a file change by its strictest path', () => {
    expect(
      classOf('file_change', { changes: [{ path: `${context.worktreePath}/src/a.ts` }] }),
    ).toBe('other');
    expect(
      classOf('file_change', {
        changes: [{ path: `${context.worktreePath}/src/a.ts` }, { path: '/etc/hosts' }],
      }),
    ).toBe('outside_worktree');
    expect(classOf('fileChange', { path: '/var/lib/openbots/coders/codex/auth.json' })).toBe(
      'destructive',
    );
  });

  it('classes anything else as other', () => {
    expect(codexAdapter.classify('mcp_tool_call', {})).toEqual({
      action: 'other',
      title: 'Use mcp_tool_call',
    });
  });
});
