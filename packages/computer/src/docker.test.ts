import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  AGENT_PORT,
  BRIDGE_NAME_OPTION,
  containerName,
  containerSpec,
  createDockerProvider,
  DEFAULT_SANDBOX_NETWORK,
  dockerFromHost,
  ICC_OPTION,
  isBridgeName,
  networkSpec,
  resolveSandboxNetwork,
  SANDBOX_BRIDGE,
  SANDBOX_ENV_NAMES,
  SANDBOX_NETWORK,
  stateVolumeName,
} from './docker.js';
import { STATE_DIR } from './types.js';
import { readTokenArchive } from './token-archive.js';
import { mockDocker, startFakeAgent, type FakeAgent } from './testing.js';
import type { ComputerSpec } from './types.js';

const spec: ComputerSpec = {
  computerId: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
  image: 'ghcr.io/openbots/computer:latest',
  agentToken: 'secret-agent-token',
  volumeName: 'openbots-home-11111111-1111-4111-8111-111111111111',
};

// Plan 18.5: "a test that the sandbox cannot reach Postgres or the Docker
// API". No daemon is available here, so the test is on the container spec and
// the compose file that define what the sandbox can reach.
describe('sandbox isolation (plan 9.5)', () => {
  const created = containerSpec(spec);
  const host = created.HostConfig!;

  it('sits on its own bridge network only, with nothing published on the host', () => {
    expect(host.NetworkMode).toBe(SANDBOX_NETWORK);
    expect(Object.keys(created.NetworkingConfig!.EndpointsConfig!)).toEqual([SANDBOX_NETWORK]);
    expect(host.PortBindings).toEqual({});
    expect(host.PublishAllPorts).toBe(false);
    expect(networkSpec()).toMatchObject({ Name: SANDBOX_NETWORK, Driver: 'bridge' });
  });

  it('drops every capability but those to switch users, forbids new privileges and is not privileged', () => {
    expect(host.CapDrop).toEqual(['ALL']);
    // The agent starts as root to lay out a user per screen, then drops (S-7).
    expect(host.CapAdd).toEqual(['CHOWN', 'SETUID', 'SETGID']);
    expect(host.SecurityOpt).toContain('no-new-privileges:true');
    expect(host.Privileged).toBe(false);
    expect(created.User).toBe('0:0');
  });

  it('limits processes, memory and CPU', () => {
    expect(host.PidsLimit).toBeGreaterThan(0);
    expect(host.Memory).toBe(4096 * 1024 * 1024);
    expect(host.MemorySwap).toBe(host.Memory);
    expect(host.NanoCpus).toBe(2e9);
    const custom = containerSpec({ ...spec, limits: { memoryMb: 512, pids: 64 } }).HostConfig!;
    expect(custom.Memory).toBe(512 * 1024 * 1024);
    expect(custom.PidsLimit).toBe(64);
  });

  it('has a read-only root with writable home and state volumes and tmp', () => {
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.Mounts).toEqual([
      { Type: 'volume', Source: spec.volumeName, Target: '/home/bot', ReadOnly: false },
      {
        Type: 'volume',
        Source: `openbots-state-${spec.computerId}`,
        Target: '/var/lib/openbots',
        ReadOnly: false,
      },
    ]);
    expect(Object.keys(host.Tmpfs!)).toEqual(expect.arrayContaining(['/tmp', '/var/tmp']));
  });

  it('gets no Docker socket and no host paths', () => {
    expect(host.Binds).toEqual([]);
    const text = JSON.stringify(created);
    expect(text).not.toContain('docker.sock');
    expect(host.Mounts!.every((m) => m.Type === 'volume')).toBe(true);
  });

  it('gets no provider keys or server secrets in its environment', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
    try {
      const env = containerSpec({ ...spec, egressProxy: 'http://proxy:3128' }).Env!;
      const names = env.map((e) => e.split('=')[0]);
      expect(names.every((n) => (SANDBOX_ENV_NAMES as readonly string[]).includes(n!))).toBe(true);
      expect(env.join('\n')).not.toMatch(/API_KEY|DATABASE_URL|REDIS_URL|MASTER_KEY|DOCKER_HOST/);
      expect(env).toContain('HTTPS_PROXY=http://proxy:3128');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    expect(created.Env!.some((e) => /^(HTTP|HTTPS|NO)_PROXY=/i.test(e))).toBe(false);
  });

  it('sends web traffic through the egress proxy in both spellings, the computer itself excepted (plan 9.5)', () => {
    const env = containerSpec({ ...spec, egressProxy: 'http://172.30.255.3:8888' }).Env!;
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
      expect(env).toContain(`${name}=http://172.30.255.3:8888`);
    }
    expect(env).toContain('NO_PROXY=localhost,127.0.0.1');
    expect(env).toContain('no_proxy=localhost,127.0.0.1');
    const custom = containerSpec({
      ...spec,
      egressProxy: 'http://172.30.255.3:8888',
      noProxy: 'localhost,.internal.example',
    }).Env!;
    expect(custom).toContain('NO_PROXY=localhost,.internal.example');
    // NO_PROXY means nothing without a proxy.
    expect(containerSpec({ ...spec, noProxy: 'x' }).Env!.join('\n')).not.toMatch(/proxy/i);
  });

  it('can set exactly the variables the docker guard allows', () => {
    const env = containerSpec({
      ...spec,
      egressProxy: 'http://172.30.255.3:8888',
      timezone: 'Europe/Paris',
    }).Env!;
    expect(env.map((e) => e.split('=')[0]).sort()).toEqual([...SANDBOX_ENV_NAMES].sort());
  });

  it("runs on the owner's timezone, UTC without one", () => {
    expect(containerSpec({ ...spec, timezone: 'Europe/Paris' }).Env).toContain('TZ=Europe/Paris');
    expect(created.Env).toContain('TZ=UTC');
  });

  it('keeps the agent token out of its environment (S-7)', () => {
    expect(SANDBOX_ENV_NAMES).not.toContain('OPENBOTS_AGENT_TOKEN');
    expect(JSON.stringify(created)).not.toContain(spec.agentToken);
  });

  it('shares no compose network with Postgres, Redis or the socket proxy', () => {
    const key = Object.entries(compose.networks).find(([, n]) => n.name === NETWORK_NAME)?.[0];
    expect(key).toBeDefined();
    // The server, and the `egress` profile's proxy (tested below).
    expect(servicesOn(key!)).toEqual(['openbots', 'egress-proxy']);
    // The server reaches the Docker API only through the guard; only the
    // guard reaches the socket proxy. Both networks are internal.
    expect(servicesOn('docker-api')).toEqual(['openbots', 'docker-guard']);
    expect(servicesOn('docker-raw')).toEqual(['docker-guard', 'docker-socket-proxy']);
    expect(compose.networks['docker-api']!.internal).toBe(true);
    expect(compose.networks['docker-raw']!.internal).toBe(true);
  });

  it('turns icc off on the sandbox network, as networkSpec does (S-17)', () => {
    const sandbox = compose.networks.sandbox!;
    expect(Object.keys(sandbox.driver_opts!).sort()).toEqual(
      Object.keys(networkSpec().Options!).sort(),
    );
    expect(sandbox.driver_opts![ICC_OPTION]).toBe('false');
    expect(sandbox.driver_opts![BRIDGE_NAME_OPTION]).toBe(BRIDGE_NAME);
  });

  it('names the network and its bridge from .env, with the defaults the code has', () => {
    // The network's own name, and the bridge named like it unless set apart.
    expect(NETWORK_NAME).toBe(`\${OPENBOTS_SANDBOX_NETWORK:-${SANDBOX_NETWORK}}`);
    expect(BRIDGE_NAME).toBe(`\${OPENBOTS_SANDBOX_BRIDGE:-${NETWORK_NAME}}`);
    expect(SANDBOX_BRIDGE).toBe(SANDBOX_NETWORK);
    // The server, the docker guard and the firewall get the same values.
    const env = (service: string) =>
      compose.services[service]!.environment as Record<string, string | undefined>;
    for (const service of ['openbots', 'docker-guard']) {
      expect(env(service).OPENBOTS_SANDBOX_NETWORK).toBe(NETWORK_NAME);
      expect(env(service).OPENBOTS_SANDBOX_BRIDGE).toBe(BRIDGE_NAME);
    }
    expect(env('sandbox-firewall').OPENBOTS_SANDBOX_BRIDGE).toBe(BRIDGE_NAME);
  });

  it('gives the server the fixed sandbox address the firewall lets through', () => {
    const script = readFileSync(
      new URL('../../../docker/sandbox-firewall.sh', import.meta.url),
      'utf8',
    );
    const openbots = compose.services.openbots!;
    const sandbox = (openbots.networks as Record<string, { ipv4_address?: string }>).sandbox!;
    // The same ${VAR:-default} in both, so the defaults agree.
    expect(sandbox.ipv4_address).toMatch(/^\$\{OPENBOTS_SANDBOX_SERVER_IP:-[\d.]+\}$/);
    expect(script).toContain(`SERVER="${sandbox.ipv4_address}"`);
    const subnet = compose.networks.sandbox!.ipam!.config[0]!.subnet;
    expect(subnet).toMatch(/^\$\{OPENBOTS_SANDBOX_SUBNET:-[\d./]+\}$/);
    expect(script).toContain(`SUBNET="${subnet}"`);
    expect(script).toContain(
      `BRIDGE="\${OPENBOTS_SANDBOX_BRIDGE:-\${OPENBOTS_SANDBOX_NETWORK:-${SANDBOX_BRIDGE}}}"\n`,
    );
    expect(script).toContain(`AGENT_PORT=${AGENT_PORT}\n`);
    const firewall = compose.services['sandbox-firewall']!;
    expect(firewall).toMatchObject({ network_mode: 'host', cap_add: ['NET_ADMIN', 'NET_RAW'] });
    expect(openbots.depends_on).toMatchObject({
      'docker-guard': { condition: 'service_healthy' },
      'sandbox-firewall': { condition: 'service_healthy' },
    });
  });
});

