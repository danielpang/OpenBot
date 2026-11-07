import Docker from 'dockerode';
import { createAgentClient } from './agent-client.js';
import { tokenArchive } from './token-archive.js';
import {
  COMPUTER_HOME,
  DEFAULT_LIMITS,
  DEFAULT_NO_PROXY,
  STATE_DIR,
  type ComputerProvider,
  type ComputerRef,
  type ComputerSpec,
  type MachineStatus,
} from './types.js';

// The docker provider (plan 9.2, 9.5): one container per account on the
// sandbox bridge network (`openbots-sbx` unless OPENBOTS_SANDBOX_NETWORK
// names another), reached by the server through the Docker
// API behind the docker guard and the socket proxy
// (`DOCKER_HOST=tcp://docker-guard:2375`). The provider refuses a Docker API
// that is not the guard (`docker-guard.ts`), so a misconfigured DOCKER_HOST
// cannot hand it an unfiltered daemon.
// The container is created on first use with every isolation setting in
// `containerSpec`, stopped after the idle timeout, and its home volume is
// kept across stops, upgrades and re-creation (K7), as is its state volume,
// which holds each screen's Chromium profile. The agent token is not in its
// environment (S-7): before each start the provider puts it as a root-only
// file into the state volume, and the agent deletes it once read.

/**
 * The network compose creates for computers by default; it holds no Postgres,
 * Redis or socket proxy. OPENBOTS_SANDBOX_NETWORK names another, so two stacks
 * on one Docker host each keep their own. Short ("sbx" for sandbox) because the
 * bridge takes the same name, and a bridge name has at most 15 characters.
 */
export const SANDBOX_NETWORK = 'openbots-sbx';
/**
 * Its bridge interface on the host by default, named so
 * docker/sandbox-firewall.sh can match it. OPENBOTS_SANDBOX_BRIDGE names
 * another; without it the bridge is named like the network.
 */
export const SANDBOX_BRIDGE = 'openbots-sbx';
/** Linux limits an interface name to 15 characters (IFNAMSIZ less the NUL). */
export const MAX_BRIDGE_NAME = 15;

/** The sandbox network and its bridge, as compose, the guard, the firewall and the provider share them. */
export interface SandboxNetwork {
  name: string;
  bridge: string;
}

export const DEFAULT_SANDBOX_NETWORK: SandboxNetwork = {
  name: SANDBOX_NETWORK,
  bridge: SANDBOX_BRIDGE,
};

/** A Docker network name, at most 64 characters. */
export function isNetworkName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name);
}

/**
 * A bridge name docker/sandbox-firewall.sh accepts: lower case, at most 15
 * characters, nothing iptables reads as a wildcard (`+`). The same rule is in
 * the script.
 */
export function isBridgeName(name: string): boolean {
  return new RegExp(`^[a-z0-9][a-z0-9_.-]{0,${MAX_BRIDGE_NAME - 1}}$`).test(name);
}

/**
 * The sandbox network from OPENBOTS_SANDBOX_NETWORK and OPENBOTS_SANDBOX_BRIDGE
 * (empty counts as unset). The bridge defaults to the network's name, as in
 * docker/docker-compose.yml, so a name longer than a bridge allows needs
 * OPENBOTS_SANDBOX_BRIDGE too. Throws with the variable to fix.
 */
export function resolveSandboxNetwork(name?: string, bridge?: string): SandboxNetwork {
  const network = name?.trim() || SANDBOX_NETWORK;
  if (!isNetworkName(network)) {
    throw new Error(
      'OPENBOTS_SANDBOX_NETWORK: must be a Docker network name (letters, digits, _ . -, up to 64)',
    );
  }
  const explicit = bridge?.trim();
  const resolved = explicit || network;
  if (!isBridgeName(resolved)) {
    throw new Error(
      explicit
        ? `OPENBOTS_SANDBOX_BRIDGE: must be lower case letters, digits, _ . -, up to ${MAX_BRIDGE_NAME} characters`
        : `OPENBOTS_SANDBOX_BRIDGE: needed because OPENBOTS_SANDBOX_NETWORK is not a bridge name (lower case, up to ${MAX_BRIDGE_NAME} characters)`,
    );
  }
  return { name: network, bridge: resolved };
}
/** The bridge option that stops containers on the sandbox network reaching each other. */
export const ICC_OPTION = 'com.docker.network.bridge.enable_icc';
export const BRIDGE_NAME_OPTION = 'com.docker.network.bridge.name';
/** Answered by the docker guard itself; the provider refuses a Docker API without it. */
export const GUARD_PATH = '/_openbots/guard';
export const GUARD_NAME = 'openbots-docker-guard';
/** The control agent's port inside the container; never published on the host. */
export const AGENT_PORT = 7070;

