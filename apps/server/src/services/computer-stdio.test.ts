import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerName, createDockerProvider, type ComputerProvider } from '@openbots/computer';
import { mockDocker, startFakeAgent, type FakeAgent } from '@openbots/computer/testing';
import { TEST_STDIO_SERVER } from '@openbots/mcp/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { setComputerProvider, sweepIdleComputers } from './computer.js';
import { NO_COMPUTER, STDIO_TOUCH_MS } from './computer-stdio.js';
import { closeMcpManager, mcpManager } from './connectors.js';
import { inEveryOrganization } from '../workers.js';

// Stdio connectors in their owner's computer (OPENBOTS_STDIO_RUNNER=computer,
// the managed default). Every computer here is the docker provider over a
// mocked dockerode with its own in-process fake agent, which runs the agent's
// real `/mcp/stdio` and starts the in-repo test server in place of the
// catalog binary that only the computer image has.

interface Connector {
  id: string;
  status: string;
  lastError: string | null;
}

/** One fake agent per computer, keyed by computer id. */
function useComputers(deps: AppDeps) {
  const agents = new Map<string, FakeAgent>();
  const byContainer = new Map<string, FakeAgent>();
  const docker = mockDocker();
  const inner = createDockerProvider({
    docker,
    agentUrl: (name) => byContainer.get(name)!.url,
    pollMs: 5,
  });
  const provider: ComputerProvider = {
    ...inner,
    async create(spec) {
      let agent = agents.get(spec.computerId);
      if (!agent) {
        agent = await startFakeAgent();
        agent.mcpLaunch = (start) => ({
          ...start,
          command: process.execPath,
          args: [TEST_STDIO_SERVER],
        });
        agents.set(spec.computerId, agent);
        byContainer.set(containerName(spec.computerId), agent);
      }
      agent.token = spec.agentToken;
      return inner.create(spec);
    },
  };
  setComputerProvider(deps, provider);
  return {
    agents,
    provider,
    close: () => Promise.all([...agents.values()].map((a) => a.close())),
  };
}

const textOf = (result: { content: unknown }) =>
  (result.content as { type: string; text: string }[])[0]!.text;

