import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDockerRequest, createDockerGuard, imageRef } from './docker-guard.js';
import {
  containerName,
  containerSpec,
  createDockerProvider,
  BRIDGE_NAME_OPTION,
  GUARD_NAME,
  ICC_OPTION,
  MANAGED_LABEL,
  networkSpec,
  stateVolumeName,
  verifyGuard,
} from './docker.js';
import { STATE_DIR } from './types.js';
import { readTokenArchive, tokenArchive } from './token-archive.js';
import { mockDocker, startFakeAgent, type FakeAgent } from './testing.js';
import type { ComputerSpec } from './types.js';

const IMAGE = 'ghcr.io/openbots/computer:latest';
const policy = { image: IMAGE };

const spec: ComputerSpec = {
  computerId: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
  image: IMAGE,
  agentToken: 'secret-agent-token',
  volumeName: 'openbots-home-11111111-1111-4111-8111-111111111111',
};
const NAME = containerName(spec.computerId);

/** The create body as plain JSON, typed loosely enough for each case to bend one field. */
type Body = {
  [key: string]: unknown;
  Env: string[];
  Labels: Record<string, string>;
  HostConfig: Record<string, unknown> & {
    Mounts: Record<string, unknown>[];
    SecurityOpt: string[];
  };
  NetworkingConfig: { EndpointsConfig: Record<string, Record<string, unknown>> };
};

/** The create body exactly as dockerode sends it: the options, `name` included. */
const createBody = (change: (body: Body) => void = () => {}) => {
  const body = JSON.parse(JSON.stringify(containerSpec(spec))) as Body;
  change(body);
  return JSON.stringify(body);
};

const create = (body: string, url = `/containers/create?name=${NAME}`) =>
  checkDockerRequest({ method: 'POST', url, body }, policy);

