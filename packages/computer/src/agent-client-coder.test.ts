import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CoderClientMessage, CoderServerMessage } from '@openbots/computer-agent/protocol';
import { CoderClientMessageSchema } from '@openbots/computer-agent/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createAgentClient, type CoderExit, type ComputerAgentClient } from './agent-client.js';

// `ComputerAgentClient.coder` against a tiny WS /coder (I3): the frames the
// client writes are checked with the agent's own schema, and the script below
// plays the agent's side. The real session lands in the agent's coder.ts.

const TOKEN = 'coder-token';

interface Peer {
  frames: CoderClientMessage[];
  send(msg: CoderServerMessage): void;
  close(): void;
}

describe('agent client coder sessions', () => {
  let server: Server;
  let wss: WebSocketServer;
  let client: ComputerAgentClient;
  let url: string;
  /** What the fake agent does with each connection. */
  let onPeer: (peer: Peer) => void;
  const peers: Peer[] = [];

  beforeEach(async () => {
    server = createServer();
    wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path !== '/coder' || req.headers.authorization !== `Bearer ${TOKEN}`) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const peer: Peer = {
          frames: [],
          send: (msg) => ws.send(JSON.stringify(msg)),
          close: () => ws.close(1000),
        };
        peers.push(peer);
        ws.on('message', (raw) => {
          const frame = CoderClientMessageSchema.parse(JSON.parse(raw.toString()));
          peer.frames.push(frame);
          if (frame.type === 'start') onPeer(peer);
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = createAgentClient({ url, token: TOKEN });
    peers.length = 0;
  });
  afterEach(async () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const handlers = () => {
    const seen = {
      stdout: [] as string[],
      stderr: [] as string[],
      credentials: [] as unknown[],
      permissions: [] as unknown[],
      exits: [] as CoderExit[],
      errors: [] as string[],
    };
    return {
      seen,
      handlers: {
        stdout: (d: string) => seen.stdout.push(d),
        stderr: (d: string) => seen.stderr.push(d),
        credentialRequest: (r: unknown) => seen.credentials.push(r),
        permissionRequest: (r: unknown) => seen.permissions.push(r),
        exit: (info: CoderExit) => seen.exits.push(info),
        error: (m: string) => seen.errors.push(m),
      },
    };
  };

  it('starts a session and relays output, credentials and permission prompts both ways', async () => {
    onPeer = (peer) => {
      peer.send({ type: 'started', pid: 42, session_dir: '/var/lib/openbots/coders/sessions/s1' });
      peer.send({ type: 'stdout', data: '{"type":"system"}\n' });
      peer.send({ type: 'stderr', data: 'warming up\n' });
      peer.send({
        type: 'credential_request',
        request_id: 'c1',
        protocol: 'https',
        host: 'github.com',
        path: 'openbots/relay.git',
      });
      peer.send({
        type: 'permission_request',
        request_id: 'p1',
        tool_name: 'Bash',
        input: { command: 'git push' },
      });
    };
    const { seen, handlers: h } = handlers();
    const proc = await client.coder(
      {
        session_id: 'session-0001',
        command: 'claude',
        args: ['-p', 'Fix it', '--mcp-config', '{{session_dir}}/mcp.json'],
        cwd: 'repos/openbots/relay/.worktrees/bot-fix',
        env: { CLAUDE_CONFIG_DIR: '/var/lib/openbots/coders/claude' },
      },
      h,
    );
    expect(await proc.started).toEqual({
      pid: 42,
      sessionDir: '/var/lib/openbots/coders/sessions/s1',
    });
    const peer = peers[0]!;
    // The agent's schema filled in its defaults on the start frame.
    expect(peer.frames[0]).toEqual({
      type: 'start',
      session_id: 'session-0001',
      user: 'coder',
      command: 'claude',
      args: ['-p', 'Fix it', '--mcp-config', '{{session_dir}}/mcp.json'],
      cwd: 'repos/openbots/relay/.worktrees/bot-fix',
      env: { CLAUDE_CONFIG_DIR: '/var/lib/openbots/coders/claude' },
      pty: false,
      git_credentials: true,
    });
    await vi.waitFor(() => expect(seen.permissions).toHaveLength(1));
    expect(seen.stdout).toEqual(['{"type":"system"}\n']);
    expect(seen.stderr).toEqual(['warming up\n']);
    expect(seen.credentials).toEqual([
      { request_id: 'c1', protocol: 'https', host: 'github.com', path: 'openbots/relay.git' },
    ]);
    expect(seen.permissions).toEqual([
      { request_id: 'p1', tool_name: 'Bash', input: { command: 'git push' } },
    ]);

    proc.credential({ request_id: 'c1', username: 'x-access-token', password: 'ghs_1' });
    proc.answer({ request_id: 'p1', decision: 'deny', message: 'Push needs approval' });
    proc.write('more\n');
    proc.write('last\n', { end: true });
    proc.end();
    proc.signal('SIGINT');
    proc.resize(120, 40);
    await vi.waitFor(() => expect(peer.frames).toHaveLength(8));
    expect(peer.frames.slice(1)).toEqual([
      { type: 'credential', request_id: 'c1', username: 'x-access-token', password: 'ghs_1' },
      { type: 'answer', request_id: 'p1', decision: 'deny', message: 'Push needs approval' },
      { type: 'stdin', data: 'more\n' },
      { type: 'stdin', data: 'last\n', end: true },
      { type: 'stdin', data: '', end: true },
      { type: 'signal', signal: 'SIGINT' },
      { type: 'resize', cols: 120, rows: 40 },
    ]);

    peer.send({ type: 'exit', code: 0, signal: null });
    await vi.waitFor(() => expect(seen.exits).toEqual([{ code: 0, signal: null }]));
    expect(() => proc.write('late\n')).toThrow(/not running/);
    await proc.close();
    expect(seen.exits).toHaveLength(1);
  });

  it("ends with the agent's error when the process cannot start", async () => {
    onPeer = (peer) => {
      peer.send({ type: 'error', message: 'Could not start claude: ENOENT' });
      peer.close();
    };
    const { seen, handlers: h } = handlers();
    const proc = await client.coder({ session_id: 'session-0002', command: 'claude' }, h);
    await expect(proc.started).rejects.toMatchObject({
      code: 'CODER_FAILED',
      message: 'Could not start claude: ENOENT',
    });
    await vi.waitFor(() => expect(seen.exits).toHaveLength(1));
    expect(seen.exits[0]).toEqual({
      code: null,
      signal: null,
      error: 'Could not start claude: ENOENT',
    });
    expect(seen.errors).toEqual(['Could not start claude: ENOENT']);
  });

  it('tells the session it ended when the connection drops', async () => {
    onPeer = (peer) => {
      peer.send({ type: 'started', pid: 7, session_dir: '/s' });
      setTimeout(() => peer.close(), 10);
    };
    const { seen, handlers: h } = handlers();
    const proc = await client.coder({ session_id: 'session-0003', command: 'codex' }, h);
    await proc.started;
    await vi.waitFor(() => expect(seen.exits).toHaveLength(1));
    expect(seen.exits[0]).toMatchObject({ code: null, error: expect.stringMatching(/closed/) });
  });

  it('fails a process that never says it started', async () => {
    onPeer = () => {};
    const { seen, handlers: h } = handlers();
    const proc = await client.coder({ session_id: 'session-0004', command: 'pi' }, h, {
      timeoutMs: 50,
    });
    await expect(proc.started).rejects.toMatchObject({ code: 'CODER_FAILED' });
    expect(seen.exits[0]?.error).toMatch(/in time/);
  });

  it('rejects a wrong token without calling the handlers', async () => {
    const { seen, handlers: h } = handlers();
    const wrong = createAgentClient({ url, token: 'nope' });
    await expect(
      wrong.coder({ session_id: 'session-0005', command: 'claude' }, h),
    ).rejects.toMatchObject({ status: 401, code: 'CODER_REFUSED' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.exits).toEqual([]);
  });

  it('gives the server a /coder socket URL with the token header', () => {
    expect(client.socket('/coder?login=claude')).toEqual({
      url: `${url.replace('http', 'ws')}/coder?login=claude`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
  });
});