// The compose files, parsed: no Docker here to run `docker compose config`.
type ComposeFile = {
  services: Record<
    string,
    {
      image?: string;
      build?: unknown;
      networks?: string[] | Record<string, unknown>;
      network_mode?: string;
      depends_on?: unknown;
      profiles?: string[];
      environment?: unknown;
      volumes?: string[];
      [key: string]: unknown;
    }
  >;
  networks: Record<
    string,
    {
      name?: string;
      internal?: boolean;
      driver_opts?: Record<string, string>;
      ipam?: { config: { subnet: string }[] };
    }
  >;
};
const readCompose = (path: string) =>
  parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')) as ComposeFile;
const compose = readCompose('docker/docker-compose.yml');
const NETWORK_NAME = compose.networks.sandbox!.name;
const BRIDGE_NAME = compose.networks.sandbox!.driver_opts![BRIDGE_NAME_OPTION];

function servicesOn(network: string) {
  return Object.entries(compose.services)
    .filter(([, s]) => {
      if (s.network_mode) return false;
      const networks = s.networks ?? ['default'];
      return Array.isArray(networks) ? networks.includes(network) : network in networks;
    })
    .map(([name]) => name);
}

describe('compose files', () => {
  it.each([
    'compose.yaml',
    'docker/docker-compose.yml',
    'docker/docker-compose.dev.yml',
    'docker/docker-compose.tunnels.yml',
  ])('%s parses', (path) => {
    expect(readCompose(path)).toBeTypeOf('object');
  });

  it('pins the socket proxy by digest (S-20)', () => {
    expect(compose.services['docker-socket-proxy']!.image).toMatch(
      /^tecnativa\/docker-socket-proxy:[\w.-]+@sha256:[0-9a-f]{64}$/,
    );
  });

  it('runs the egress proxy only with its profile, on the sandbox network only, locked down (plan 9.5)', () => {
    const proxy = compose.services['egress-proxy']!;
    expect(proxy.profiles).toEqual(['egress']);
    // Pinned by version, not `latest`.
    expect(proxy.image).toMatch(/^kalaksi\/tinyproxy:\d+\.\d+$/);
    expect(proxy).toMatchObject({
      read_only: true,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
    });
    const networks = proxy.networks as Record<string, { ipv4_address?: string }>;
    expect(Object.keys(networks)).toEqual(['sandbox']);
    // Inside the sandbox subnet, and the address .env.example points the computers at.
    expect(networks.sandbox!.ipv4_address).toBe(
      '${OPENBOTS_SANDBOX_EGRESS_PROXY_IP:-172.30.255.3}',
    );
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    expect(example).toContain('OPENBOTS_SANDBOX_EGRESS_PROXY_IP=172.30.255.3\n');
    expect(example).toContain('http://172.30.255.3:8888');
    // Its config and allowlist come from the checkout, read-only.
    expect(proxy.volumes).toEqual([
      './docker/egress-proxy/tinyproxy.conf:/etc/tinyproxy/tinyproxy.conf:ro',
      '${OPENBOTS_SANDBOX_EGRESS_ALLOWLIST:-./docker/egress-proxy/allowlist}:/etc/tinyproxy/allowlist:ro',
    ]);
    const conf = readFileSync(
      new URL('../../../docker/egress-proxy/tinyproxy.conf', import.meta.url),
      'utf8',
    );
    expect(conf).toMatch(/^Port 8888$/m);
    expect(conf).toMatch(/^Filter "\/etc\/tinyproxy\/allowlist"$/m);
    expect(conf).toMatch(/^FilterDefaultDeny Yes$/m);
    // The firewall learns the proxy's address from the same variable as the server.
    const firewall = compose.services['sandbox-firewall']!.environment as Record<string, string>;
    expect(firewall.OPENBOTS_SANDBOX_EGRESS_PROXY).toBe('${OPENBOTS_SANDBOX_EGRESS_PROXY:-}');
    expect(firewall.OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY).toBe(
      '${OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY:-false}',
    );
  });

  it('runs the docker guard from the server image', () => {
    const guard = compose.services['docker-guard']!;
    expect(guard.image).toBe(compose.services.openbots!.image);
    expect(guard.build).toEqual(compose.services.openbots!.build);
  });
});

