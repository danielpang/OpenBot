import { describe, expect, it } from 'vitest';
import { NOT_ON_ALLOW_LIST, blockedBy, matchCatalog, toolPermitted } from './policy.js';
import type { TransportConfig } from './types.js';

const http = (url: string): TransportConfig => ({
  transport: 'http',
  url,
  auth: 'none',
  headers: {},
});
const stdio = (command: string, args: string[]): TransportConfig => ({
  transport: 'stdio',
  command,
  args,
  env: {},
});

describe('block list', () => {
  it('blocks by catalog id, including typed-in copies of a catalog server', () => {
    const rules = [{ catalogId: 'postgres', urlPattern: null }];
    expect(blockedBy({ catalogId: 'postgres' }, rules)).toEqual(rules[0]);
    expect(
      blockedBy(
        { config: stdio('npx', ['-y', '@modelcontextprotocol/server-postgres', 'pg://x']) },
        rules,
      ),
    ).toEqual(rules[0]);
    expect(blockedBy({ catalogId: 'filesystem' }, rules)).toBeNull();
  });

  it('blocks by URL pattern against the URL, the host or the command line', () => {
    const rule = (urlPattern: string) => [{ catalogId: null, urlPattern }];
    const slack = { config: http('https://mcp.slack.com/mcp') };
    expect(blockedBy(slack, rule('https://*.slack.com/*'))).not.toBeNull();
    expect(blockedBy(slack, rule('*.SLACK.com'))).not.toBeNull();
    expect(blockedBy(slack, rule('slack.com'))).toBeNull();
    expect(blockedBy(slack, rule('https://mcp.slack.com'))).toBeNull();
    expect(
      blockedBy({ config: stdio('uvx', ['mcp-server-fetch']) }, rule('*mcp-server-fetch*')),
    ).not.toBeNull();
    // Regex metacharacters in patterns are literal.
    expect(blockedBy({ config: http('https://axb.com/') }, rule('https://a.b.com/'))).toBeNull();
  });

  it('matches connectors to catalog entries by URL or package', () => {
    expect(matchCatalog(http('https://api.githubcopilot.com/mcp'))).toBe('github');
    expect(matchCatalog(http('https://example.com/mcp'))).toBeNull();
    // The fetch server left the catalog (S-3), so a typed-in copy is a custom server.
    expect(matchCatalog(stdio('uvx', ['mcp-server-fetch==2025.1.1']))).toBeNull();
    expect(
      matchCatalog(stdio('npx', ['@modelcontextprotocol/server-filesystem@1.0.0', '/x'])),
    ).toBe('filesystem');
    expect(matchCatalog(stdio('node', ['server.js']))).toBeNull();
  });
});

describe('allow list (U3)', () => {
  const allow = (...ids: string[]) =>
    ids.map((catalogId) => ({ catalogId, urlPattern: null, allow: true }));

  it('allows everything while empty', () => {
    expect(blockedBy({ catalogId: 'postgres' }, [])).toBeNull();
    expect(blockedBy({ config: http('https://example.com/mcp') }, [])).toBeNull();
  });

  it('lets only listed catalog entries through once it has one', () => {
    const rules = allow('github', 'filesystem');
    expect(blockedBy({ catalogId: 'github' }, rules)).toBeNull();
    expect(blockedBy({ catalogId: 'postgres' }, rules)).toBe(NOT_ON_ALLOW_LIST);
    // Custom servers are not on it, but typed-in copies of a listed entry are.
    expect(blockedBy({ config: http('https://example.com/mcp') }, rules)).toBe(NOT_ON_ALLOW_LIST);
    expect(blockedBy({ config: http('https://api.githubcopilot.com/mcp/') }, rules)).toBeNull();
  });

  it('still applies the block list on top', () => {
    const rules = [...allow('github'), { catalogId: null, urlPattern: '*githubcopilot*' }];
    expect(
      blockedBy({ catalogId: 'github', config: http('https://api.githubcopilot.com/mcp/') }, rules),
    ).toEqual(rules[1]);
  });
});

describe('per-Bot tool permissions', () => {
  it('allows everything without a row, and the denylist beats the allowlist', () => {
    expect(toolPermitted('read', undefined)).toBe(true);
    expect(toolPermitted('read', { toolAllowlist: null, toolDenylist: [] })).toBe(true);
    expect(toolPermitted('write', { toolAllowlist: null, toolDenylist: ['write'] })).toBe(false);
    expect(toolPermitted('read', { toolAllowlist: ['read'], toolDenylist: [] })).toBe(true);
    expect(toolPermitted('write', { toolAllowlist: ['read'], toolDenylist: [] })).toBe(false);
    expect(toolPermitted('read', { toolAllowlist: ['read'], toolDenylist: ['read'] })).toBe(false);
    expect(toolPermitted('read', { toolAllowlist: [], toolDenylist: [] })).toBe(false);
  });
});
