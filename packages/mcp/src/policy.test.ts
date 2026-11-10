import { describe, expect, it } from 'vitest';
import { blockedBy, matchCatalog, toolPermitted } from './policy.js';
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
  it('blocks by URL pattern against the URL, the host or the command line', () => {
    const rule = (urlPattern: string) => [{ urlPattern }];
    const slack = { config: http('https://mcp.slack.com/mcp') };
    expect(blockedBy(slack, rule('https://*.slack.com/*'))).not.toBeNull();
    expect(blockedBy(slack, rule('*.SLACK.com'))).not.toBeNull();
    expect(blockedBy(slack, rule('slack.com'))).toBeNull();
    expect(blockedBy(slack, rule('https://mcp.slack.com'))).toBeNull();
    expect(
      blockedBy({ config: stdio('uvx', ['mcp-server-fetch']) }, rule('*mcp-server-fetch*')),
    ).not.toBeNull();
    // Built-ins have no URL or command, so nothing blocks them.
    expect(
      blockedBy({ config: { transport: 'builtin', builtin: 'web_fetch' } }, rule('*')),
    ).toBeNull();
    expect(blockedBy({}, rule('*'))).toBeNull();
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
