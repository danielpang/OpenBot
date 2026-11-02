import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { fromAnthropicAction } from './actions.js';
import { createAgentClient, type ComputerAgentClient } from './agent-client.js';
import { createRemoteProvider } from './remote.js';
import {
  browserProfileDir,
  cdpPortFor,
  computerPath,
  nextDisplay,
  ScreenLocks,
  screenNumber,
} from './screens.js';
import { startFakeAgent, TINY_PNG, type FakeAgent } from './testing.js';

describe('agent client', () => {
  let agent: FakeAgent;
  let client: ComputerAgentClient;
  beforeEach(async () => {
    agent = await startFakeAgent();
    client = createAgentClient({ url: agent.url, token: agent.token });
  });
  afterEach(() => agent.close());

  it('sends the bearer token and reads health', async () => {
    expect(await client.health()).toEqual({ ok: true, version: 'fake' });
    const wrong = createAgentClient({ url: agent.url, token: 'nope' });
    await expect(wrong.health()).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Send the agent token',
    });
  });

  it('runs commands and reads the NDJSON stream', async () => {
    agent.exec = (req) => ({ stdout: `in ${req.cwd}\n`, stderr: 'warn\n', exitCode: 3 });
    const chunks: string[] = [];
    const result = await client.exec(
      { command: 'make', cwd: '/home/bot/app' },
      { onChunk: (c) => chunks.push(`${c.type}:${c.data}`) },
    );
    expect(result).toEqual({
      exitCode: 3,
      stdout: 'in /home/bot/app\n',
      stderr: 'warn\n',
      timedOut: false,
    });
    expect(chunks).toEqual(['stdout:in /home/bot/app\n', 'stderr:warn\n']);
    expect(agent.calls.at(-1)).toMatchObject({ path: '/exec', body: { command: 'make' } });
  });

  it('writes and reads binary files byte for byte', async () => {
    const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xe2, 0xff, 0x0a]);
    expect(await client.writeFile('/home/bot/out/report.pdf', bytes)).toEqual({ size: 8 });
    expect(new Uint8Array(agent.files.get('out/report.pdf')!)).toEqual(bytes);
    expect(await client.readFile('/home/bot/out/report.pdf')).toEqual(bytes);
  });

  it('reads, writes, lists and deletes files relative to the home, with escaped paths', async () => {
    expect(await client.writeFile('/home/bot/my notes/a#1.md', '# Hi')).toEqual({ size: 4 });
    expect(agent.files.get('my notes/a#1.md')).toEqual(new TextEncoder().encode('# Hi'));
    expect(new TextDecoder().decode(await client.readFile('/home/bot/my notes/a#1.md'))).toBe(
      '# Hi',
    );
    expect(await client.list('/home/bot')).toEqual({
      path: '/home/bot',
      entries: [
        expect.objectContaining({ name: 'my notes', path: '/home/bot/my notes', type: 'dir' }),
      ],
    });
    expect((await client.list('/home/bot/my notes')).entries).toEqual([
      expect.objectContaining({ name: 'a#1.md', path: '/home/bot/my notes/a#1.md', size: 4 }),
    ]);
    await expect(client.readFile('/home/bot/my notes')).rejects.toMatchObject({
      code: 'IS_A_DIRECTORY',
    });
    await expect(client.list('/home/bot/my notes/a#1.md')).rejects.toMatchObject({
      code: 'NOT_A_DIRECTORY',
    });
    await client.deleteFile('/home/bot/my notes', { recursive: true });
    expect(agent.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/fs/my%20notes' });
    await expect(client.readFile('/home/bot/my notes/a#1.md')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    await expect(client.readFile('/etc/hosts')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_HOME',
    });
  });

  it('starts screens by number, takes screenshots, sends input and browser actions', async () => {
    expect(await client.startScreen({ n: 0, width: 1280, height: 800 })).toMatchObject({
      n: 0,
      display: ':10',
      cdpPort: 9222,
    });
    expect(await client.screenshot(0)).toEqual(TINY_PNG);
    // The plan's actions become the agent's xdotool input (validated by its schema).
    await client.input(0, { action: 'click', coordinate: [5, 6], button: 'right' });
    await client.input(0, { action: 'key', text: 'ctrl+l' });
    await client.input(0, { action: 'drag', from: [1, 2], to: [3, 4] });
    await client.input(0, { action: 'scroll', coordinate: [7, 8], direction: 'down', amount: 2 });
    expect(agent.inputs.map((i) => i.action)).toEqual([
      { action: 'click', x: 5, y: 6, button: 'right' },
      { action: 'key', keys: 'ctrl+l' },
      { action: 'drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } },
      { action: 'scroll', x: 7, y: 8, direction: 'down', amount: 2 },
    ]);
    expect(await client.browser(0, { action: 'navigate', url: 'https://github.com' })).toEqual({
      url: 'https://github.com',
      title: 'Title of https://github.com',
    });
    await client.browser(0, { action: 'type', ref: 'e3', text: 'dana', submit: true });
    expect(agent.browser.at(-1)).toEqual({
      n: 0,
      action: { action: 'type', ref: 'e3', text: 'dana', submit: true },
    });
    await client.setWallpaper(7);
    expect(agent.calls.at(-1)).toMatchObject({ path: '/wallpaper', body: { hour: 7 } });
    await client.stopScreen(0);
    await expect(client.screenshot(0)).rejects.toMatchObject({
      status: 404,
      code: 'SCREEN_NOT_RUNNING',
    });
  });

  it("syncs one screen's cookies, or every screen's, into the shared store (K1)", async () => {
    await client.startScreen({ n: 2 });
    expect(await client.syncCookies(2)).toEqual({ screens: [2], cookies: 0 });
    expect(agent.calls.at(-1)).toMatchObject({ path: '/cookies/sync', body: { screen: 2 } });
    await client.syncCookies();
    expect(agent.calls.at(-1)).toMatchObject({ path: '/cookies/sync', body: {} });
    expect(agent.cookieSyncs).toEqual([2, null]);
    await expect(client.syncCookies(5)).rejects.toMatchObject({ code: 'SCREEN_NOT_RUNNING' });
  });

  it('runs a stdio MCP server in the computer and relays it both ways', async () => {
    const script = `process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => process.stdout.write('got ' + d.trim() + ' ' + process.env.KEY + '\\n'));
      process.stderr.write('warming up\\n');`;
    const out: string[] = [];
    const err: string[] = [];
    const exits: unknown[] = [];
    const proc = await client.mcpStdio(
      { command: process.execPath, args: ['-e', script], env: { KEY: 'v1' }, dirs: ['work'] },
      {
        stdout: (d) => out.push(d),
        stderr: (d) => err.push(d),
        exit: (info) => exits.push(info),
      },
    );
    expect(proc.pid).toBeGreaterThan(0);
    expect(agent.mcpStdio).toEqual([
      {
        type: 'start',
        command: process.execPath,
        args: ['-e', script],
        env: { KEY: 'v1' },
        dirs: ['work'],
      },
    ]);
    proc.write('hello\n');
    await vi.waitFor(() => expect(out.join('')).toBe('got hello v1\n'));
    await vi.waitFor(() => expect(err.join('')).toBe('warming up\n'));
    await proc.close();
    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(() => proc.write('more\n')).toThrow(/not running/);
  });

  it('rejects a stdio server that cannot start, or a wrong token', async () => {
    const handlers = { stdout: () => {}, stderr: () => {}, exit: () => {} };
    await expect(
      client.mcpStdio({ command: '/nonexistent/server', args: [], env: {} }, handlers),
    ).rejects.toMatchObject({
      code: 'MCP_STDIO_FAILED',
      message: expect.stringMatching(/^Could not start server: .*ENOENT/),
    });
    const wrong = createAgentClient({ url: agent.url, token: 'nope' });
    await expect(
      wrong.mcpStdio({ command: process.execPath, args: [], env: {} }, handlers),
    ).rejects.toMatchObject({ status: 401, code: 'MCP_STDIO_REFUSED' });
  });

  it('gives the proxies a socket URL with the token header', async () => {
    await client.startScreen({ n: 0 });
    const { url, headers } = client.socket('/vnc/0');
    expect(url).toBe(`${agent.url.replace('http', 'ws')}/vnc/0`);
    const ws = new WebSocket(url, { headers });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('hello'));
      ws.on('message', (data) => resolve(data.toString()));
      ws.on('error', reject);
    });
    ws.close();
    expect(reply).toBe('/vnc/0:hello');
  });
});