describe('stdio connectors in the computer (managed)', () => {
  let t: TestApp;
  let computers: ReturnType<typeof useComputers>;
  let alice: string;
  let bob: string;
  let carol: string;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    computers = useComputers(t.ownerDeps);
    alice = (await t.signUp('alice@example.com')).cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
    carol = (await t.signUp('carol@example.com')).cookie!;
    orgA = await t.defaultOrganization();
    orgB = await t.createOrganization('Org B');
    await t.addMember(await t.userId('alice@example.com'), orgB, 'owner');
  });
  afterAll(async () => {
    await closeMcpManager(t.ownerDeps);
    await computers.close();
    await t.close();
  });

  const call = async (cookie: string, method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const create = async (cookie: string, body: Record<string, unknown>) => {
    const res = await call(cookie, 'POST', '/connectors', body);
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Connector;
  };

  const test = async (cookie: string, id: string) => {
    const res = await call(cookie, 'POST', `/connectors/${id}/test`);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { connector: Connector; tools: { name: string }[] };
  };

  const computerOf = async (email: string, workspaceId: string) => {
    const [row] = await t.db
      .select()
      .from(schema.computers)
      .where(
        and(
          eq(schema.computers.ownerId, await t.userId(email)),
          eq(schema.computers.workspaceId, workspaceId),
        ),
      );
    return row;
  };

  const agentOf = async (email: string, workspaceId: string) =>
    computers.agents.get((await computerOf(email, workspaceId))!.id)!;

  let aliceFs: Connector;
  let bobPg: Connector;
  let aliceFsB: Connector;

  it('defaults to the computer runner', () => {
    expect(t.deps.config.stdioRunner).toBe('computer');
  });

  it("starts the owner's computer and runs the catalog server there, rooted in their files", async () => {
    aliceFs = await create(alice, { catalogId: 'filesystem', params: { root: 'notes' } });
    expect(await computerOf('alice@example.com', orgA)).toBeUndefined();
    const { connector, tools } = await test(alice, aliceFs.id);
    expect(connector).toMatchObject({ status: 'ok', lastError: null });
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'grow', 'whoami']);

    // The start path made and started her computer for this organization.
    const computer = await computerOf('alice@example.com', orgA);
    expect(computer?.status).toBe('running');
    const agent = computers.agents.get(computer!.id)!;
    expect(agent.mcpStdio).toEqual([
      {
        type: 'start',
        command: '/opt/openbots/mcp/node_modules/.bin/mcp-server-filesystem',
        args: ['/home/bot/notes'],
        env: {},
        dirs: ['notes'],
      },
    ]);
    // The agent created the root under the computer's home.
    expect(statSync(join(agent.home, 'notes')).isDirectory()).toBe(true);
    const echo = await t.inOrganization(() =>
      mcpManager(t.ownerDeps).callTool(aliceFs.id, 'echo', {
        text: 'in the computer',
      }),
    );
    expect(textOf(echo)).toBe('in the computer');
  });

  it("passes a connector's secrets to its process in its owner's computer only", async () => {
    bobPg = await create(bob, {
      catalogId: 'postgres',
      // TEST-NET-3: public, as far as the private-host check is concerned.
      secrets: { POSTGRES_URL: 'postgresql://ro:sekrit-pg-pass@203.0.113.7:5432/app' },
    });
    expect((await test(bob, bobPg.id)).connector.status).toBe('ok');
    const bobAgent = await agentOf('bob@example.com', orgA);
    const aliceAgent = await agentOf('alice@example.com', orgA);
    expect(bobAgent).not.toBe(aliceAgent);
    expect(bobAgent.mcpStdio).toHaveLength(1);
    expect(bobAgent.mcpStdio[0]).toMatchObject({
      command: '/opt/openbots/mcp/node_modules/.bin/mcp-server-postgres',
      args: ['postgresql://ro@203.0.113.7:5432/app'],
      env: { PGPASSWORD: 'sekrit-pg-pass' },
    });
    const who = JSON.parse(
      textOf(
        await t.inOrganization(() => mcpManager(t.ownerDeps).callTool(bobPg.id, 'whoami', {})),
      ),
    ) as {
      env: string[];
    };
    expect(who.env).toContain('PGPASSWORD');
    // Alice's computer never saw Bob's server or its secret.
    expect(aliceAgent.mcpStdio).toHaveLength(1);
    expect(JSON.stringify(aliceAgent.mcpStdio)).not.toContain('sekrit');
  });

  it('gives the same owner in another organization another computer and process', async () => {
    await t.switchOrganization(alice, orgB);
    aliceFsB = await create(alice, { catalogId: 'filesystem', params: { root: 'notes' } });
    expect((await test(alice, aliceFsB.id)).connector.status).toBe('ok');
    const inA = await computerOf('alice@example.com', orgA);
    const inB = await computerOf('alice@example.com', orgB);
    expect(inB!.id).not.toBe(inA!.id);
    expect((await agentOf('alice@example.com', orgB)).mcpStdio).toHaveLength(1);
    expect((await agentOf('alice@example.com', orgA)).mcpStdio).toHaveLength(1);
    // Three connectors, three computers, three processes: none shared.
    expect(computers.agents.size).toBe(3);
    const manager = mcpManager(t.ownerDeps);
    for (const id of [aliceFs.id, bobPg.id, aliceFsB.id]) expect(manager.running(id)).toBe(true);
    await t.switchOrganization(alice, orgA);
  });

  it('counts a busy connector as use of the computer, so the idle sweep leaves it running', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const computer = (await computerOf('alice@example.com', orgA))!;
      const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
      await t.db
        .update(schema.computers)
        .set({ lastUsedAt: longAgo })
        .where(eq(schema.computers.id, computer.id));
      vi.setSystemTime(Date.now() + STDIO_TOUCH_MS + 1_000);
      await t.inOrganization(() =>
        mcpManager(t.ownerDeps).callTool(aliceFs.id, 'echo', { text: 'still here' }),
      );
      await vi.waitFor(async () => {
        const row = await computerOf('alice@example.com', orgA);
        expect(row!.lastUsedAt!.getTime()).toBeGreaterThan(longAgo.getTime());
      });
      expect(await inEveryOrganization(t.deps, () => sweepIdleComputers(t.deps, new Date()))).toBe(
        0,
      );
      expect((await computerOf('alice@example.com', orgA))!.status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the servers with their computer, and only those', async () => {
    const res = await call(alice, 'POST', '/computer/stop');
    expect(res.status, await res.clone().text()).toBe(200);
    const manager = mcpManager(t.ownerDeps);
    await vi.waitFor(() => expect(manager.running(aliceFs.id)).toBe(false));
    // Not restarted while the computer is off; the others run on.
    await new Promise((r) => setTimeout(r, 100));
    expect(manager.running(aliceFs.id)).toBe(false);
    expect(manager.restarting(aliceFs.id)).toBe(false);
    expect(manager.running(bobPg.id)).toBe(true);
    expect(manager.running(aliceFsB.id)).toBe(true);
    // The next use starts the computer, and the server, again.
    const echo = await t.inOrganization(() =>
      mcpManager(t.ownerDeps).callTool(aliceFs.id, 'echo', { text: 'back' }),
    );
    expect(textOf(echo)).toBe('back');
    expect((await computerOf('alice@example.com', orgA))!.status).toBe('running');
  });

  it('reports a clear error when the computer does not start', async () => {
    const failing: ComputerProvider = {
      ...computers.provider,
      start: async () => {
        throw new Error('no capacity left');
      },
    };
    setComputerProvider(t.ownerDeps, failing);
    try {
      const fs = await create(carol, { catalogId: 'filesystem', params: { root: '' } });
      const { connector } = await test(carol, fs.id);
      expect(connector.status).toBe('error');
      expect(connector.lastError).toBe('The computer did not start: no capacity left');
    } finally {
      setComputerProvider(t.ownerDeps, computers.provider);
    }
  });

  it('reports a clear error when there is no computer, never running it on the server', async () => {
    setComputerProvider(t.ownerDeps, null);
    try {
      const fs = await create(carol, { catalogId: 'filesystem', params: { root: 'docs' } });
      const { connector } = await test(carol, fs.id);
      expect(connector).toMatchObject({ status: 'error', lastError: NO_COMPUTER });
      expect(mcpManager(t.ownerDeps).running(fs.id)).toBe(false);
    } finally {
      setComputerProvider(t.ownerDeps, computers.provider);
    }
  });
});

