#!/usr/bin/env node
// A tiny MCP server over stdio for the package's tests (and anyone checking a
// stdio setup by hand): `node test-server/stdio-server.mjs`. It reports its
// own uid, environment names and capabilities, and whether it can read its
// parent's environment, so tests can prove what the child received.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'openbots-test-stdio', version: '1.0.0' });

server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Returns its input',
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ text }) => ({ content: [{ type: 'text', text }] }),
);

server.registerTool(
  'whoami',
  { description: 'The uid and environment variable names the server runs with' },
  async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          uid: typeof process.getuid === 'function' ? process.getuid() : null,
          env: Object.keys(process.env).sort(),
          secret: process.env.TEST_SECRET ?? null,
          // Linux only: the effective capabilities, and what reading the
          // parent's /proc/<pid>/environ gives (true, or the error code).
          capEff: (() => {
            try {
              return (
                /^CapEff:\s*(\S+)$/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? null
              );
            } catch {
              return null;
            }
          })(),
          parentEnviron: (() => {
            try {
              readFileSync(`/proc/${process.ppid}/environ`);
              return true;
            } catch (err) {
              return err.code ?? String(err);
            }
          })(),
          homeWritable: (() => {
            try {
              writeFileSync(join(process.env.HOME ?? '/nonexistent', '.probe'), 'ok');
              return true;
            } catch {
              return false;
            }
          })(),
        }),
      },
    ],
  }),
);

server.registerTool(
  'grow',
  { description: 'Adds a tool, which sends tools/list_changed' },
  async () => {
    server.registerTool('grown', { description: 'Added at runtime' }, async () => ({
      content: [{ type: 'text', text: 'grown' }],
    }));
    return { content: [{ type: 'text', text: 'ok' }] };
  },
);

server.registerResource(
  'readme',
  'test://readme',
  { title: 'Readme', mimeType: 'text/plain' },
  async (uri) => ({ contents: [{ uri: uri.href, text: 'hello' }] }),
);

server.registerPrompt('greet', { description: 'Says hello' }, () => ({
  messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
}));

await server.connect(new StdioServerTransport());
