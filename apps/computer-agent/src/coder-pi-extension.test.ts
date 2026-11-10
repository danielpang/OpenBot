import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import openbotsExtension, {
  gateToolCall,
  piExtension,
  type PiExtensionApi,
  type PiToolCallEvent,
} from './coder-pi-extension.js';

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
  vi.unstubAllEnvs();
});

/** The agent's end of the session socket: records each request, answers with `answer`. */
async function fakeRelay(answer: (request: Record<string, unknown>) => string | undefined) {
  const base = await realpath(await mkdtemp('/tmp/ob-pi-'));
  const socket = path.join(base, 'permission.sock');
  const requests: Record<string, unknown>[] = [];
  const server: Server = createServer((conn) => {
    let buffer = '';
    conn.setEncoding('utf8');
    conn.on('data', (d: string) => {
      buffer += d;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const request = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
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

/** A stand-in for pi's API: keeps the `tool_call` handler the extension registers. */
function fakePi() {
  let handler: ((event: PiToolCallEvent, ctx: unknown) => Promise<unknown>) | undefined;
  const pi: PiExtensionApi = {
    registerTool: vi.fn(),
    on: (event, h) => {
      expect(event).toBe('tool_call');
      handler = h;
    },
  };
  return {
    pi,
    call: (event: PiToolCallEvent) => {
      if (!handler) throw new Error('no tool_call handler');
      return handler(event, {});
    },
  };
}

const bash: PiToolCallEvent = {
  toolName: 'bash',
  toolCallId: 'call_b1',
  input: { command: 'npm test' },
};

describe('the pi extension', () => {
  it('registers a native publishing tool with the same runner operation', async () => {
    const published = { branch: 'bot/fix', prUrl: 'https://github.com/acme/app/pull/1' };
    const relay = await fakeRelay(
      () => JSON.stringify({ decision: 'allow', message: JSON.stringify(published) }) + '\n',
    );
    const { pi, call } = fakePi();
    piExtension({ socket: relay.socket, mode: 'edit' })(pi);
    expect(pi.registerTool).toHaveBeenCalledOnce();
    const tool = vi.mocked(pi.registerTool).mock.calls[0]![0];
    expect(tool.name).toBe('publish_pull_request');
    await expect(
      call({ toolName: tool.name, input: { title: 'Fix', body: '' } }),
    ).resolves.toBeUndefined();
    expect(relay.requests).toEqual([]);
    expect(await tool.execute('p1', { title: 'Fix', body: '' })).toMatchObject({
      content: [{ text: JSON.stringify(published) }],
    });
    expect(relay.requests).toEqual([
      { tool_name: 'openbots.publish_pull_request', input: { title: 'Fix', body: '' } },
    ]);
  });

  it('does not register a publishing tool in plan mode', () => {
    const { pi } = fakePi();
    piExtension({ mode: 'plan' })(pi);
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  it('asks over the socket and lets an allowed call run', async () => {
    const relay = await fakeRelay(() => '{"decision":"allow"}\n');
    const { pi, call } = fakePi();
    piExtension({ socket: relay.socket })(pi);
    await expect(call(bash)).resolves.toBeUndefined();
    expect(relay.requests).toHaveLength(1);
    const [request] = relay.requests;
    expect(request).toMatchObject({ tool_name: 'bash', input: { command: 'npm test' } });
    expect(request!.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("blocks a denied call with the owner's message", async () => {
    const relay = await fakeRelay(() => '{"decision":"deny","message":"Not now"}\n');
    const { pi, call } = fakePi();
    piExtension({ socket: relay.socket })(pi);
    await expect(call(bash)).resolves.toEqual({ block: true, reason: 'Not now' });
  });

  it('reads the socket and the mode from the environment', async () => {
    const relay = await fakeRelay(() => '{"decision":"deny"}\n');
    vi.stubEnv('OPENBOTS_CODER_SOCKET', relay.socket);
    vi.stubEnv('OPENBOTS_CODER_MODE', 'edit');
    const { pi, call } = fakePi();
    openbotsExtension(pi);
    await expect(call(bash)).resolves.toEqual({ block: true, reason: 'The owner said no' });
    expect(relay.requests).toHaveLength(1);
  });

  it('blocks edits, writes and commands in plan mode without asking', async () => {
    const relay = await fakeRelay(() => '{"decision":"allow"}\n');
    for (const toolName of ['edit', 'write', 'bash', 'codemode']) {
      const verdict = await gateToolCall(
        { toolName, input: { path: 'src/link.ts' } },
        { socket: relay.socket, mode: 'plan' },
      );
      expect(verdict).toMatchObject({ block: true });
    }
    expect(relay.requests).toHaveLength(0);
    // Reads still go to the owner, who may be asked about one outside the worktree.
    await expect(
      gateToolCall(
        { toolName: 'read', input: { path: 'src/link.ts' } },
        { socket: relay.socket, mode: 'plan' },
      ),
    ).resolves.toBeUndefined();
    expect(relay.requests).toHaveLength(1);
  });

  it('denies when there is no socket or nobody answers', async () => {
    await expect(gateToolCall(bash, {})).resolves.toMatchObject({ block: true });
    const relay = await fakeRelay(() => undefined);
    await expect(gateToolCall(bash, { socket: relay.socket, timeoutMs: 50 })).resolves.toEqual({
      block: true,
      reason: 'Nobody answered the approval in time',
    });
  });

  it("waits as long as the launch's OPENBOTS_APPROVAL_TTL_MS says", async () => {
    vi.stubEnv('OPENBOTS_APPROVAL_TTL_MS', '50');
    const relay = await fakeRelay(() => undefined);
    await expect(gateToolCall(bash, { socket: relay.socket })).resolves.toEqual({
      block: true,
      reason: 'Nobody answered the approval in time',
    });
  });
});
