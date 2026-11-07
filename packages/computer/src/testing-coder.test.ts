import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentClient, type CoderExit, type ComputerAgentClient } from './agent-client.js';
import { startFakeAgent, type FakeAgent } from './testing.js';

// The fake agent's scripted `/coder`, as server tests drive it through the
// real client.

describe('fake agent /coder', () => {
  let agent: FakeAgent;
  let client: ComputerAgentClient;
  beforeEach(async () => {
    agent = await startFakeAgent();
    client = createAgentClient({ url: agent.url, token: agent.token });
  });
  afterEach(() => agent.close());

  const handlers = () => {
    const seen = { stdout: [] as string[], credentials: [] as unknown[], exits: [] as CoderExit[] };
    return {
      seen,
      handlers: {
        stdout: (d: string) => seen.stdout.push(d),
        stderr: () => {},
        credentialRequest: (r: unknown) => seen.credentials.push(r),
        permissionRequest: () => {},
        exit: (e: CoderExit) => seen.exits.push(e),
      },
    };
  };

  it('records the start and, by default, starts and exits at once', async () => {
    const { seen, handlers: h } = handlers();
    const proc = await client.coder({ session_id: 'session-0001', command: 'claude' }, h);
    expect(await proc.started).toEqual({
      pid: 1,
      sessionDir: '/tmp/openbots/coders/session-0001',
    });
    await vi.waitFor(() => expect(seen.exits).toEqual([{ code: 0, signal: null }]));
    expect(agent.coderStarts).toEqual([
      expect.objectContaining({ session_id: 'session-0001', command: 'claude', user: 'coder' }),
    ]);
  });

  it("records a runner start (the server's git operations) as it came", async () => {
    const { seen, handlers: h } = handlers();
    await client.coder(
      { session_id: 'session-0003', command: 'git', args: ['fetch'], user: 'runner' },
      h,
    );
    await vi.waitFor(() => expect(seen.exits).toHaveLength(1));
    expect(agent.coderStarts).toEqual([
      expect.objectContaining({ session_id: 'session-0003', command: 'git', user: 'runner' }),
    ]);
  });

  it('plays a frame list, then closes after its exit', async () => {
    agent.coderScript = [
      { type: 'started', pid: 9, session_dir: '/s' },
      { type: 'stdout', data: '{"type":"result"}\n' },
      { type: 'exit', code: 2, signal: null },
    ];
    const { seen, handlers: h } = handlers();
    await client.coder({ session_id: 'session-0002', command: 'codex' }, h);
    await vi.waitFor(() => expect(seen.exits).toEqual([{ code: 2, signal: null }]));
    expect(seen.stdout).toEqual(['{"type":"result"}\n']);
  });

  it('lets a script wait on what the server sends back', async () => {
    agent.coderScript = async (session) => {
      session.send({ type: 'started', pid: 3, session_dir: '/s' });
      session.send({
        type: 'credential_request',
        request_id: 'c1',
        protocol: 'https',
        host: 'github.com',
      });
      const credential = await session.next('credential');
      session.send({ type: 'stdout', data: `pushed with ${credential.username}\n` });
      await session.next('stdin');
      session.send({ type: 'exit', code: 0, signal: null });
      session.close();
    };
    const { seen, handlers: h } = handlers();
    const proc = await client.coder({ session_id: 'session-0003', command: 'claude' }, h);
    await vi.waitFor(() => expect(seen.credentials).toHaveLength(1));
    proc.credential({ request_id: 'c1', username: 'x-access-token', password: 'ghs_1' });
    await vi.waitFor(() => expect(seen.stdout).toEqual(['pushed with x-access-token\n']));
    proc.write('bye\n');
    await vi.waitFor(() => expect(seen.exits).toHaveLength(1));
    expect(agent.coderFrames).toEqual([
      { type: 'credential', request_id: 'c1', username: 'x-access-token', password: 'ghs_1' },
      { type: 'stdin', data: 'bye\n' },
    ]);
  });
});