describe('stdio connectors on a self-hosted install', () => {
  let t: TestApp;
  let computers: ReturnType<typeof useComputers>;
  let mcpDir: string;

  beforeAll(async () => {
    // A catalog install whose filesystem binary is the test server.
    mcpDir = mkdtempSync(join(tmpdir(), 'openbots-mcp-install-'));
    mkdirSync(join(mcpDir, 'node_modules', '.bin'), { recursive: true });
    const bin = join(mcpDir, 'node_modules', '.bin', 'mcp-server-filesystem');
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${TEST_STDIO_SERVER}"\n`);
    chmodSync(bin, 0o755);
    t = await createTestApp({ OPENBOTS_MCP_DIR: mcpDir });
    computers = useComputers(t.ownerDeps);
  });
  afterAll(async () => {
    await closeMcpManager(t.ownerDeps);
    await computers.close();
    await t.close();
    rmSync(mcpDir, { recursive: true, force: true });
  });

  it('runs them on the host by default, even with a computer available', async () => {
    expect(t.deps.config.stdioRunner).toBe('host');
    const owner = (await t.signUp('owner@example.com')).cookie!;
    const res = await t.app.request('/api/v1/connectors', {
      method: 'POST',
      headers: { cookie: owner, 'content-type': 'application/json' },
      body: JSON.stringify({ catalogId: 'filesystem', params: { root: 'notes' } }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { id } = (await res.json()) as Connector;
    const tested = await t.app.request(`/api/v1/connectors/${id}/test`, {
      method: 'POST',
      headers: { cookie: owner },
    });
    expect(((await tested.json()) as { connector: Connector }).connector).toMatchObject({
      status: 'ok',
      lastError: null,
    });
    // No computer was made, let alone asked to run it.
    expect(computers.agents.size).toBe(0);
    expect(await t.db.select().from(schema.computers)).toEqual([]);
  });
});