describe('docker provider', () => {
  let agent: FakeAgent;
  afterEach(() => agent?.close());

  it('creates on first use: pulls the image, makes the network, volume and container', async () => {
    agent = await startFakeAgent({ token: spec.agentToken });
    const docker = mockDocker();
    const provider = createDockerProvider({ docker, agentUrl: () => agent.url, pollMs: 5 });
    const ref = await provider.create(spec);
    expect(ref).toEqual({
      provider: 'docker',
      containerId: `c-${containerName(spec.computerId)}`,
      agentUrl: agent.url,
      agentToken: spec.agentToken,
      volumeName: spec.volumeName,
    });
    expect(docker.calls.map((c) => c.op)).toEqual([
      'pull',
      'createNetwork',
      'createVolume',
      'createVolume',
      'remove',
      'createContainer',
    ]);
    expect(docker.volumes).toEqual(new Set([spec.volumeName, stateVolumeName(spec.computerId)]));
    expect(await provider.status(ref)).toBe('stopped');

    await provider.start(ref);
    expect(await provider.status(ref)).toBe('running');
    await provider.start(ref); // already running: 304 is fine
    await provider.stop(ref);
    expect(await provider.status(ref)).toBe('stopped');

    // Created again (an upgrade): the image, network and volume are reused.
    docker.calls.length = 0;
    await provider.create(spec);
    expect(docker.calls.map((c) => c.op)).toEqual(['remove', 'createContainer']);

    await provider.destroy(ref);
    expect(docker.calls.at(-1)).toEqual({
      op: 'remove',
      args: [ref.containerId, { force: true, v: false }],
    });
    expect(docker.volumes.has(spec.volumeName)).toBe(true);
    expect(await provider.status(ref)).toBe('missing');
  });

  it('pulls a moved tag again and tells a machine made from the older build (plan 16.3)', async () => {
    const docker = mockDocker();
    const provider = createDockerProvider({ docker, pollMs: 5 });
    // Never pulled: nothing to refresh, the first computer pulls it.
    await provider.refreshImage!(spec.image);
    expect(docker.calls.filter((c) => c.op === 'pull')).toEqual([]);

    const ref = await provider.create(spec);
    expect(await provider.runsImage!(ref, spec.image)).toBe(true);
    // An upgrade moved the tag: the pull brings the new build.
    docker.imageIds.set(spec.image, 'sha256:newer');
    await provider.refreshImage!(spec.image);
    expect(docker.calls.filter((c) => c.op === 'pull')).toHaveLength(2);
    expect(await provider.runsImage!(ref, spec.image)).toBe(false);
    // Made again, it runs the new build.
    const again = await provider.create(spec);
    expect(await provider.runsImage!(again, spec.image)).toBe(true);
    // An image no longer present is no reason to make it again.
    docker.images.delete(spec.image);
    expect(await provider.runsImage!(again, spec.image)).toBe(true);
  });

  it('keeps an image built on this host that no registry has', async () => {
    const docker = mockDocker();
    const provider = createDockerProvider({ docker, pollMs: 5 });
    docker.images.add(spec.image);
    docker.pull = async () => {
      throw Object.assign(new Error('pull access denied'), { statusCode: 404 });
    };
    await expect(provider.refreshImage!(spec.image)).resolves.toBeUndefined();
    expect(docker.images.has(spec.image)).toBe(true);
    // Any other failure still reaches the caller, which logs it.
    docker.pull = async () => {
      throw Object.assign(new Error('registry down'), { statusCode: 500 });
    };
    await expect(provider.refreshImage!(spec.image)).rejects.toThrow('registry down');
  });

  it('passes the token as a file in the state volume before each start, not to a running agent (S-7)', async () => {
    agent = await startFakeAgent({ token: spec.agentToken });
    const docker = mockDocker();
    const provider = createDockerProvider({ docker, agentUrl: () => agent.url, pollMs: 5 });
    const ref = await provider.create(spec);
    docker.calls.length = 0;
    await provider.start(ref);
    expect(docker.calls.map((c) => c.op)).toEqual(['putArchive', 'start']);
    expect(docker.calls[0]!.args).toEqual([ref.containerId, { path: STATE_DIR }]);
    const archive = docker.containers.get(ref.containerId!)!.archives!.get(STATE_DIR)!;
    expect(readTokenArchive(archive)).toBe(spec.agentToken);

    docker.calls.length = 0;
    await provider.start(ref);
    expect(docker.calls.map((c) => c.op)).toEqual(['start']);
    await provider.stop(ref);
    docker.calls.length = 0;
    await provider.start(ref);
    expect(docker.calls.map((c) => c.op)).toEqual(['putArchive', 'start']);
  });

  it('start waits for the control agent and fails when it never answers', async () => {
    agent = await startFakeAgent({ token: spec.agentToken });
    agent.healthy = false;
    const docker = mockDocker();
    const provider = createDockerProvider({
      docker,
      agentUrl: () => agent.url,
      readyTimeoutMs: 50,
      pollMs: 5,
    });
    const ref = await provider.create(spec);
    await expect(provider.start(ref)).rejects.toThrow(/did not answer/);
  });

  it('reaches agents by container name on the sandbox network by default', async () => {
    const provider = createDockerProvider({ docker: mockDocker() });
    const ref = await provider.create(spec);
    expect(ref.agentUrl).toBe(`http://${containerName(spec.computerId)}:${AGENT_PORT}`);
  });

  it('creates computers on the configured network, with its own bridge', async () => {
    const docker = mockDocker();
    const network = { name: 'openbots-app-sandbox-254', bridge: 'openbots-a-254' };
    const provider = createDockerProvider({ docker, network });
    await provider.create(spec);
    const made = docker.calls.find((c) => c.op === 'createNetwork')!.args[0] as Record<
      string,
      unknown
    >;
    expect(made).toMatchObject({
      Name: network.name,
      Options: { [ICC_OPTION]: 'false', [BRIDGE_NAME_OPTION]: network.bridge },
    });
    const created = docker.calls.find((c) => c.op === 'createContainer')!.args[0] as ReturnType<
      typeof containerSpec
    >;
    expect(created.HostConfig!.NetworkMode).toBe(network.name);
    expect(Object.keys(created.NetworkingConfig!.EndpointsConfig!)).toEqual([network.name]);
    expect(docker.networks).toEqual(new Set([network.name]));
  });

  it('reads DOCKER_HOST forms', () => {
    const tcp = dockerFromHost('tcp://docker-socket-proxy:2375') as unknown as {
      modem: { host: string; port: number; protocol: string };
    };
    expect(tcp.modem).toMatchObject({ host: 'docker-socket-proxy', port: 2375, protocol: 'http' });
    const unix = dockerFromHost('unix:///var/run/docker.sock') as unknown as {
      modem: { socketPath: string };
    };
    expect(unix.modem.socketPath).toBe('/var/run/docker.sock');
  });
});