describe('remote provider', () => {
  it('points at an existing agent; start waits for it, stop leaves it running', async () => {
    const agent = await startFakeAgent({ token: 't' });
    try {
      const provider = createRemoteProvider({ url: agent.url, token: 't' });
      const ref = await provider.create({
        computerId: 'c',
        ownerId: 'o',
        image: 'ignored',
        agentToken: 'ignored',
        volumeName: 'v',
      });
      expect(ref).toMatchObject({ provider: 'remote', agentUrl: agent.url, containerId: null });
      await provider.start(ref);
      await provider.stop(ref);
      expect(await provider.status(ref)).toBe('running');
      expect(await provider.agent(ref).health()).toMatchObject({ ok: true });
      agent.healthy = false;
      expect(await provider.status(ref)).toBe('stopped');
    } finally {
      await agent.close();
    }
  });
});

describe('screens', () => {
  it('allocates the lowest free display from :10 with a matching CDP port', () => {
    expect(nextDisplay([])).toBe(10);
    expect(nextDisplay([10, 11, 13])).toBe(12);
    expect(cdpPortFor(10)).toBe(9222);
    expect(cdpPortFor(12)).toBe(9224);
    expect(screenNumber(12)).toBe(2);
    expect(browserProfileDir(12)).toBe('/var/lib/openbots/screens/screen-2/profile');
    expect(() => nextDisplay(Array.from({ length: 90 }, (_, i) => 10 + i))).toThrow(/taken/);
  });

  it('runs one task per key at a time and different keys in parallel', async () => {
    const locks = new ScreenLocks();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = locks.run('bot-a', async () => {
      order.push('a1 start');
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push('a1 end');
    });
    const second = locks.run('bot-a', async () => {
      order.push('a2');
    });
    const other = locks.run('bot-b', async () => {
      order.push('b1');
    });
    await other;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(['a1 start', 'b1']);
    expect(locks.held('bot-a')).toBe(true);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['a1 start', 'b1', 'a1 end', 'a2']);
    expect(locks.held('bot-a')).toBe(false);
  });

  it('gives up waiting when the signal aborts, and a failure releases the lock', async () => {
    const locks = new ScreenLocks();
    let release!: () => void;
    const held = locks.run('k', () => new Promise<void>((resolve) => (release = resolve)));
    const controller = new AbortController();
    const waiting = locks.run('k', async () => 'never', controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
    release();
    await held;
    await expect(locks.run('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(await locks.run('k', async () => 'next')).toBe('next');
  });

  it('normalizes paths under the home', () => {
    expect(computerPath('notes.md')).toBe('/home/bot/notes.md');
    expect(computerPath('~/a/../b.txt')).toBe('/home/bot/b.txt');
    expect(computerPath('/etc/hosts')).toBe('/etc/hosts');
    expect(() => computerPath('/etc/hosts', { withinHome: true })).toThrow(/under \/home\/bot/);
    expect(() => computerPath('../../etc', { withinHome: true })).toThrow();
    expect(() => computerPath('  ')).toThrow();
  });
});

describe('Anthropic computer-use mapping', () => {
  it('maps native actions onto the plan names', () => {
    expect(fromAnthropicAction({ action: 'screenshot' })).toEqual({ action: 'screenshot' });
    expect(fromAnthropicAction({ action: 'left_click', coordinate: [1, 2] })).toEqual({
      action: 'click',
      coordinate: [1, 2],
    });
    expect(fromAnthropicAction({ action: 'right_click', coordinate: [1, 2] })).toMatchObject({
      button: 'right',
    });
    expect(fromAnthropicAction({ action: 'triple_click', coordinate: [1, 2] })).toMatchObject({
      count: 3,
    });
    expect(
      fromAnthropicAction({
        action: 'left_click_drag',
        start_coordinate: [1, 2],
        coordinate: [3, 4],
      }),
    ).toEqual({ action: 'drag', from: [1, 2], to: [3, 4] });
    expect(fromAnthropicAction({ action: 'key', text: 'ctrl+l' })).toEqual({
      action: 'key',
      text: 'ctrl+l',
    });
    expect(
      fromAnthropicAction({
        action: 'scroll',
        coordinate: [5, 5],
        scroll_direction: 'up',
        scroll_amount: 3,
      }),
    ).toEqual({ action: 'scroll', coordinate: [5, 5], direction: 'up', amount: 3 });
    expect(fromAnthropicAction({ action: 'wait', duration: 2 })).toEqual({
      action: 'wait',
      seconds: 2,
    });
    expect(() => fromAnthropicAction({ action: 'cursor_position' })).toThrow(/does not support/);
    expect(() => fromAnthropicAction({ action: 'left_click' })).toThrow(/coordinate/);
  });
});
