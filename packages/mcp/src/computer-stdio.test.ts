import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ComputerStdioHost,
  ComputerStdioTransport,
  type RemoteStdio,
  type RemoteStdioHandlers,
} from './computer-stdio.js';
import { McpManager, RestartSkipped, type ConnectorSession } from './manager.js';
import { TEST_STDIO_SERVER } from './testing.js';

const textOf = (result: { content: unknown }) =>
  (result.content as { type: string; text: string }[])[0]!.text;

/**
 * Stands in for the computer agent's `/mcp/stdio` channel: each launch runs
 * the test server as a local child and relays its stdin, stdout, stderr and
 * exit through the same handlers the agent client calls.
 */
function fakeAgentChannel(env: Record<string, string> = {}) {
  const children: ChildProcessWithoutNullStreams[] = [];
  const launch = vi.fn(async (handlers: RemoteStdioHandlers): Promise<RemoteStdio> => {
    const child = spawn(process.execPath, [TEST_STDIO_SERVER], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await once(child, 'spawn');
    children.push(child);
    child.stdout.setEncoding('utf8').on('data', handlers.stdout);
    child.stderr.setEncoding('utf8').on('data', handlers.stderr);
    child.once('exit', (exitCode, signal) => handlers.exit({ exitCode, signal }));
    return {
      write: (data) => void child.stdin.write(data),
      async close() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.stdin.end();
        child.kill();
        await exited;
      },
    };
  });
  return { launch, children };
}

let hosts: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(hosts.map((h) => h.close()));
  hosts = [];
});

describe('ComputerStdioHost', () => {
  it('initializes over the channel, lists tools and calls one', async () => {
    const channel = fakeAgentChannel({ TEST_SECRET: 's3cret' });
    const host = new ComputerStdioHost({ launch: channel.launch });
    hosts.push(host);
    const snapshot = await host.start();
    expect(snapshot.server).toEqual({ name: 'openbots-test-stdio', version: '1.0.0' });
    expect(snapshot.tools.map((t) => t.name)).toEqual(['echo', 'whoami', 'grow']);
    expect(snapshot.resources.map((r) => r.uri)).toEqual(['test://readme']);
    expect(textOf(await host.callTool('echo', { text: 'über ✓ multi-byte' }))).toBe(
      'über ✓ multi-byte',
    );
    const who = JSON.parse(textOf(await host.callTool('whoami', {}))) as { secret: string };
    expect(who.secret).toBe('s3cret');
    expect(channel.launch).toHaveBeenCalledTimes(1);
  });

  it('reports the process exiting on its own once, and close stops it', async () => {
    const channel = fakeAgentChannel();
    const onClose = vi.fn();
    const host = new ComputerStdioHost({ launch: channel.launch }, { onClose });
    hosts.push(host);
    await host.start();
    channel.children[0]!.kill('SIGKILL');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await expect(host.callTool('echo', { text: 'x' })).rejects.toThrow(/not running/);

    const again = new ComputerStdioHost({ launch: channel.launch }, { onClose });
    hosts.push(again);
    await again.start();
    const child = channel.children[1]!;
    await again.close();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    // A close we asked for is not an exit to report.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fails to start with the channel error', async () => {
    const host = new ComputerStdioHost({
      launch: async () => {
        throw new Error('This server has no computer set up.');
      },
    });
    hosts.push(host);
    await expect(host.start()).rejects.toThrow('This server has no computer set up.');
  });
});

describe('ComputerStdioTransport', () => {
  it('reports activity on traffic, and keeps reporting while a request is in flight', async () => {
    const written: string[] = [];
    let handlers!: RemoteStdioHandlers;
    const onActivity = vi.fn();
    const transport = new ComputerStdioTransport({
      launch: async (h) => {
        handlers = h;
        return { write: (data) => void written.push(data), close: async () => {} };
      },
      onActivity,
      keepaliveMs: 10,
    });
    const received: unknown[] = [];
    transport.onmessage = (m) => received.push(m);
    await transport.start();
    await transport.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} });
    expect(written).toEqual(['{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{}}\n']);
    await new Promise((r) => setTimeout(r, 60));
    // Once for the send, then every 10 ms while the call runs.
    expect(onActivity.mock.calls.length).toBeGreaterThan(3);
    // An answer split across frames.
    handlers.stdout('{"jsonrpc":"2.0","id":7,');
    handlers.stdout('"result":{}}\n');
    expect(received).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }]);
    const after = onActivity.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(onActivity.mock.calls.length).toBe(after);
    handlers.stderr('some log\n');
    expect(transport.stderrTail).toBe('some log\n');
    const onclose = vi.fn();
    transport.onclose = onclose;
    const onerror = vi.fn();
    transport.onerror = onerror;
    handlers.exit({ exitCode: null, signal: null, error: 'The connection to the computer closed' });
    expect(onerror).toHaveBeenCalledWith(new Error('The connection to the computer closed'));
    expect(onclose).toHaveBeenCalledTimes(1);
    await expect(transport.send({ jsonrpc: '2.0', id: 8, method: 'ping' })).rejects.toThrow(
      /not running/,
    );
  });
});

