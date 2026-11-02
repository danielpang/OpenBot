import { describe, expect, it } from 'vitest';
import { ImportError, parseMcpServers, slugify } from './import.js';

describe('parseMcpServers', () => {
  it('maps stdio and HTTP servers to connector rows, sealing env and headers', () => {
    const result = parseMcpServers(
      JSON.stringify({
        mcpServers: {
          'My Files': {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv/docs'],
            env: { DEBUG: '1' },
          },
          linear: {
            type: 'http',
            url: 'https://mcp.linear.app/mcp',
            headers: { Authorization: 'Bearer lin_123', 'X-Team': 'eng' },
          },
          github: { url: 'https://api.githubcopilot.com/mcp/' },
        },
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.connectors).toEqual([
      {
        name: 'My Files',
        slug: 'my-files',
        kind: 'mcp_stdio',
        catalogId: 'filesystem',
        config: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv/docs'],
          env: {},
        },
        secrets: { DEBUG: '1' },
      },
      {
        name: 'linear',
        slug: 'linear',
        kind: 'mcp_http',
        catalogId: null,
        config: {
          transport: 'http',
          url: 'https://mcp.linear.app/mcp',
          auth: 'bearer',
          bearerSecret: 'BEARER_TOKEN',
          headers: {},
          secretHeaders: { 'X-Team': 'HEADER_X_TEAM' },
        },
        secrets: { BEARER_TOKEN: 'lin_123', HEADER_X_TEAM: 'eng' },
      },
      {
        name: 'github',
        slug: 'github',
        kind: 'mcp_http',
        catalogId: 'github',
        config: {
          transport: 'http',
          url: 'https://api.githubcopilot.com/mcp/',
          auth: 'none',
          headers: {},
        },
        secrets: {},
      },
    ]);
  });

  it('accepts VS Code "servers", reports bad entries and de-duplicates slugs', () => {
    const result = parseMcpServers({
      servers: {
        'a b': { command: 'x' },
        'a-b': { command: 'y' },
        old: { type: 'sse', url: 'https://example.com/sse' },
        broken: { args: [] },
        badArgs: { command: 'z', args: [1] },
      },
    });
    expect(result.connectors.map((c) => c.slug)).toEqual(['a-b', 'a-b-2']);
    expect(result.errors.map((e) => e.name)).toEqual(['old', 'broken', 'badArgs']);
    expect(result.errors[0]!.message).toMatch(/SSE/);
  });

  it('refuses input that is not an mcpServers document', () => {
    expect(() => parseMcpServers('{nope')).toThrow(ImportError);
    expect(() => parseMcpServers({ foo: {} })).toThrow(/mcpServers/);
  });

  it('makes slugs safe for `<slug>__<tool>` names', () => {
    expect(slugify('GitHub (work)')).toBe('github-work');
    expect(slugify('my_server')).toBe('my-server');
    expect(slugify('!!!')).toBe('connector');
    expect(slugify('x'.repeat(40))).toHaveLength(32);
  });
});
