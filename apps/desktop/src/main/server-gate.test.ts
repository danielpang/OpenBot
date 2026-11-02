import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerProfile } from '../ipc.js';
import type { StackStatus } from '../stack/manager.js';
import { nodePortFree } from '../stack/port.js';
import { fakeFetch, openBotsServer, type Answer } from './fake-fetch.js';
import {
  createServerGate,
  FRESH_MS,
  LOCAL_NOT_READY,
  LOCAL_STOPPED,
  NOT_OPENBOTS_SERVER,
  verifyServer,
  type Verdict,
} from './server-gate.js';

const LOCAL = 'http://localhost:3000';
const SELF = 'https://openbots.example.com';
const local: ServerProfile = { id: 'local', name: 'This Mac', url: LOCAL, kind: 'local' };
const remote: ServerProfile = { id: 'a', name: 'Work', url: SELF, kind: 'remote' };

/** A web page that is not OpenBots: every path answers with HTML. */
function website(url: string): Record<string, Answer> {
  return {
    [`${url}/`]: { status: 200 },
    [`${url}/healthz`]: { status: 404 },
    [`${url}/api/v1/setup`]: { status: 404 },
  };
}

const ready = {
  state: 'ready' as const,
  cli: 'docker',
  runtime: 'orbstack' as const,
  serverVersion: '27',
  composeVersion: '2.30',
};
const running: StackStatus = {
  docker: ready,
  services: [
    { service: 'openbots', state: 'running', health: 'healthy' },
    { service: 'postgres', state: 'running', health: 'healthy' },
  ],
  upgrade: null,
  port: { port: 3000, taken: false, free: null },
};
const stopped: StackStatus = { ...running, services: [] };
const taken: StackStatus = { ...stopped, port: { port: 3000, taken: true, free: 3001 } };

function verify(profile: ServerProfile, routes: Record<string, Answer>, status?: StackStatus) {
  return verifyServer(profile, {
    fetch: fakeFetch(routes),
    stack: status ? { status: async () => status } : null,
  });
}

describe('verifyServer for a self-hosted server or an account', () => {
  it('passes an OpenBots server, with whether it needs its setup', async () => {
    await expect(verify(remote, openBotsServer(SELF, true))).resolves.toEqual({
      ok: true,
      setupRequired: true,
    });
  });

  it('refuses an address where something else answers', async () => {
    await expect(verify(remote, website(SELF))).resolves.toEqual({
      ok: false,
      reason: 'not-openbots',
      message: 'This address does not answer as an OpenBots server.',
    });
    // A page that answers /healthz but has no setup route is not one either.
    await expect(
      verify(remote, {
        [`${SELF}/healthz`]: { status: 200, body: { status: 'ok' } },
        [`${SELF}/api/v1/setup`]: { status: 200, body: { setupRequired: 'no' } },
      }),
    ).resolves.toMatchObject({ ok: false, message: NOT_OPENBOTS_SERVER });
  });

  it('says when nothing answers', async () => {
    await expect(verify(remote, {})).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
      message:
        'Could not reach openbots.example.com. Check the address, and that the server is running.',
    });
  });
});

describe('verifyServer for This Mac', () => {
  it("passes the app's own stack when its server is healthy and answers as OpenBots", async () => {
    await expect(verify(local, openBotsServer(LOCAL), running)).resolves.toEqual({
      ok: true,
      setupRequired: false,
    });
  });

  it('refuses another app on the stack port, with the port in the sentence', async () => {
    const port = {
      ok: false,
      reason: 'port-taken',
      message: 'Port 3000 on this Mac is used by another app, not OpenBots.',
    };
    await expect(verify(local, website(LOCAL), taken)).resolves.toEqual(port);
    // Even an OpenBots server there is not this app's stack (a source checkout, say).
    await expect(verify(local, openBotsServer(LOCAL), taken)).resolves.toEqual(port);
    // The stack runs, yet something else answers at its address.
    await expect(verify(local, website(LOCAL), running)).resolves.toEqual(port);
  });

  it('sends a stopped stack to the start page', async () => {
    await expect(verify(local, {}, stopped)).resolves.toEqual({
      ok: false,
      reason: 'stopped',
      message: LOCAL_STOPPED,
    });
    const starting: StackStatus = {
      ...running,
      services: [{ service: 'openbots', state: 'running', health: 'starting' }],
    };
    await expect(verify(local, openBotsServer(LOCAL), starting)).resolves.toEqual({
      ok: false,
      reason: 'stopped',
      message: LOCAL_NOT_READY,
    });
    const noDocker: StackStatus = {
      docker: { state: 'stopped', cli: 'docker', installed: ['orbstack'], error: '' },
      services: [],
      upgrade: null,
      port: { port: 3000, taken: false, free: null },
    };
    await expect(verify(local, {}, noDocker)).resolves.toMatchObject({ reason: 'stopped' });
  });

  it('asks the port itself when Docker could not be asked', async () => {
    const failing = (routes: Record<string, Answer>) =>
      verifyServer(local, {
        fetch: fakeFetch(routes),
        stack: { status: async () => Promise.reject(new Error('docker hung')) },
      });
    await expect(failing(website(LOCAL))).resolves.toMatchObject({ reason: 'port-taken' });
    await expect(failing({})).resolves.toMatchObject({ reason: 'stopped' });
  });

  it('checks only the address of a development server', async () => {
    const dev = { ...local, url: 'http://localhost:5174' };
    await expect(verify(dev, openBotsServer(dev.url))).resolves.toMatchObject({ ok: true });
    await expect(verify(dev, website(dev.url))).resolves.toMatchObject({ reason: 'not-openbots' });
  });
});