describe('docker guard: containers/create (S-2)', () => {
  it('allows the container the provider creates', () => {
    const decision = create(createBody());
    expect(decision).toMatchObject({ allow: true, url: `/containers/create?name=${NAME}` });
    // `name` goes in the query; the forwarded body is the checked object.
    const forwarded = JSON.parse((decision as { body: string }).body);
    expect(forwarded.name).toBeUndefined();
    expect(forwarded.Image).toBe(IMAGE);
  });

  it('allows the egress proxy and timezone the provider sets (plan 9.5)', () => {
    const body = JSON.stringify(
      containerSpec({
        ...spec,
        egressProxy: 'http://172.30.255.3:8888',
        noProxy: 'localhost',
        timezone: 'Europe/Paris',
      }),
    );
    expect(create(body)).toMatchObject({ allow: true });
  });

  it('keeps the API version prefix and drops query parameters it did not check', () => {
    const decision = create(
      createBody(),
      `/v1.47/containers/create?name=${NAME}&HostConfig=%7B%7D&Image=x`,
    );
    expect(decision).toMatchObject({ allow: true, url: `/v1.47/containers/create?name=${NAME}` });
  });

  it.each([
    ['another image', (b: Body) => (b.Image = 'alpine:latest')],
    ['Privileged', (b: Body) => (b.HostConfig.Privileged = true)],
    ['a host bind', (b: Body) => (b.HostConfig.Binds = ['/:/host'])],
    [
      'a bind mount',
      (b: Body) => b.HostConfig.Mounts.push({ Type: 'bind', Source: '/', Target: '/host' }),
    ],
    [
      'the Docker socket as a volume',
      (b: Body) => (b.HostConfig.Mounts[0]!.Source = '/var/run/docker.sock'),
    ],
    ['a mount elsewhere', (b: Body) => (b.HostConfig.Mounts[0]!.Target = '/etc')],
    ['host networking', (b: Body) => (b.HostConfig.NetworkMode = 'host')],
    [
      "another container's network",
      (b: Body) => (b.HostConfig.NetworkMode = 'container:openbots-openbots-1'),
    ],
    ['the default network', (b: Body) => (b.HostConfig.NetworkMode = 'openbots_default')],
    ['host PID', (b: Body) => (b.HostConfig.PidMode = 'host')],
    ['host IPC', (b: Body) => (b.HostConfig.IpcMode = 'host')],
    ['host user namespace', (b: Body) => (b.HostConfig.UsernsMode = 'host')],
    ['an added capability', (b: Body) => (b.HostConfig.CapAdd = ['SYS_ADMIN'])],
    [
      'DAC_OVERRIDE besides the user-switching caps',
      (b: Body) => (b.HostConfig.CapAdd = ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE']),
    ],
    ['the agent token in the environment', (b: Body) => b.Env.push('OPENBOTS_AGENT_TOKEN=x')],
    [
      "another computer's state volume",
      (b: Body) => (b.HostConfig.Mounts[1]!.Source = stateVolumeName('someone-else')),
    ],
    ['the state volume at the home', (b: Body) => (b.HostConfig.Mounts[1]!.Target = '/home/bot')],
    [
      'a home volume at the state directory',
      (b: Body) => (b.HostConfig.Mounts[0]!.Target = STATE_DIR),
    ],
    ['capabilities kept', (b: Body) => (b.HostConfig.CapDrop = ['NET_RAW'])],
    ['no cap drop', (b: Body) => delete b.HostConfig.CapDrop],
    ['unconfined seccomp', (b: Body) => b.HostConfig.SecurityOpt.push('seccomp=unconfined')],
    ['no no-new-privileges', (b: Body) => (b.HostConfig.SecurityOpt = [])],
    ['a writable root', (b: Body) => (b.HostConfig.ReadonlyRootfs = false)],
    ['devices', (b: Body) => (b.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }])],
    ['sysctls', (b: Body) => (b.HostConfig.Sysctls = { 'net.ipv4.ip_forward': '1' })],
    [
      'a published port',
      (b: Body) => (b.HostConfig.PortBindings = { '7070/tcp': [{ HostPort: '7070' }] }),
    ],
    ['all ports published', (b: Body) => (b.HostConfig.PublishAllPorts = true)],
    ['no memory limit', (b: Body) => delete b.HostConfig.Memory],
    ['no PID limit', (b: Body) => (b.HostConfig.PidsLimit = 0)],
    ['root', (b: Body) => (b.User = 'root')],
    ['an entrypoint', (b: Body) => (b.Entrypoint = ['/bin/sh'])],
    ['a server secret in the environment', (b: Body) => b.Env.push('DATABASE_URL=postgres://x')],
    ['LD_PRELOAD', (b: Body) => b.Env.push('LD_PRELOAD=/tmp/x.so')],
    // Not one of the egress proxy variables the provider sets (plan 9.5).
    ['ALL_PROXY', (b: Body) => b.Env.push('ALL_PROXY=socks5://10.0.0.1:1080')],
    ['no computer label', (b: Body) => delete b.Labels[MANAGED_LABEL]],
    ['a second network', (b: Body) => (b.NetworkingConfig.EndpointsConfig.openbots_default = {})],
    [
      'a fixed address',
      (b: Body) =>
        (b.NetworkingConfig.EndpointsConfig['openbots-sbx']!.IPAMConfig = {
          IPv4Address: '172.30.255.2',
        }),
    ],
    // Go's JSON decoder matches keys case-insensitively, so `privileged`
    // would reach the daemon as Privileged.
    ['a lower-case key', (b: Body) => (b.HostConfig.privileged = true)],
    ['a lower-case top-level key', (b: Body) => (b.hostconfig = { Privileged: true })],
    ['no HostConfig', (b: Body) => Reflect.deleteProperty(b, 'HostConfig')],
  ])('refuses %s', (_what, change) => {
    expect(create(createBody(change))).toMatchObject({ allow: false });
  });

  it('refuses a body that is not a JSON object, and a container without a computer name', () => {
    expect(create('not json')).toMatchObject({ allow: false, reason: 'the body is not JSON' });
    expect(create('[]')).toMatchObject({ allow: false });
    expect(create(createBody(), '/containers/create')).toMatchObject({ allow: false });
    expect(create(createBody(), '/containers/create?name=postgres')).toMatchObject({
      allow: false,
    });
  });

  it('forwards what it checked when a key appears twice', () => {
    // The daemon would merge both HostConfig objects; JSON.parse keeps the last.
    const valid = createBody();
    const twice = valid.replace('"HostConfig":', '"HostConfig":{"Privileged":true},"HostConfig":');
    const decision = create(twice);
    expect(decision.allow).toBe(true);
    const body = (decision as { body: string }).body;
    expect(body).not.toContain('Privileged":true');
    expect(body.match(/"HostConfig"/g)).toHaveLength(1);
  });
});