describe('McpManager with computer stdio sessions', () => {
  const managed = (
    resolveExtra: (restart: boolean) => void = () => {},
    initialMs = 20,
    channel = fakeAgentChannel(),
  ) => {
    const errors: string[] = [];
    const contexts: boolean[] = [];
    const manager = new McpManager({
      resolve: async (id, context): Promise<ConnectorSession> => {
        contexts.push(context?.restart ?? false);
        resolveExtra(context?.restart ?? false);
        return {
          id,
          version: 'v1',
          restartOnCrash: true,
          create: (options) => new ComputerStdioHost({ launch: channel.launch }, options),
        };
      },
      onError: (_id, error) => void errors.push(error.message),
      restartBackoff: { initialMs, maxMs: 100, maxAttempts: 3, stableMs: 60_000 },
    });
    hosts.push(manager);
    return { manager, errors, contexts, channel };
  };

  it('restarts a server that exits on its own, with backoff', async () => {
    const { manager, contexts, channel } = managed(undefined, 300);
    expect(textOf(await manager.callTool('c1', 'echo', { text: 'one' }))).toBe('one');
    channel.children[0]!.kill('SIGKILL');
    await vi.waitFor(() => expect(manager.running('c1')).toBe(false), { interval: 5 });
    const crashed = Date.now();
    expect(manager.restarting('c1')).toBe(true);
    await vi.waitFor(() => expect(manager.running('c1')).toBe(true), { timeout: 3000 });
    expect(Date.now() - crashed).toBeGreaterThanOrEqual(250);
    expect(contexts).toEqual([false, true]);
    expect(channel.children).toHaveLength(2);
    expect(textOf(await manager.callTool('c1', 'echo', { text: 'two' }))).toBe('two');
  });

  it('gives up after too many exits in a row, and records why', { timeout: 30_000 }, async () => {
    const { manager, errors, channel } = managed();
    await manager.host('c1');
    // Starting a child process can take over a second on a loaded CI runner.
    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(manager.running('c1')).toBe(true), { timeout: 5000 });
      channel.children.at(-1)!.kill('SIGKILL');
      await vi.waitFor(() => expect(manager.running('c1')).toBe(false), { timeout: 5000 });
    }
    await new Promise((r) => setTimeout(r, 150));
    expect(manager.running('c1')).toBe(false);
    expect(manager.restarting('c1')).toBe(false);
    expect(channel.children).toHaveLength(4);
    expect(errors).toEqual([
      'The server exited 3 times in a row. It starts again on the next call.',
    ]);
    // The next call starts it again.
    expect(textOf(await manager.callTool('c1', 'echo', { text: 'back' }))).toBe('back');
  });

  it('stays down quietly when a restart is skipped (its computer stopped)', async () => {
    let computerRunning = true;
    const { manager, errors, channel } = managed((restart) => {
      if (restart && !computerRunning) throw new RestartSkipped('The computer is not running.');
    });
    await manager.host('c1');
    computerRunning = false;
    channel.children[0]!.kill('SIGKILL');
    await vi.waitFor(() => expect(manager.running('c1')).toBe(false));
    await new Promise((r) => setTimeout(r, 80));
    expect(manager.restarting('c1')).toBe(false);
    expect(manager.running('c1')).toBe(false);
    expect(errors).toEqual([]);
    expect(channel.children).toHaveLength(1);
  });

  it('does not restart a session it stopped', async () => {
    const { manager, channel } = managed();
    await manager.host('c1');
    await manager.stop('c1');
    await new Promise((r) => setTimeout(r, 60));
    expect(manager.restarting('c1')).toBe(false);
    expect(manager.running('c1')).toBe(false);
    expect(channel.children).toHaveLength(1);
  });
});