describe('createServerGate', () => {
  const pass: Verdict = { ok: true, setupRequired: false };
  const refusal: Verdict = { ok: false, reason: 'not-openbots', message: NOT_OPENBOTS_SERVER };

  function setup(verdicts: Verdict[]) {
    let time = 0;
    const verify = vi.fn(async () => verdicts.shift() ?? pass);
    const gate = createServerGate({ verify, now: () => time });
    return { gate, verify, advance: (ms: number) => void (time += ms) };
  }

  it('lets the load right after a pass through, and checks a later one again', async () => {
    const { gate, verify, advance } = setup([pass, refusal]);
    await gate.verify(remote);
    await expect(gate.admit(remote, `${SELF}/sign-in`)).resolves.toBeNull();
    expect(verify).toHaveBeenCalledTimes(1);
    // A reload a while later, once something else took the address.
    advance(FRESH_MS);
    await expect(gate.admit(remote, `${SELF}/`)).resolves.toEqual(refusal);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('checks a load that no pass came before', async () => {
    const { gate, verify } = setup([refusal]);
    await expect(gate.admit(remote, `${SELF}/`)).resolves.toEqual(refusal);
    expect(verify).toHaveBeenCalledWith(remote);
  });

  it('forgets a pass once a check fails, and when the address changed', async () => {
    const { gate, verify } = setup([pass, refusal, refusal]);
    await gate.verify(local);
    await gate.verify(local);
    await expect(gate.admit(local, `${LOCAL}/`)).resolves.toEqual(refusal);
    // The stack moved to another port: a pass at the old one does not count.
    const moved = { ...local, url: 'http://localhost:3001' };
    const fresh = setup([pass, refusal]);
    await fresh.gate.verify(local);
    await expect(fresh.gate.admit(moved, 'http://localhost:3001/')).resolves.toEqual(refusal);
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it("leaves pages off the server's origin to the navigation guard", async () => {
    const { gate, verify } = setup([refusal]);
    await expect(
      gate.admit(remote, 'https://github.com/login/oauth/authorize'),
    ).resolves.toBeNull();
    await expect(gate.admit(remote, 'file:///app/renderer/index.html')).resolves.toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it('shares one check between loads that ask together', async () => {
    const { gate, verify } = setup([pass]);
    await Promise.all([gate.admit(remote, `${SELF}/`), gate.verify(remote)]);
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe('verifyServer over HTTP', () => {
  let server: Server | undefined;
  afterEach(
    () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
  );

  /** A real server on a free port: `pages` answers each path, with its status and type. */
  function serve(pages: (path: string) => { status: number; type: string; body: string }) {
    return new Promise<string>((resolve) => {
      server = createServer((request, response) => {
        const page = pages(request.url ?? '/');
        response.writeHead(page.status, { 'content-type': page.type }).end(page.body);
      });
      server.listen({ port: 0, host: '127.0.0.1' }, () => {
        const address = server!.address();
        resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`);
      });
    });
  }
  const html = { type: 'text/html', body: '<!doctype html><title>bento-www</title>' };
  const fetch = (url: string, init?: RequestInit) => globalThis.fetch(url, init);

  it("refuses a Next.js dev server on the stack's port", async () => {
    // Next answers its pages and a 404 page for the rest; a catch-all answers 200 everywhere.
    for (const pages of [
      (path: string) => ({ ...html, status: path === '/' ? 200 : 404 }),
      () => ({ ...html, status: 200 }),
    ]) {
      const url = await serve(pages);
      const port = Number(new URL(url).port);
      const status: StackStatus = {
        ...stopped,
        port: { port, taken: !(await nodePortFree(port)), free: null },
      };
      const profile = { ...local, url };
      await expect(
        verifyServer(profile, { fetch, stack: { status: async () => status } }),
      ).resolves.toEqual({
        ok: false,
        reason: 'port-taken',
        message: `Port ${port} on this Mac is used by another app, not OpenBots.`,
      });
      await expect(verifyServer({ ...remote, url }, { fetch, stack: null })).resolves.toMatchObject(
        { reason: 'not-openbots' },
      );
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('passes a server that answers as OpenBots', async () => {
    const json = (body: unknown) => ({
      status: 200,
      type: 'application/json',
      body: JSON.stringify(body),
    });
    const url = await serve((path) =>
      path === '/healthz'
        ? json({ status: 'ok' })
        : path === '/api/v1/setup'
          ? json({ setupRequired: true })
          : { ...html, status: 200 },
    );
    await expect(verifyServer({ ...remote, url }, { fetch, stack: null })).resolves.toEqual({
      ok: true,
      setupRequired: true,
    });
  });
});