describe('docker guard: other operations', () => {
  const check = (method: string, url: string, body?: unknown) =>
    checkDockerRequest(
      { method, url, body: body === undefined ? undefined : JSON.stringify(body) },
      policy,
    );

  it('allows pulling and inspecting the sandbox image only', () => {
    expect(check('POST', '/images/create?fromImage=ghcr.io/openbots/computer&tag=latest')).toEqual({
      allow: true,
      url: '/images/create?fromImage=ghcr.io%2Fopenbots%2Fcomputer&tag=latest',
    });
    expect(check('GET', `/images/${IMAGE}/json`).allow).toBe(true);
    expect(check('POST', '/images/create?fromImage=alpine&tag=latest').allow).toBe(false);
    expect(check('POST', '/images/create?fromSrc=http://evil/x.tar&repo=x').allow).toBe(false);
    expect(check('GET', '/images/alpine/json').allow).toBe(false);
    expect(check('DELETE', `/images/${IMAGE}`).allow).toBe(false);
  });

  it('compares image references by name and tag', () => {
    expect(imageRef('ghcr.io/openbots/computer')).toBe(IMAGE);
    expect(imageRef('localhost:5000/computer')).toBe('localhost:5000/computer:latest');
    const pinned = 'ghcr.io/openbots/computer@sha256:abc';
    expect(
      checkDockerRequest(
        {
          method: 'POST',
          url: '/images/create?fromImage=ghcr.io/openbots/computer&tag=sha256:abc',
        },
        { image: pinned },
      ).allow,
    ).toBe(true);
  });

  it('creates the sandbox network only with icc off', () => {
    expect(check('POST', '/networks/create', networkSpec())).toMatchObject({ allow: true });
    const { Options: _options, ...noIcc } = networkSpec();
    expect(check('POST', '/networks/create', noIcc).allow).toBe(false);
    expect(check('POST', '/networks/create', { ...networkSpec(), Name: 'other' }).allow).toBe(
      false,
    );
    expect(check('POST', '/networks/create', { ...networkSpec(), Driver: 'host' }).allow).toBe(
      false,
    );
    expect(check('GET', '/networks/openbots-sbx').allow).toBe(true);
    expect(check('GET', '/networks/openbots_default').allow).toBe(false);
    expect(check('POST', '/networks/openbots_default/connect', { Container: NAME }).allow).toBe(
      false,
    );
  });

  it('creates state volumes as it does home volumes', () => {
    const volume = { Name: stateVolumeName(spec.computerId), Labels: {} };
    expect(check('POST', '/volumes/create', volume)).toMatchObject({ allow: true });
    expect(check('GET', `/volumes/${volume.Name}`).allow).toBe(true);
    expect(check('POST', '/volumes/create', { ...volume, Name: 'openbots-statefoo' }).allow).toBe(
      false,
    );
  });

  it('puts only the agent token archive into a container, only into the state directory (S-7)', () => {
    const archive = tokenArchive('a'.repeat(43)).toString('utf8');
    const put = (url: string, body: string) =>
      checkDockerRequest({ method: 'PUT', url, body }, policy);
    const decision = put(
      `/v1.47/containers/${NAME}/archive?path=${STATE_DIR}&copyUIDGID=1`,
      archive,
    );
    expect(decision).toMatchObject({
      allow: true,
      url: `/v1.47/containers/${NAME}/archive?path=%2Fvar%2Flib%2Fopenbots`,
      contentType: 'application/x-tar',
      container: NAME,
    });
    expect(readTokenArchive((decision as { body: Buffer }).body)).toBe('a'.repeat(43));

    expect(put(`/containers/${NAME}/archive?path=/home/bot`, archive).allow).toBe(false);
    expect(put(`/containers/${NAME}/archive?path=/var/lib/openbots/screens`, archive).allow).toBe(
      false,
    );
    expect(put(`/containers/${NAME}/archive`, archive).allow).toBe(false);
    // Any other tar: another name, another mode or owner, a second entry, a link.
    const bent = (at: number, text: string) => {
      const b = tokenArchive('a'.repeat(43));
      b.write(text, at, 'ascii');
      return b.toString('utf8');
    };
    for (const body of [
      bent(0, 'profile'),
      bent(100, '0000644'),
      bent(108, '0001000'),
      bent(156, '2'),
      tokenArchive('a'.repeat(43)).toString('utf8') + '\0'.repeat(512),
      tokenArchive('a'.repeat(43)).toString('utf8').slice(0, 1024),
      'not a tar',
    ]) {
      expect(put(`/containers/${NAME}/archive?path=${STATE_DIR}`, body)).toMatchObject({
        allow: false,
        reason: 'the archive is not the agent token',
      });
    }
  });

  it('creates home volumes only on the local driver with no options', () => {
    const volume = { Name: spec.volumeName, Labels: { [MANAGED_LABEL]: spec.computerId } };
    expect(check('POST', '/volumes/create', volume)).toMatchObject({ allow: true });
    const hostPath = { ...volume, DriverOpts: { type: 'none', o: 'bind', device: '/' } };
    expect(check('POST', '/volumes/create', hostPath).allow).toBe(false);
    expect(check('POST', '/volumes/create', { ...volume, Name: 'pgdata' }).allow).toBe(false);
    expect(check('POST', '/volumes/create', { ...volume, Driver: 'nfs' }).allow).toBe(false);
    expect(check('GET', `/volumes/${spec.volumeName}`).allow).toBe(true);
    expect(check('GET', '/volumes/openbots_pgdata').allow).toBe(false);
  });

  it('acts on containers only after checking they are computers', () => {
    expect(check('POST', `/containers/${NAME}/start`)).toEqual({
      allow: true,
      url: `/containers/${NAME}/start`,
      container: NAME,
    });
    expect(check('POST', '/containers/abc123/stop?t=10')).toMatchObject({
      url: '/containers/abc123/stop?t=10',
    });
    expect(check('DELETE', '/containers/abc123?force=true&v=false')).toMatchObject({
      url: '/containers/abc123?force=true&v=false',
      container: 'abc123',
    });
    expect(check('GET', '/containers/abc123/json')).toMatchObject({ container: 'abc123' });
  });

  it('drops a body sent with start', () => {
    // Old API versions took a HostConfig on start.
    const decision = check('POST', '/containers/abc123/start', {
      HostConfig: { Privileged: true },
    });
    expect(decision).toMatchObject({ allow: true });
    expect((decision as { body?: string }).body).toBeUndefined();
  });

  it.each([
    ['POST', '/containers/abc123/exec'],
    ['POST', '/exec/abc123/start'],
    ['PUT', '/containers/abc123/archive?path=/'],
    ['GET', '/containers/abc123/archive?path=/'],
    ['POST', '/containers/abc123/update'],
    ['POST', '/containers/abc123/rename?name=x'],
    ['POST', '/containers/abc123/attach'],
    ['GET', '/containers/json'],
    ['POST', '/build'],
    ['POST', '/commit?container=abc123'],
    ['POST', '/plugins/pull'],
    ['GET', '/secrets'],
    ['POST', '/swarm/init'],
    ['GET', '/containers/abc123/../../build'],
    ['GET', '/containers//abc123/json'],
    ['GET', '/containers/abc%2F..%2Fx/json'],
    ['GET', 'containers/abc123/json'],
  ])('refuses %s %s', (method, url) => {
    expect(check(method, url).allow).toBe(false);
  });
});

