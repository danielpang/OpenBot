import { describe, expect, it } from 'vitest';
import { approvalWaitLabel, labelFor, thoughtLabel } from './labels.js';

// One case per row of the plan 6.2 table, in its order.

describe('activity labels', () => {
  it('computer start', () => {
    expect(labelFor('computer_start', {}, { durationMs: 387 })).toBe('Environment ready 387ms');
    expect(labelFor('computer_start', {})).toBe('Starting environment');
  });

  it('edit_file', () => {
    expect(labelFor('edit_file', { path: 'src/math.ts' }, { added: 14, removed: 10 })).toBe(
      'Edited math.ts +14 −10',
    );
    expect(labelFor('edit_file', { path: 'src/math.ts' })).toBe('Editing math.ts');
  });

  it('read_file', () => {
    expect(labelFor('read_file', { path: '/repo/AGENTS.md' }, { content: '...' })).toBe(
      'Read AGENTS.md',
    );
    expect(labelFor('read_file', { path: 'AGENTS.md' })).toBe('Reading AGENTS.md');
  });

  it('bash', () => {
    expect(labelFor('bash', { command: 'npm test' })).toBe('Running npm test');
    expect(
      labelFor('bash', { command: 'npm test' }, { exitCode: 0, stdout: 'Tests  212 passed (212)' }),
    ).toBe('Ran npm test: 212 passed');
    expect(labelFor('bash', { command: 'npm test' }, { exitCode: 1, stdout: '3 passed' })).toBe(
      'Ran npm test: exit 1',
    );
    expect(labelFor('bash', { command: 'ls\nrm x' }, { exitCode: 0, stdout: 'a b' })).toBe(
      'Ran ls',
    );
  });

  it('browser_navigate', () => {
    expect(labelFor('browser_navigate', { url: 'https://www.github.com/x/y' }, {})).toBe(
      'Opened github.com',
    );
    expect(labelFor('browser_navigate', { url: 'https://github.com' })).toBe('Opening github.com');
  });

  it('web_search', () => {
    expect(labelFor('web_search', { query: 'toFixed' }, { results: [] })).toBe(
      "Searched web 'toFixed'",
    );
    expect(labelFor('web_search', { query: 'toFixed' })).toBe("Searching web 'toFixed'");
  });

  it('MCP tool: connector name plus tool title', () => {
    expect(
      labelFor('github__create_issue', {}, undefined, {
        connectorName: 'GitHub',
        toolTitle: 'Create issue',
      }),
    ).toBe('GitHub: Create issue');
    // Without catalog metadata, from the tool name itself.
    expect(labelFor('linear__createIssue', {}, {})).toBe('Linear: Create issue');
  });

  it('LLM step without a tool', () => {
    expect(thoughtLabel(800)).toBe('Thought briefly');
    expect(thoughtLabel(12_000)).toBe('Thought for 12s');
    expect(thoughtLabel(75_000)).toBe('Thought for 1m 15s');
  });

  it('create_artifact', () => {
    expect(labelFor('create_artifact', { title: 'Q3 summary' }, { id: 'a' })).toBe(
      'Created "Q3 summary"',
    );
    expect(labelFor('create_artifact', { title: 'Q3 summary' })).toBe('Creating "Q3 summary"');
  });

  it('approval wait', () => {
    expect(approvalWaitLabel('send_email')).toBe('Waiting for approval: send email');
    expect(approvalWaitLabel('github__create_issue', { connectorName: 'GitHub' })).toBe(
      'Waiting for approval: GitHub: Create issue',
    );
  });

  it('falls back to the tool name and tolerates bad arguments', () => {
    expect(labelFor('list_files', { path: '.' })).toBe('List files');
    expect(labelFor('read_file', null)).toBe('Reading file');
    expect(labelFor('bash', { command: 'x'.repeat(200) })).toHaveLength('Running '.length + 60);
  });
});

describe('conversation tool labels', () => {
  it('labels show_widget, ask_user, remember and search_memory', () => {
    expect(labelFor('show_widget', { kind: 'status_summary' })).toBe('Showing status summary');
    expect(labelFor('show_widget', { kind: 'file' }, { shown: true })).toBe('Showed file');
    expect(labelFor('ask_user', { question: 'Which repo?' })).toBe("Asking 'Which repo?'");
    expect(labelFor('request_login', { site: 'github.com' })).toBe(
      'Asking for a sign-in to github.com',
    );
    expect(labelFor('remember', { content: 'Prefers tabs' }, { saved: true })).toBe(
      "Remembered 'Prefers tabs'",
    );
    expect(labelFor('search_memory', { query: 'deploy' }, { items: [] })).toBe(
      "Searched memory 'deploy'",
    );
  });
});