/**
 * The computer image the release workflow publishes
 * (.github/workflows/release.yml); compose derives its own from
 * OPENBOTS_IMAGE_PREFIX and OPENBOTS_VERSION instead.
 */
export const DEFAULT_SANDBOX_IMAGE = 'ghcr.io/danielpang/openbots/computer:latest';
/**
 * The only environment the sandbox gets: no provider keys, no database or
 * master key (plan 9.5), and not the agent token, which goes in a file (S-7).
 */
export const SANDBOX_ENV_NAMES = [
  'OPENBOTS_AGENT_PORT',
  'HOME',
  'TZ',
  // The egress proxy in both spellings: curl and wget read only the lower
  // case `http_proxy`, some other programs only the upper case.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;
/**
 * Root, so the agent can lay out a user per screen; it drops to the image's
 * bot user before it listens and keeps only what openbots-runas needs
 * (apps/computer-agent/src/privileges.ts).
 */
export const SANDBOX_USER = '0:0';
/** All the root the container keeps: chown for the screens' directories, and switching users. */
export const SANDBOX_CAPS = ['CHOWN', 'SETUID', 'SETGID'] as const;

/** Marks the containers, volumes and network the provider made; the guard acts on no others. */
export const MANAGED_LABEL = 'openbots.computer';

/** The part of dockerode the provider uses, so tests can stand in for the daemon. */
export interface DockerApi {
  getImage(name: string): { inspect(): Promise<{ Id?: string }> };
  pull(image: string): Promise<NodeJS.ReadableStream>;
  modem: {
    followProgress(stream: NodeJS.ReadableStream, done: (err: Error | null) => void): void;
    dial(
      options: { path: string; method: string; statusCodes: Record<number, boolean | string> },
      done: (err: Error | null, data?: unknown) => void,
    ): void;
  };
  getNetwork(name: string): { inspect(): Promise<unknown> };
  createNetwork(options: Docker.NetworkCreateOptions): Promise<unknown>;
  getVolume(name: string): { inspect(): Promise<unknown>; remove(): Promise<unknown> };
  createVolume(options: Docker.VolumeCreateOptions): Promise<unknown>;
  createContainer(options: Docker.ContainerCreateOptions): Promise<{ id: string }>;
  getContainer(id: string): {
    start(): Promise<unknown>;
    putArchive(file: Buffer, options: { path: string }): Promise<unknown>;
    stop(options?: { t?: number }): Promise<unknown>;
    remove(options?: { force?: boolean; v?: boolean }): Promise<unknown>;
    inspect(): Promise<{ State?: { Running?: boolean }; Image?: string }>;
  };
}

export interface DockerProviderOptions {
  /** `DOCKER_HOST`: `tcp://host:port`, `http(s)://...` or `unix:///path`. */
  dockerHost?: string;
  /** Injected for tests; otherwise built from `dockerHost`. */
  docker?: DockerApi;
  /** The sandbox network computers are created on, and its bridge; the default one without. */
  network?: SandboxNetwork;
  /** How the server reaches a container's agent; by container name on the sandbox network. */
  agentUrl?(containerName: string): string;
  /** How long `start` waits for the agent's /health. */
  readyTimeoutMs?: number;
  pollMs?: number;
}

export function containerName(computerId: string) {
  return `openbots-computer-${computerId}`;
}

export function volumeName(computerId: string) {
  return `openbots-home-${computerId}`;
}

export function stateVolumeName(computerId: string) {
  return `openbots-state-${computerId}`;
}

/**
 * The container's create options with every isolation setting from plan
 * 9.5. Pure, so a test can assert each one without a daemon.
 */
export function containerSpec(
  spec: ComputerSpec,
  { network = SANDBOX_NETWORK }: { network?: string } = {},
): Docker.ContainerCreateOptions {
  const limits = { ...DEFAULT_LIMITS, ...spec.limits };
  const name = containerName(spec.computerId);
  const env: Record<(typeof SANDBOX_ENV_NAMES)[number], string | undefined> = {
    OPENBOTS_AGENT_PORT: String(AGENT_PORT),
    HOME: COMPUTER_HOME,
    TZ: spec.timezone ?? 'UTC',
    ...proxyEnv(spec),
  };
  const mb = (n: number) => n * 1024 * 1024;
  return {
    name,
    Image: spec.image,
    Hostname: 'computer',
    User: SANDBOX_USER,
    WorkingDir: COMPUTER_HOME,
    Env: Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`),
    Labels: { [MANAGED_LABEL]: spec.computerId, 'openbots.owner': spec.ownerId },
    ExposedPorts: { [`${AGENT_PORT}/tcp`]: {} },
    HostConfig: {
      // Its own bridge network, which compose keeps free of Postgres, Redis
      // and the Docker API; nothing is published on the host.
      NetworkMode: network,
      PortBindings: {},
      PublishAllPorts: false,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: [...SANDBOX_CAPS],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      // Writable: the persistent home and the agent's state (named volumes,
      // never a host path) and scratch tmpfs mounts. No Docker socket, no
      // other binds.
      Binds: [],
      Mounts: [
        { Type: 'volume', Source: spec.volumeName, Target: COMPUTER_HOME, ReadOnly: false },
        {
          Type: 'volume',
          Source: stateVolumeName(spec.computerId),
          Target: STATE_DIR,
          ReadOnly: false,
        },
      ],
      Tmpfs: {
        '/tmp': `rw,nosuid,nodev,size=${limits.tmpMb}m`,
        '/var/tmp': 'rw,nosuid,nodev,size=64m',
        '/run': 'rw,nosuid,nodev,size=16m',
      },
      ShmSize: mb(limits.shmMb),
      Memory: mb(limits.memoryMb),
      MemorySwap: mb(limits.memoryMb),
      NanoCpus: Math.round(limits.cpus * 1e9),
      PidsLimit: limits.pids,
      IpcMode: 'private',
      // No `Init`: the image's entrypoint is tini.
      RestartPolicy: { Name: 'no' },
    },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [name] } } },
  };
}

/** The egress proxy variables, all unset without a proxy. */
function proxyEnv({ egressProxy, noProxy }: ComputerSpec) {
  const skip = egressProxy ? (noProxy ?? DEFAULT_NO_PROXY) : undefined;
  return {
    HTTP_PROXY: egressProxy,
    HTTPS_PROXY: egressProxy,
    NO_PROXY: skip,
    http_proxy: egressProxy,
    https_proxy: egressProxy,
    no_proxy: skip,
  };
}

/** The sandbox network, if the provider has to create it (compose normally does). */
export function networkSpec(
  network: SandboxNetwork = DEFAULT_SANDBOX_NETWORK,
): Docker.NetworkCreateOptions {
  return {
    Name: network.name,
    Driver: 'bridge',
    // Not `internal`: the browser needs the internet. Postgres and Redis are
    // simply not on it. Containers on it cannot reach each other (icc off);
    // the server's route to the agents and the egress rules are in
    // docker/sandbox-firewall.sh. Keep in step with docker/docker-compose.yml.
    Internal: false,
    Attachable: false,
    Labels: { [MANAGED_LABEL]: 'network' },
    Options: { [ICC_OPTION]: 'false', [BRIDGE_NAME_OPTION]: network.bridge },
  };
}

export function dockerFromHost(dockerHost?: string): Docker {
  if (!dockerHost) return new Docker();
  if (dockerHost.startsWith('unix://')) return new Docker({ socketPath: dockerHost.slice(7) });
  const url = new URL(dockerHost.replace(/^tcp:/, 'http:'));
  return new Docker({
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 2376 : 2375)),
  });
}

export function createDockerProvider(options: DockerProviderOptions = {}): ComputerProvider {
  const docker = options.docker ?? (dockerFromHost(options.dockerHost) as unknown as DockerApi);
  const network = options.network ?? DEFAULT_SANDBOX_NETWORK;
  const agentUrl = options.agentUrl ?? ((name: string) => `http://${name}:${AGENT_PORT}`);
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 500;

  const exists = async (inspect: () => Promise<unknown>) => {
    try {
      await inspect();
      return true;
    } catch (error) {
      if (statusOf(error) === 404) return false;
      throw error;
    }
  };

  async function pull(image: string) {
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) =>
      docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())),
    );
  }

  async function ensureImage(image: string) {
    if (await exists(() => docker.getImage(image).inspect())) return;
    await pull(image);
  }

  /** The local image's id, or null when it was never pulled. */
  async function imageId(image: string) {
    try {
      return (await docker.getImage(image).inspect()).Id ?? null;
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw error;
    }
  }

  // Checked once per provider; a failure is retried on the next call.
  let guarded: Promise<void> | undefined;
  const guard = () => {
    guarded ??= verifyGuard(docker).catch((error: unknown) => {
      guarded = undefined;
      throw error;
    });
    return guarded;
  };

  const provider: ComputerProvider = {
    name: 'docker',
    async prepareImage(image) {
      await guard();
      await ensureImage(image);
    },
    async refreshImage(image) {
      await guard();
      // Never pulled: the first computer pulls it when it is made.
      if (!(await imageId(image))) return;
      try {
        await pull(image);
      } catch (error) {
        // No registry has it: a build made on this host (a development
        // image), which stays as it is.
        if (statusOf(error) !== 404) throw error;
      }
    },
    async runsImage(ref, image) {
      await guard();
      const [running, local] = await Promise.all([
        docker
          .getContainer(containerId(ref))
          .inspect()
          .then((info) => info.Image ?? null),
        imageId(image),
      ]);
      // Without both ids there is nothing to compare; making it again could
      // need a pull, which an offline host cannot do.
      return !running || !local || running === local;
    },
    async create(spec) {
      await guard();
      await ensureImage(spec.image);
      if (!(await exists(() => docker.getNetwork(network.name).inspect()))) {
        await docker.createNetwork(networkSpec(network));
      }
      for (const volume of [spec.volumeName, stateVolumeName(spec.computerId)]) {
        if (!(await exists(() => docker.getVolume(volume).inspect()))) {
          await docker.createVolume({ Name: volume, Labels: { [MANAGED_LABEL]: spec.computerId } });
        }
      }
      const name = containerName(spec.computerId);
      // A container left from an earlier row (same id) is replaced; the volume stays.
      await ignoreMissing(() => docker.getContainer(name).remove({ force: true }));
      const container = await docker.createContainer(
        containerSpec(spec, { network: network.name }),
      );
      return {
        provider: 'docker',
        containerId: container.id,
        agentUrl: agentUrl(name),
        agentToken: spec.agentToken,
        volumeName: spec.volumeName,
      };
    },
    async start(ref) {
      await guard();
      const container = docker.getContainer(containerId(ref));
      // A running agent read its token when it started.
      if (!(await container.inspect()).State?.Running) {
        await container.putArchive(tokenArchive(ref.agentToken), { path: STATE_DIR });
      }
      try {
        await container.start();
      } catch (error) {
        // 304: already running.
        if (statusOf(error) !== 304) throw error;
      }
      await waitForAgent(provider.agent(ref), readyTimeoutMs, pollMs);
    },
    async stop(ref) {
      await guard();
      await ignoreMissing(async () => {
        try {
          await docker.getContainer(containerId(ref)).stop({ t: 10 });
        } catch (error) {
          if (statusOf(error) !== 304) throw error;
        }
      });
    },
    async destroy(ref, options) {
      // `v: false` keeps named volumes: the home outlives the container (K7).
      await guard();
      await ignoreMissing(() =>
        docker.getContainer(containerId(ref)).remove({ force: true, v: false }),
      );
      // A reset (GH5): the home goes, and the state volume only when asked.
      if (!options?.home) return;
      const volumes = [ref.volumeName ?? volumeName(options.computerId)];
      if (options.state) volumes.push(stateVolumeName(options.computerId));
      for (const volume of volumes) {
        await ignoreMissing(() => docker.getVolume(volume).remove());
      }
    },
    async status(ref): Promise<MachineStatus> {
      await guard();
      try {
        const info = await docker.getContainer(containerId(ref)).inspect();
        return info.State?.Running ? 'running' : 'stopped';
      } catch (error) {
        if (statusOf(error) === 404) return 'missing';
        throw error;
      }
    },
    agent: (ref) => createAgentClient({ url: ref.agentUrl, token: ref.agentToken }),
  };
  return provider;
}