/** A stand-in for the socket proxy that records what reached it. */
async function fakeUpstream() {
  const seen: { method: string; url: string; body: string }[] = [];
  const containers = new Map<string, Record<string, string>>([
    ['openbots-postgres-1', { 'com.docker.compose.service': 'postgres' }],
  ]);
  const running = new Set<string>(['openbots-postgres-1']);
  const archives: { type: string | undefined; body: Buffer }[] = [];
  let created = 0;
  const server = createServer((req, res) => {
    let body = '';
    const raw: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      raw.push(chunk);
    });
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, body });
      const json = (status: number, value: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      const path = req.url!.split('?')[0]!;
      const id = /^\/containers\/([^/]+)/.exec(path)?.[1];
      if (req.method === 'POST' && path === '/containers/create') {
        const name = new URL(req.url!, 'http://x').searchParams.get('name')!;
        containers.set(name, (JSON.parse(body) as { Labels: Record<string, string> }).Labels);
        created++;
        return json(201, { Id: name });
      }
      if (req.method === 'POST' && path === '/images/create') return json(200, { status: 'done' });
      if (path.startsWith('/images/') || path.startsWith('/volumes/')) {
        return req.method === 'GET' ? json(404, { message: 'no such object' }) : json(201, {});
      }
      if (path.startsWith('/networks/')) return json(200, {});
      if (id && !containers.has(id)) return json(404, { message: `No such container: ${id}` });
      if (id && path.endsWith('/json')) {
        return json(200, {
          Config: { Labels: containers.get(id) },
          State: { Running: running.has(id) },
        });
      }
      if (id && path.endsWith('/start')) running.add(id);
      if (id && path.endsWith('/archive')) {
        archives.push({ type: req.headers['content-type'], body: Buffer.concat(raw) });
        return res.writeHead(200).end();
      }
      if (id && req.method === 'DELETE') containers.delete(id);
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, seen, archives, url: `tcp://127.0.0.1:${port}`, created: () => created };
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `tcp://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('docker guard: a configured sandbox network (OPENBOTS_SANDBOX_NETWORK)', () => {
  const network = { name: 'openbots-app-sandbox-254', bridge: 'openbots-a-254' };
  const own = { image: IMAGE, network };
  const check = (method: string, url: string, body?: unknown) =>
    checkDockerRequest(
      { method, url, body: body === undefined ? undefined : JSON.stringify(body) },
      own,
    );
  const onNetwork = (name: string) =>
    JSON.stringify(containerSpec(spec, { network: name }) as unknown);

  it('allows the computer on the configured network', () => {
    const url = `/containers/create?name=${NAME}`;
    expect(
      checkDockerRequest({ method: 'POST', url, body: onNetwork(network.name) }, own),
    ).toMatchObject({ allow: true });
  });

  it('refuses the default network, and any other, once another is configured', () => {
    const url = `/containers/create?name=${NAME}`;
    for (const other of ['openbots-sbx', 'openbots_default', 'openbots-app_default']) {
      expect(checkDockerRequest({ method: 'POST', url, body: onNetwork(other) }, own)).toEqual({
        allow: false,
        reason: `the container must be on ${network.name}`,
      });
    }
    // The right network mode, but a second endpoint on the default network.
    const body = JSON.parse(onNetwork(network.name)) as Body;
    body.NetworkingConfig.EndpointsConfig['openbots-sbx'] = {};
    expect(checkDockerRequest({ method: 'POST', url, body: JSON.stringify(body) }, own).allow).toBe(
      false,
    );
    expect(check('GET', '/networks/openbots-sbx').allow).toBe(false);
    expect(check('GET', `/networks/${network.name}`).allow).toBe(true);
  });

  it('creates the configured network only with its own bridge name and icc off', () => {
    expect(check('POST', '/networks/create', networkSpec(network))).toMatchObject({
      allow: true,
    });
    // The default network, or the configured one on another stack's bridge.
    expect(check('POST', '/networks/create', networkSpec()).allow).toBe(false);
    const made = networkSpec(network);
    for (const bridge of ['openbots-sbx', 'docker0', 'eth0']) {
      expect(
        check('POST', '/networks/create', {
          ...made,
          Options: { ...made.Options, [BRIDGE_NAME_OPTION]: bridge },
        }).allow,
      ).toBe(false);
    }
    expect(
      check('POST', '/networks/create', {
        ...made,
        Options: { ...made.Options, [ICC_OPTION]: 'true' },
      }).allow,
    ).toBe(false);
  });

  it('keeps refusing the configured bridge to the default policy', () => {
    expect(
      checkDockerRequest(
        { method: 'POST', url: '/networks/create', body: JSON.stringify(networkSpec(network)) },
        policy,
      ).allow,
    ).toBe(false);
  });
});

describe('docker guard over HTTP', () => {
  const servers: Server[] = [];
  let agent: FakeAgent | undefined;
  afterEach(async () => {
    await agent?.close();
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function setup() {
    const upstream = await fakeUpstream();
    const refused: string[] = [];
    const guard = createDockerGuard({
      upstream: upstream.url,
      policy,
      onRefuse: (_request, reason) => refused.push(reason),
    });
    servers.push(upstream.server, guard);
    const guardUrl = await listen(guard);
    return { upstream, refused, guardUrl, http: guardUrl.replace('tcp:', 'http:') };
  }

  it('carries the docker provider through create, start, status and destroy', async () => {
    const { upstream, refused, guardUrl } = await setup();
    agent = await startFakeAgent({ token: spec.agentToken });
    const provider = createDockerProvider({
      dockerHost: guardUrl,
      agentUrl: () => agent!.url,
      pollMs: 5,
    });
    const ref = await provider.create(spec);
    await provider.start(ref);
    expect(await provider.status(ref)).toBe('running');
    await provider.destroy(ref);
    expect(refused).toEqual([]);
    expect(upstream.created()).toBe(1);
    const sent = upstream.seen.find((r) => r.url.startsWith('/containers/create'))!;
    expect(sent.url).toBe(`/containers/create?name=${NAME}`);
    expect(JSON.parse(sent.body).HostConfig.Privileged).toBe(false);
    // The token went in as a file before the start, through the guard (S-7).
    expect(upstream.archives).toHaveLength(1);
    expect(upstream.archives[0]!.type).toBe('application/x-tar');
    expect(readTokenArchive(upstream.archives[0]!.body)).toBe(spec.agentToken);
    const put = upstream.seen.findIndex((r) => r.method === 'PUT');
    expect(upstream.seen[put]!.url).toBe(
      `/containers/${NAME}/archive?path=%2Fvar%2Flib%2Fopenbots`,
    );
    expect(put).toBeLessThan(upstream.seen.findIndex((r) => r.url.endsWith('/start')));
  });

  it('answers 403 and forwards nothing for a refused create', async () => {
    const { upstream, refused, http } = await setup();
    const res = await fetch(`${http}/containers/create?name=${NAME}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: createBody((b) => (b.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock'])),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toMatch(/Binds/);
    expect(refused).toHaveLength(1);
    expect(upstream.seen).toEqual([]);
  });

  it('refuses to act on a container the provider did not create', async () => {
    const { upstream, http } = await setup();
    const res = await fetch(`${http}/containers/openbots-postgres-1/stop`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(upstream.seen.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /containers/openbots-postgres-1/json',
    ]);
    expect((await fetch(`${http}/containers/missing/start`, { method: 'POST' })).status).toBe(404);
  });

  it('refuses compressed bodies, which it could not check', async () => {
    const { upstream, http } = await setup();
    const res = await fetch(`${http}/volumes/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: 'x',
    });
    expect(res.status).toBe(403);
    expect(upstream.seen).toEqual([]);
  });

  it('identifies itself, and the provider refuses a Docker API that does not', async () => {
    const { http, guardUrl } = await setup();
    expect(await (await fetch(`${http}/_openbots/guard`)).json()).toMatchObject({
      guard: GUARD_NAME,
      image: IMAGE,
    });
    const viaGuard = createDockerProvider({ dockerHost: guardUrl });
    await expect(viaGuard.prepareImage!(IMAGE)).resolves.toBeUndefined();

    // The socket proxy itself, or a daemon: no guard answer.
    const raw = await fakeUpstream();
    servers.push(raw.server);
    const direct = createDockerProvider({ dockerHost: raw.url });
    await expect(direct.create(spec)).rejects.toThrow(/not the OpenBots docker guard/);
    expect(raw.seen.map((r) => r.url)).toEqual(['/_openbots/guard']);

    const unguarded = mockDocker();
    unguarded.guarded = false;
    await expect(verifyGuard(unguarded)).rejects.toThrow(/docker-guard/);
    await expect(createDockerProvider({ docker: unguarded }).create(spec)).rejects.toThrow();
    expect(unguarded.calls).toEqual([]);
  });
});