describe('sandbox network settings', () => {
  it('defaults to openbots-sbx, bridge and all', () => {
    expect(resolveSandboxNetwork()).toEqual(DEFAULT_SANDBOX_NETWORK);
    expect(resolveSandboxNetwork('', ' ')).toEqual({
      name: 'openbots-sbx',
      bridge: 'openbots-sbx',
    });
  });

  it('names the bridge like the network unless told otherwise', () => {
    expect(resolveSandboxNetwork('openbots-dev')).toEqual({
      name: 'openbots-dev',
      bridge: 'openbots-dev',
    });
    expect(resolveSandboxNetwork('openbots-app-sandbox-254', 'openbots-a-254')).toEqual({
      name: 'openbots-app-sandbox-254',
      bridge: 'openbots-a-254',
    });
  });

  it('asks for OPENBOTS_SANDBOX_BRIDGE when the network name is too long for a bridge', () => {
    expect(() => resolveSandboxNetwork('openbots-app-sandbox')).toThrow(
      /OPENBOTS_SANDBOX_BRIDGE: needed/,
    );
  });

  it.each([
    ['a name longer than 15 characters', 'openbots-sandbox-x'],
    ['upper case', 'OpenBots'],
    ["iptables' wildcard", 'openbots+'],
    ['a leading dash', '-openbots'],
    ['a slash', 'a/b'],
  ])('refuses a bridge with %s', (_, bridge) => {
    expect(isBridgeName(bridge)).toBe(false);
    expect(() => resolveSandboxNetwork('openbots-sbx', bridge)).toThrow(/OPENBOTS_SANDBOX_BRIDGE/);
  });

  it('refuses a network name Docker would not take', () => {
    expect(() => resolveSandboxNetwork('open bot')).toThrow(/OPENBOTS_SANDBOX_NETWORK/);
    expect(() => resolveSandboxNetwork('x'.repeat(65), 'x')).toThrow(/OPENBOTS_SANDBOX_NETWORK/);
  });
});