/** Fails unless the Docker API answers as the docker guard. */
export async function verifyGuard(docker: Pick<DockerApi, 'modem'>) {
  const data = await new Promise<unknown>((resolve, reject) =>
    docker.modem.dial(
      { path: GUARD_PATH, method: 'GET', statusCodes: { 200: true } },
      (err, answer) => (err ? reject(err) : resolve(answer)),
    ),
  ).catch(() => undefined);
  if ((data as { guard?: unknown } | undefined)?.guard !== GUARD_NAME) {
    throw new Error(
      'DOCKER_HOST is not the OpenBots docker guard, so the computer will not use it: ' +
        'point DOCKER_HOST at the docker-guard service (tcp://docker-guard:2375), ' +
        'never at the Docker socket or the socket proxy directly',
    );
  }
}

function containerId(ref: ComputerRef) {
  if (!ref.containerId) throw new Error('The computer has no container');
  return ref.containerId;
}

export async function waitForAgent(
  agent: { health(signal?: AbortSignal): Promise<{ ok: boolean }> },
  timeoutMs: number,
  pollMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      if ((await agent.health()).ok) return;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline) {
      const why = last instanceof Error ? `: ${last.message}` : '';
      throw new Error(`The computer's control agent did not answer within ${timeoutMs}ms${why}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function statusOf(error: unknown) {
  return (error as { statusCode?: number } | null)?.statusCode;
}

async function ignoreMissing(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
  }
}
