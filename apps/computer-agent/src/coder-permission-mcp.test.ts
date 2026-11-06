import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askOwner, serve } from './coder-permission-mcp.js';

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** The agent's end of the session socket: records each request, answers with `answer`. */
async function fakeRelay(answer: (request: unknown) => string | undefined) {
  const base = await realpath(await mkdtemp('/tmp/ob-perm-'));
  const socket = path.join(base, 'permission.sock');
  const requests: unknown[] = [];
  const server: Server = createServer((conn) => {
    let buffer = '';
    conn.setEncoding('utf8');
    conn.on('data', (d: string) => {
      buffer += d;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const request = JSON.parse(buffer.slice(0, nl)) as unknown;
      requests.push(request);
      const reply = answer(request);
      if (reply !== undefined) conn.end(reply);
    });
  });
  await new Promise<void>((r) => server.listen(socket, r));
  cleanups.push(
    () => rm(base, { recursive: true, force: true }),
    () => new Promise<void>((r) => server.close(() => r())),
  );
  return { socket, requests };
}

/** The MCP server on in-memory stdio; `call` writes a message, `replies` collects lines. */
function mcp(socket: string | undefined, timeoutMs?: number) {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Record<string, unknown>[] = [];
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', (d: string) => {
    buffer += d;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      replies.push(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>);
      buffer = buffer.slice(nl + 1);
    }
  });
  const done = serve(input, output, { socket, ...(timeoutMs ? { timeoutMs } : {}) });
  cleanups.push(() => {
    input.end();
    return done;
  });
  return {
    replies,
    call: (message: unknown) => input.write(`${JSON.stringify(message)}\n`),
    reply: async (id: number) => {
      await vi.waitFor(() => expect(replies.some((r) => r.id === id)).toBe(true));
      return replies.find((r) => r.id === id)!;
    },
  };
}

const text = (reply: Record<string, unknown>) =>
  JSON.parse(
    (reply.result as { content: { type: string; text: string }[] }).content[0]!.text,
  ) as unknown;

describe('the permission MCP server (I11)', () => {
  it('does the MCP handshake and lists its one tool', async () => {
    const server = mcp(undefined);
    server.call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude' } },
    });
    expect(await server.reply(1)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'openbots-permission', version: '1.0.0' },
      },
    });
    server.call({ jsonrpc: '2.0', method: 'notifications/initialized' });
    server.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await server.reply(2);
    expect(list.result).toMatchObject({
      tools: [
        {
          name: 'permission_prompt',
          inputSchema: {
            type: 'object',
            properties: {
              tool_name: { type: 'string' },
              input: { type: 'object' },
              tool_use_id: { type: 'string' },
            },
            required: ['tool_name', 'input'],
          },
        },
      ],
    });
    server.call({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    expect((await server.reply(3)).error).toMatchObject({ code: -32601 });
    server.call({ jsonrpc: '2.0', id: 4, method: 'ping' });
    expect((await server.reply(4)).result).toEqual({});
    // The notification got no answer of its own.
    expect(server.replies.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });

  it("asks over the session's socket and returns Claude Code's allow with the input", async () => {
    const relay = await fakeRelay(() => '{"decision":"allow"}\n');
    const server = mcp(relay.socket);
    const input = { command: 'npm test' };
    server.call({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'permission_prompt',
        arguments: { tool_name: 'Bash', input, tool_use_id: 'toolu_1' },
      },
    });
    expect(text(await server.reply(7))).toEqual({ behavior: 'allow', updatedInput: input });
    expect(relay.requests).toEqual([{ request_id: 'toolu_1', tool_name: 'Bash', input }]);
  });

  it("returns the owner's deny with its message", async () => {
    const relay = await fakeRelay(() => '{"decision":"deny","message":"Not on main"}\n');
    const server = mcp(relay.socket);
    server.call({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'permission_prompt', arguments: { tool_name: 'Bash', input: {} } },
    });
    expect(text(await server.reply(8))).toEqual({ behavior: 'deny', message: 'Not on main' });
  });

  it('denies when there is no socket, the relay hangs up, or nobody answers in time', async () => {
    const noSocket = await askOwner(undefined, { tool_name: 'Bash', input: {} });
    expect(noSocket.decision).toBe('deny');
    const missing = await askOwner('/tmp/ob-none/permission.sock', {
      tool_name: 'Bash',
      input: {},
    });
    expect(missing).toEqual({ decision: 'deny', message: 'OpenBots could not ask the owner' });
    const hangUp = await fakeRelay(() => '');
    expect(await askOwner(hangUp.socket, { tool_name: 'Bash', input: {} })).toEqual({
      decision: 'deny',
      message: 'OpenBots gave no answer',
    });
    const silent = await fakeRelay(() => undefined);
    expect(await askOwner(silent.socket, { tool_name: 'Bash', input: {} }, 50)).toEqual({
      decision: 'deny',
      message: 'Nobody answered the approval in time',
    });
  });

  it('refuses another tool and a call without tool_name', async () => {
    const server = mcp(undefined);
    server.call({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'rm', arguments: {} },
    });
    expect((await server.reply(1)).error).toMatchObject({ code: -32602 });
    server.call({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'permission_prompt', arguments: { input: {} } },
    });
    expect((await server.reply(2)).error).toMatchObject({ code: -32602 });
  });
});
